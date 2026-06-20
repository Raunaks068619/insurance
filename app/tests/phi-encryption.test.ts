// app/tests/phi-encryption.test.ts — PHI is encrypted at rest and reversibly decrypted.
//
// The brief calls member names, diagnosis codes, and provider details "sensitive health data".
// We claim app-level field encryption (AES-256-GCM) on the 4 PHI columns; these tests make that
// claim TRUE and PROVABLE: ciphertext on disk, original on read, tamper rejected.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { decryptPhi, encryptPhi } from "../src/db/phi-crypto";
import { claims, members } from "../src/db/schema";
import { createClaimRepository } from "../src/repositories/claim.repository";
import { createMemberRepository } from "../src/repositories/member.repository";
import { freshDb, seedWorld } from "./db-helpers";

describe("phi-crypto (unit)", () => {
  it("round-trips a value: decrypt(encrypt(x)) === x", () => {
    const plaintext = "Jane Doe";

    const token = encryptPhi(plaintext);

    expect(decryptPhi(token)).toBe(plaintext);
  });

  it("produces ciphertext that is not the plaintext", () => {
    const plaintext = "E11.9"; // a diagnosis code

    const token = encryptPhi(plaintext);

    expect(token).not.toBe(plaintext);
    expect(token).not.toContain(plaintext);
  });

  it("is non-deterministic: same input yields different ciphertext (random IV)", () => {
    const a = encryptPhi("1990-05-01");
    const b = encryptPhi("1990-05-01");

    expect(a).not.toBe(b);
    expect(decryptPhi(a)).toBe(decryptPhi(b));
  });

  it("rejects a tampered token (auth tag mismatch)", () => {
    const token = encryptPhi("Acme Hospital");
    const tampered = `${token.slice(0, -2)}xx`;

    expect(() => decryptPhi(tampered)).toThrow();
  });

  it("rejects a token that is not in the expected scheme", () => {
    expect(() => decryptPhi("not-a-real-token")).toThrow();
  });
});

describe("PHI at rest (integration)", () => {
  it("stores claim provider/diagnosis as ciphertext and decrypts them back", () => {
    const handle = freshDb();
    const { memberId, policyId } = seedWorld(handle.db, {
      rules: [{ serviceCode: "PCP_VISIT" }],
    });
    const repo = createClaimRepository(handle.db);

    const claimId = repo.insertClaim({
      memberId,
      policyId,
      serviceDate: "2026-03-01",
      provider: "Acme Hospital",
      diagnosisCode: "E11.9",
    });

    // Raw column bytes must NOT be the plaintext.
    const raw = handle.db
      .select({
        provider: claims.provider,
        diagnosisCode: claims.diagnosisCode,
      })
      .from(claims)
      .where(eq(claims.id, claimId))
      .get();
    expect(raw?.provider).not.toBe("Acme Hospital");
    expect(raw?.diagnosisCode).not.toBe("E11.9");

    // The decrypt accessor restores the originals.
    const phi = repo.findClaimPhi(claimId);
    expect(phi).toEqual({ provider: "Acme Hospital", diagnosisCode: "E11.9" });
  });

  it("leaves null claim PHI as null (no ciphertext for absent values)", () => {
    const handle = freshDb();
    const { memberId, policyId } = seedWorld(handle.db, {
      rules: [{ serviceCode: "PCP_VISIT" }],
    });
    const repo = createClaimRepository(handle.db);

    const claimId = repo.insertClaim({
      memberId,
      policyId,
      serviceDate: "2026-03-01",
    });

    expect(repo.findClaimPhi(claimId)).toEqual({
      provider: null,
      diagnosisCode: null,
    });
  });

  it("stores member name/dob as ciphertext and decrypts them back", () => {
    const handle = freshDb();
    const { memberId } = seedWorld(handle.db, {
      rules: [{ serviceCode: "PCP_VISIT" }],
    });
    const repo = createMemberRepository(handle.db);

    const raw = handle.db
      .select({ name: members.name, dob: members.dob })
      .from(members)
      .where(eq(members.id, memberId))
      .get();
    expect(raw?.name).not.toBe("Jane Doe");
    expect(raw?.dob).not.toBe("1990-05-01");

    const member = repo.findMemberById(memberId);
    expect(member).toEqual({
      id: memberId,
      name: "Jane Doe",
      dob: "1990-05-01",
    });
  });
});
