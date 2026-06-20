// app/src/config/env.ts — load .env into process.env (Node 22 built-in, no dependency).
//
// Imported for its side effect by anything that reads secrets/config (phi-crypto, index, seed).
// Guarded so tests and a fresh clone without a .env still run — the encryption key then falls
// back to the documented DEV key in phi-crypto.ts. Production MUST set PHI_ENCRYPTION_KEY.

import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}
