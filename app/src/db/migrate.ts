// app/src/db/migrate.ts — apply the canonical schema to a connection.
//
// schema.sql is generated verbatim from the DDL in docs/erd-physical.md (the design source of
// truth). applySchema creates every table, index, and trigger in one exec. The DDL has no
// `IF NOT EXISTS`, so re-running the raw exec on an already-migrated DB would throw. applySchema
// therefore guards on a sentinel table: a fresh DB (every test's :memory: handle) runs the full
// exec; a persisted file DB that already holds the schema is a no-op, so re-boots don't crash.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawDb } from "./connection";

const SCHEMA_SQL = readFileSync(
  fileURLToPath(new URL("./schema.sql", import.meta.url)),
  "utf8",
);

export function applySchema(sqlite: RawDb): void {
  const alreadyApplied = sqlite
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claims'",
    )
    .get();
  if (alreadyApplied) return;
  sqlite.exec(SCHEMA_SQL);
}
