// app/src/db/connection.ts — better-sqlite3 + drizzle() factory (synchronous single-writer).
//
// createDb(':memory:') is the test seam: each DB test opens a fresh, isolated in-memory database,
// applies the schema, runs, and discards it — no shared state between tests. A file path is used
// for the real app / seed.

import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type RawDb = Database.Database;
export type Db = BetterSQLite3Database<typeof schema>;
export type DbHandle = { db: Db; sqlite: RawDb };

export function createDb(path = ":memory:"): DbHandle {
  const sqlite = new Database(path);
  // better-sqlite3 defaults foreign_keys OFF per connection — it MUST be enabled every open.
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (path !== ":memory:") sqlite.pragma("journal_mode = WAL"); // WAL is a no-op for :memory:
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
