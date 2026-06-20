// app/src/db/phi-crypto.ts — app-level field encryption for PHI (AES-256-GCM).
//
// The brief names member names, diagnosis codes, and provider details as sensitive health data.
// These four columns (members.name/dob, claims.provider/diagnosis_code) are encrypted BEFORE they
// hit SQLite and decrypted only at the repository read seam — the rest of the app, and the
// adjudication engine, never see ciphertext OR need to know encryption exists.
//
// Scheme: AES-256-GCM with a random 96-bit IV per value (so equal plaintexts differ on disk) and a
// 128-bit auth tag (so tampering is detected on decrypt). Token format, all base64:
//   g1:<iv>:<tag>:<ciphertext>
// The "g1" prefix versions the scheme for future key rotation / algorithm changes.
//
// Key: 32 bytes from PHI_ENCRYPTION_KEY (64 hex chars), loaded from .env. A clearly-labelled DEV
// key is used only when the env var is absent, so the demo and tests run with zero setup.
// Production MUST set PHI_ENCRYPTION_KEY; never protect real PHI with the DEV default.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import "../config/env"; // side effect: load .env before we read PHI_ENCRYPTION_KEY

const SCHEME = "g1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32; // AES-256

// DEV ONLY — also published in .env.example so a fresh clone runs. NOT for real PHI.
const DEV_FALLBACK_KEY_HEX =
  "ece4fafcc928af5f856d74559061f93812abe77848a77fcd099627b8175e5e77";

function resolveKey(): Buffer {
  const hex = process.env.PHI_ENCRYPTION_KEY ?? DEV_FALLBACK_KEY_HEX;
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `PHI_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars)`,
    );
  }
  return key;
}

/** Encrypt a PHI value into a self-describing `g1:iv:tag:ciphertext` token. */
export function encryptPhi(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, resolveKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    SCHEME,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Decrypt a token produced by {@link encryptPhi}. Throws if malformed or tampered. */
export function decryptPhi(token: string): string {
  const [scheme, ivB64, tagB64, ctB64] = token.split(":");
  if (
    scheme !== SCHEME ||
    ivB64 === undefined ||
    tagB64 === undefined ||
    ctB64 === undefined
  ) {
    throw new Error("PHI token is malformed or uses an unknown scheme");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    resolveKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(), // throws on auth-tag mismatch (tampering / wrong key)
  ]);
  return plaintext.toString("utf8");
}

/** Encrypt an optional PHI value, preserving null/undefined (absent stays absent). */
export function encryptPhiNullable(
  value: string | null | undefined,
): string | null {
  return value == null ? null : encryptPhi(value);
}

/** Decrypt an optional PHI token, preserving null. */
export function decryptPhiNullable(
  token: string | null | undefined,
): string | null {
  return token == null ? null : decryptPhi(token);
}
