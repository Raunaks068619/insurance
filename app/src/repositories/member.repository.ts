// app/src/repositories/member.repository.ts — member persistence; the PHI write/read seam.
//
// members.name + members.dob are PHI. This repo is the single choke point where they are encrypted
// on the way into SQLite and decrypted on the way out (see db/phi-crypto.ts). Callers (seed, tests)
// deal only in plaintext; ciphertext never leaks past this boundary.

import { eq } from "drizzle-orm";
import type { Db } from "../db/connection";
import { decryptPhi, encryptPhi } from "../db/phi-crypto";
import { members } from "../db/schema";

export type NewMember = { id: string; name: string; dob: string };
export type MemberRecord = { id: string; name: string; dob: string };

export function createMemberRepository(db: Db) {
  return {
    db,

    // Insert a member with name/dob encrypted at rest.
    insertMember(m: NewMember): void {
      db.insert(members)
        .values({ id: m.id, name: encryptPhi(m.name), dob: encryptPhi(m.dob) })
        .run();
    },

    // Read a member with name/dob decrypted back to plaintext.
    findMemberById(id: string): MemberRecord | undefined {
      const row = db.select().from(members).where(eq(members.id, id)).get();
      if (!row) return undefined;
      return {
        id: row.id,
        name: decryptPhi(row.name),
        dob: decryptPhi(row.dob),
      };
    },
  };
}

export type MemberRepository = ReturnType<typeof createMemberRepository>;
