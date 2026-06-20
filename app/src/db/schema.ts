// app/src/db/schema.ts — Drizzle table handles for typed queries.
//
// `schema.sql` (generated from docs/erd-physical.md) is the CANONICAL DDL — it creates the
// tables, CHECK constraints, composite FKs, partial indexes, and triggers that SQLite/Drizzle
// can't all express in TS. These Drizzle definitions MIRROR that DDL purely so repositories can
// build type-safe queries; they intentionally omit the CHECKs/triggers (the DB enforces those).
// snake_case DB columns ↔ camelCase TS properties (see the ERD's Drizzle/zod mapping table).

import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ClaimStatus } from "../domain/entities/claim";
import type { LineItemStatus } from "../domain/entities/line-item";
import type { ReasonCode } from "../domain/reason-codes";

// All timestamps default to ISO-8601 UTC at the DB layer (metadata; never read by logic).
const nowDefault = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // PHI — stores AES-256-GCM ciphertext (see db/phi-crypto.ts)
  dob: text("dob").notNull(), // PHI — stores AES-256-GCM ciphertext
  createdAt: text("created_at").notNull().default(nowDefault),
});

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id),
  planYear: text("plan_year").notNull(),
  effectiveDate: text("effective_date").notNull(),
  terminationDate: text("termination_date").notNull(),
  deductibleCents: integer("deductible_cents").notNull(),
  oopMaxCents: integer("oop_max_cents").notNull(),
  createdAt: text("created_at").notNull().default(nowDefault),
});

export const coverageRules = sqliteTable("coverage_rules", {
  id: text("id").primaryKey(),
  policyId: text("policy_id")
    .notNull()
    .references(() => policies.id),
  serviceCode: text("service_code").notNull(),
  covered: integer("covered", { mode: "boolean" }).notNull(),
  excluded: integer("excluded", { mode: "boolean" }).notNull(),
  costShareType: text("cost_share_type", {
    enum: ["full_coverage", "copay", "coinsurance"],
  }).notNull(),
  copayCents: integer("copay_cents"), // non-null iff type=copay (CHECK in schema.sql)
  coinsuranceRate: real("coinsurance_rate"), // non-null iff type=coinsurance
  appliesDeductible: integer("applies_deductible", {
    mode: "boolean",
  }).notNull(),
  limitUnit: text("limit_unit", {
    enum: ["none", "dollars", "visits"],
  }).notNull(),
  limitAmountCents: integer("limit_amount_cents"), // non-null iff unit=dollars
  limitCount: integer("limit_count"), // non-null iff unit=visits
  requiresPriorAuth: integer("requires_prior_auth", {
    mode: "boolean",
  }).notNull(),
  createdAt: text("created_at").notNull().default(nowDefault),
});

export const claims = sqliteTable("claims", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id),
  policyId: text("policy_id")
    .notNull()
    .references(() => policies.id),
  serviceDate: text("service_date").notNull(),
  provider: text("provider"), // PHI, nullable — AES-256-GCM ciphertext (see db/phi-crypto.ts)
  diagnosisCode: text("diagnosis_code"), // PHI, nullable — AES-256-GCM ciphertext
  status: text("status").$type<ClaimStatus>().notNull().default("SUBMITTED"),
  claimSeq: integer("claim_seq").notNull().default(0),
  createdAt: text("created_at").notNull().default(nowDefault),
  updatedAt: text("updated_at").notNull().default(nowDefault),
});

export const lineItems = sqliteTable("line_items", {
  id: text("id").primaryKey(),
  claimId: text("claim_id")
    .notNull()
    .references(() => claims.id),
  serviceCode: text("service_code").notNull(), // free text (unlisted → NO_COVERAGE at adj)
  billedCents: integer("billed_cents").notNull(),
  units: integer("units").notNull().default(1),
  priorAuthPresent: integer("prior_auth_present", { mode: "boolean" })
    .notNull()
    .default(true),
  status: text("status").$type<LineItemStatus>().notNull().default("PENDING"),
  fingerprint: text("fingerprint").notNull(),
  createdAt: text("created_at").notNull().default(nowDefault),
  updatedAt: text("updated_at").notNull().default(nowDefault),
});

export const adjudications = sqliteTable("adjudications", {
  id: text("id").primaryKey(),
  lineItemId: text("line_item_id")
    .notNull()
    .references(() => lineItems.id),
  planYear: text("plan_year").notNull(),
  seq: integer("seq").notNull(), // per-line clock; current = MAX(seq)
  status: text("status").$type<"APPROVED" | "DENIED">().notNull(),
  billedCents: integer("billed_cents").notNull(), // snapshot at decision time
  payableCents: integer("payable_cents").notNull(),
  memberResponsibilityCents: integer("member_responsibility_cents").notNull(),
  reasonsJson: text("reasons_json", { mode: "json" })
    .$type<ReasonCode[]>()
    .notNull(),
  explanation: text("explanation").notNull(),
  deltaDeductibleIncCents: integer("delta_deductible_inc_cents")
    .notNull()
    .default(0),
  deltaOopIncCents: integer("delta_oop_inc_cents").notNull().default(0),
  deltaLimitInc: integer("delta_limit_inc").notNull().default(0),
  createdAt: text("created_at").notNull().default(nowDefault),
});

export const accumulators = sqliteTable("accumulators", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id),
  planYear: text("plan_year").notNull(),
  dimension: text("dimension").notNull(), // DEDUCTIBLE | OOP | LIMIT:<service_code>
  unit: text("unit", { enum: ["CENTS", "COUNT"] }).notNull(),
  usedCents: integer("used_cents").notNull().default(0),
  usedCount: integer("used_count").notNull().default(0),
  updatedAt: text("updated_at").notNull().default(nowDefault),
});

export const disputes = sqliteTable("disputes", {
  id: text("id").primaryKey(),
  lineItemId: text("line_item_id")
    .notNull()
    .references(() => lineItems.id),
  // original/resolved adjudication ids use COMPOSITE FKs (id,line_item_id) — enforced in schema.sql.
  originalAdjudicationId: text("original_adjudication_id").notNull(),
  resolvedAdjudicationId: text("resolved_adjudication_id"), // null while OPEN
  reason: text("reason").notNull(),
  correctedPriorAuthPresent: integer("corrected_prior_auth_present", {
    mode: "boolean",
  }),
  correctedServiceCode: text("corrected_service_code"),
  correctedBilledCents: integer("corrected_billed_cents"),
  correctedUnits: integer("corrected_units"),
  outcome: text("outcome", {
    enum: ["UPHELD", "OVERTURNED", "PARTIALLY_OVERTURNED", "MODIFIED"],
  }), // null while OPEN
  state: text("state", { enum: ["OPEN", "RESOLVED"] })
    .notNull()
    .default("OPEN"),
  openedAt: text("opened_at").notNull().default(nowDefault),
  resolvedAt: text("resolved_at"), // null while OPEN
});

export const statusTransitions = sqliteTable("status_transitions", {
  id: text("id").primaryKey(),
  entityType: text("entity_type", { enum: ["CLAIM", "LINE_ITEM"] }).notNull(),
  claimId: text("claim_id")
    .notNull()
    .references(() => claims.id), // owning claim aggregate; always set
  lineItemId: text("line_item_id").references(() => lineItems.id), // set iff LINE_ITEM
  fromStatus: text("from_status"), // null on create
  toStatus: text("to_status").notNull(),
  actor: text("actor", { enum: ["SYSTEM", "MEMBER"] }).notNull(),
  reason: text("reason", {
    enum: ["SUBMIT", "ADJUDICATED", "AGGREGATED", "DISPUTE_REOPEN"],
  }).notNull(),
  seq: integer("seq").notNull(), // claim-aggregate logical clock
  createdAt: text("created_at").notNull().default(nowDefault),
});
