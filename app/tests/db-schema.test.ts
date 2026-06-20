import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection";
import { applySchema } from "../src/db/migrate";

// Scaffolding smoke test (not a domain cycle): proves the canonical schema.sql applies cleanly to
// a fresh in-memory database and that createDb(':memory:') is a usable, isolated test seam for the
// writeback cycles (26+). If the DDL has a syntax error, applySchema throws and this goes red.

describe("db scaffolding — schema.sql applies to a fresh in-memory database", () => {
  const objectNames = (
    sqlite: ReturnType<typeof createDb>["sqlite"],
    type: string,
  ) =>
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
      .all(type)
      .map((r) => (r as { name: string }).name);

  it("creates all 9 domain tables", () => {
    const { sqlite } = createDb(":memory:");
    applySchema(sqlite);

    expect(objectNames(sqlite, "table")).toEqual([
      "accumulators",
      "adjudications",
      "claims",
      "coverage_rules",
      "disputes",
      "line_items",
      "members",
      "policies",
      "status_transitions",
    ]);
    sqlite.close();
  });

  it("creates the append-only + updated_at + dispute-ordering triggers (11)", () => {
    const { sqlite } = createDb(":memory:");
    applySchema(sqlite);

    expect(objectNames(sqlite, "trigger")).toHaveLength(11);
    sqlite.close();
  });

  it("enables foreign-key enforcement on every connection", () => {
    const { sqlite } = createDb(":memory:");
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    sqlite.close();
  });
});
