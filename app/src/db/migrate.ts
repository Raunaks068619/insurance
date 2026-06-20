// app/src/db/migrate.ts — apply the canonical schema to a connection.
//
// schema.sql is generated verbatim from the DDL in docs/erd-physical.md (the design source of
// truth). applySchema creates every table, index, and trigger in one exec. The DDL has no
// `IF NOT EXISTS`, so it is applied once on a fresh database (each test's :memory: handle).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawDb } from "./connection";

const SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL("./schema.sql", import.meta.url)),
  "utf8",
);

export function applySchema(sqlite: RawDb): void {
  sqlite.exec(SCHEMA_SQL);
}
