# Physical Database ERD — Claims Adjudication (SQLite)

> Source of truth: `docs/domain-model.md`, `docs/adjudication-plan.md`, `docs/decisions.md`, `PRD.md`. Dialect: **SQLite via better-sqlite3 + Drizzle** (locked by decision #2; confirmed by `app/src/db/connection.ts` and `app/drizzle.config.ts` stub comments). This **physical** ERD supersedes the logical `docs/erd.md` without regressing any of its 9 entities. If docs and code ever drift, **the code wins** and this doc is updated.

This revision incorporates every valid review finding. Where reviewers conflicted with a locked decision (most notably `service_code` free-text vs. the closed 12-entry catalog), the locked decision wins and the conflict is documented in **Design decisions & rationale**.

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    MEMBERS ||--|| POLICIES : "has 1 per plan_year"
    MEMBERS ||--o{ CLAIMS : "submits"
    MEMBERS ||--o{ ACCUMULATORS : "tracked by (1+ rows/plan_year)"
    POLICIES ||--o{ COVERAGE_RULES : "defines"
    POLICIES ||--o{ CLAIMS : "adjudicated under (recorded policy_id)"
    CLAIMS ||--o{ LINE_ITEMS : "contains 1+"
    LINE_ITEMS ||--o{ ADJUDICATIONS : "decided by (append-only; latest seq = current)"
    LINE_ITEMS ||--o{ DISPUTES : "challenged by (terminal lines only)"
    ADJUDICATIONS ||--o{ DISPUTES : "challenged/resolved (see note: two FKs, one edge)"
    CLAIMS ||--o{ STATUS_TRANSITIONS : "logged via claim_id (polymorphic, exactly-one)"
    LINE_ITEMS ||--o{ STATUS_TRANSITIONS : "logged via line_item_id (polymorphic, exactly-one)"

    MEMBERS {
        TEXT id PK "UUID surrogate"
        TEXT name "PHI; app-level encrypt-at-rest (SQLCipher); engine never reads"
        TEXT dob "PHI; ISO-8601 date; app-level encrypt; not adjudicated"
        TEXT created_at "ISO-8601 metadata"
    }

    POLICIES {
        TEXT id PK "UUID surrogate"
        TEXT member_id FK "to members.id; RESTRICT del / CASCADE upd"
        TEXT plan_year "e.g. 2025; accumulator window key"
        TEXT effective_date "ISO-8601 date; GLOB-validated; policy-active lower bound"
        TEXT termination_date "ISO-8601 date; GLOB-validated; policy-active upper bound"
        INTEGER deductible_cents "cents; CHECK >= 0"
        INTEGER oop_max_cents "cents; CHECK >= 0; CHECK >= deductible_cents"
        TEXT created_at "ISO-8601 metadata"
        UK member_plan_year "UNIQUE(member_id, plan_year): 1 policy/member/year"
    }

    COVERAGE_RULES {
        TEXT id PK "UUID surrogate"
        TEXT policy_id FK "to policies.id; CASCADE del / CASCADE upd"
        TEXT service_code "CHECK in closed 12-entry catalog (decision #10)"
        INTEGER covered "BOOL 0/1; CHECK IN (0,1)"
        INTEGER excluded "BOOL 0/1; excluded beats covered; CHECK IN (0,1)"
        TEXT cost_share_type "ENUM full_coverage|copay|coinsurance; discriminant"
        INTEGER copay_cents "cents; NOT NULL iff type=copay else NULL; CHECK >= 0"
        REAL coinsurance_rate "member share; NOT NULL iff type=coinsurance else NULL; CHECK 0..1"
        INTEGER applies_deductible "BOOL 0/1; CHECK IN (0,1)"
        TEXT limit_unit "ENUM none|dollars|visits; discriminant"
        INTEGER limit_amount_cents "cents; NOT NULL iff unit=dollars else NULL; CHECK > 0"
        INTEGER limit_count "visits; NOT NULL iff unit=visits else NULL; CHECK > 0"
        INTEGER requires_prior_auth "BOOL 0/1; CHECK IN (0,1)"
        TEXT created_at "ISO-8601 metadata"
        UK policy_service "UNIQUE(policy_id, service_code): 1 rule/service/policy"
    }

    CLAIMS {
        TEXT id PK "UUID surrogate"
        TEXT member_id FK "to members.id; RESTRICT del / CASCADE upd"
        TEXT policy_id FK "to policies.id; RESTRICT del / CASCADE upd; recorded at intake"
        TEXT service_date "ISO-8601 date; GLOB-validated; CLAIM-level; drives policy-active"
        TEXT provider "PHI nullable; app-level encrypt; not adjudicated"
        TEXT diagnosis_code "PHI nullable; app-level encrypt; not adjudicated"
        TEXT status "ENUM SUBMITTED|UNDER_REVIEW|APPROVED|PARTIALLY_APPROVED|DENIED; derived"
        INTEGER claim_seq "claim-aggregate logical clock head; bumped per transition"
        TEXT created_at "ISO-8601 metadata"
        TEXT updated_at "ISO-8601 metadata"
    }

    LINE_ITEMS {
        TEXT id PK "UUID surrogate"
        TEXT claim_id FK "to claims.id; CASCADE del / CASCADE upd"
        TEXT service_code "free text NOT NULL (no catalog CHECK); unlisted accepted at intake, NO_COVERAGE at adj (PRD:171)"
        INTEGER billed_cents "cents; CHECK > 0 (positive)"
        INTEGER units "CHECK > 0; default 1"
        INTEGER prior_auth_present "BOOL 0/1; default 1 (absence=present); CHECK IN (0,1)"
        TEXT status "ENUM PENDING|APPROVED|DENIED|NEEDS_REVIEW; PARTIALLY_APPROVED is claim-only"
        TEXT fingerprint "member_id+service_code+service_date+billed_cents; dup detection"
        TEXT created_at "ISO-8601 metadata"
        TEXT updated_at "ISO-8601 metadata"
    }

    ADJUDICATIONS {
        TEXT id PK "UUID surrogate; APPEND-ONLY (triggers RAISE on INSERT-overwrite/UPDATE/DELETE)"
        TEXT line_item_id FK "to line_items.id; RESTRICT del / CASCADE upd"
        TEXT plan_year "accumulator window this decision wrote to; immutable audit anchor"
        INTEGER seq "logical clock; current = MAX(seq) per line_item_id"
        TEXT status "ENUM APPROVED|DENIED (line outcome of this decision)"
        INTEGER billed_cents "billed snapshot at decision time; CHECK > 0"
        INTEGER payable_cents "plan pays; CHECK >= 0"
        INTEGER member_responsibility_cents "member owes; CHECK >= 0"
        TEXT reasons_json "JSON ReasonCode[]; dominant first; CHECK json_type=array and non-empty"
        TEXT explanation "EOB sentence citing rule + numbers"
        INTEGER delta_deductible_inc_cents "accumulator delta written; CHECK >= 0"
        INTEGER delta_oop_inc_cents "accumulator delta written; CHECK >= 0"
        INTEGER delta_limit_inc "delta in rule unit (cents or count); CHECK >= 0"
        TEXT created_at "ISO-8601 metadata only; never read by logic"
        UK line_seq "UNIQUE(line_item_id, seq): deterministic ordering"
        UK id_line "UNIQUE(id, line_item_id): composite FK target for disputes"
    }

    ACCUMULATORS {
        TEXT id PK "UUID surrogate; UPDATE-in-place (NOT append-only)"
        TEXT member_id FK "to members.id; RESTRICT del / CASCADE upd"
        TEXT plan_year "e.g. 2025; reset = new rows per plan_year"
        TEXT dimension "DEDUCTIBLE | OOP | 'LIMIT:'+service_code (free suffix)"
        TEXT unit "ENUM CENTS|COUNT; ties the populated column to the rule unit"
        INTEGER used_cents "for DEDUCTIBLE/OOP/dollar-limit; CHECK >= 0"
        INTEGER used_count "for visit-limit; CHECK >= 0"
        TEXT updated_at "ISO-8601 metadata"
        UK member_year_dim "UNIQUE(member_id, plan_year, dimension)"
    }

    DISPUTES {
        TEXT id PK "UUID surrogate"
        TEXT line_item_id FK "to line_items.id; CASCADE del / CASCADE upd"
        TEXT original_adjudication_id FK "composite FK (id,line_item_id)->adjudications; NOT NULL; RESTRICT del"
        TEXT resolved_adjudication_id FK "composite FK (id,line_item_id)->adjudications; NULL while OPEN; RESTRICT del"
        TEXT reason "member rationale; surfaced verbatim; NOT NULL"
        INTEGER corrected_prior_auth_present "BOOL 0/1 nullable; only amendable field; CHECK IN (0,1)"
        TEXT corrected_service_code "nullable; only amendable field; free text (no catalog CHECK), mirrors line_items"
        INTEGER corrected_billed_cents "nullable; CHECK > 0; only amendable field"
        INTEGER corrected_units "nullable; CHECK > 0; only amendable field"
        TEXT outcome "ENUM UPHELD|OVERTURNED|PARTIALLY_OVERTURNED|MODIFIED; null while OPEN"
        TEXT state "ENUM OPEN|RESOLVED"
        TEXT opened_at "ISO-8601"
        TEXT resolved_at "ISO-8601 nullable (null while OPEN)"
        UK one_open "partial UNIQUE(line_item_id, original_adjudication_id) WHERE state=OPEN"
    }

    STATUS_TRANSITIONS {
        TEXT id PK "UUID surrogate; APPEND-ONLY (triggers RAISE on INSERT-overwrite/UPDATE/DELETE)"
        TEXT entity_type "ENUM CLAIM|LINE_ITEM; discriminant"
        TEXT claim_id FK "to claims.id; the owning claim aggregate; always set; CASCADE del"
        TEXT line_item_id FK "to line_items.id; NOT NULL iff entity_type=LINE_ITEM; CASCADE del"
        TEXT from_status "nullable; null on create"
        TEXT to_status "new status; NOT NULL"
        TEXT actor "ENUM SYSTEM|MEMBER"
        TEXT reason "ENUM SUBMIT|ADJUDICATED|AGGREGATED|DISPUTE_REOPEN (coarse, not ReasonCode)"
        INTEGER seq "claim-aggregate logical clock; total order across the merged timeline"
        TEXT created_at "ISO-8601 metadata only; never read by logic"
        UK claim_seq "UNIQUE(claim_id, seq): one monotonic clock per claim aggregate"
    }
```

> **Diagram note (dual FK, one edge).** `ADJUDICATIONS ||--o{ DISPUTES` is rendered as a single edge, but the DDL carries **two** FKs from `disputes` to `adjudications`: `original_adjudication_id` (NOT NULL, immutable, the challenged decision) and `resolved_adjudication_id` (NULLABLE, NULL while OPEN, the produced decision). Mermaid `erDiagram` collapses multiple edges between the same pair of entities to one, so the nullable-cardinality distinction lives in the DDL and the table reference below, not the picture. Both are **composite** FKs `(adjudication_id, line_item_id) -> adjudications(id, line_item_id)` so a dispute can only reference adjudications belonging to its own line item.

---

## Table reference

### 1. `members` — the insured person (PHI lives here)

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID v4, app-generated |
| `name` | TEXT | | NOT NULL | PHI; encrypt-at-rest (SQLCipher / app field encryption); engine never reads |
| `dob` | TEXT | | NOT NULL | PHI; ISO-8601 date; not adjudicated |
| `created_at` | TEXT | | NOT NULL DEFAULT now | ISO-8601 metadata |

### 2. `policies` — binds a member to a plan year (1 per member/plan_year)

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `member_id` | TEXT | FK→members.id | NOT NULL; ON DELETE RESTRICT / ON UPDATE CASCADE | a member with a policy must not vanish |
| `plan_year` | TEXT | UK | NOT NULL | accumulator window key (e.g. `2025`) |
| `effective_date` | TEXT | | NOT NULL; GLOB `____-__-__` | policy-active lower bound |
| `termination_date` | TEXT | | NOT NULL; GLOB `____-__-__` | policy-active upper bound |
| `deductible_cents` | INTEGER | | NOT NULL; CHECK ≥ 0 | integer cents |
| `oop_max_cents` | INTEGER | | NOT NULL; CHECK ≥ 0; CHECK ≥ `deductible_cents` | OOP max never below deductible |
| `created_at` | TEXT | | NOT NULL DEFAULT now | metadata |
| — | | UK | UNIQUE(`member_id`,`plan_year`) | one policy per member per year |
| — | | CHECK | `effective_date <= termination_date` | ordered policy window |

### 3. `coverage_rules` — typed config (cost-share union + limit union per service)

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `policy_id` | TEXT | FK→policies.id | NOT NULL; ON DELETE CASCADE / ON UPDATE CASCADE | rules are owned config of a policy |
| `service_code` | TEXT | | NOT NULL; CHECK in closed 12-entry catalog | matched by (policy_id, service_code) |
| `covered` | INTEGER | | NOT NULL; CHECK IN (0,1) | bool |
| `excluded` | INTEGER | | NOT NULL; CHECK IN (0,1) | bool; excluded beats covered |
| `cost_share_type` | TEXT | | NOT NULL; CHECK IN (`full_coverage`,`copay`,`coinsurance`) | discriminant |
| `copay_cents` | INTEGER | | NULL unless type=copay; CHECK ≥ 0 | union shape enforced |
| `coinsurance_rate` | REAL | | NULL unless type=coinsurance; CHECK 0.0–1.0 | member share; only float in schema |
| `applies_deductible` | INTEGER | | NOT NULL; CHECK IN (0,1) | bool |
| `limit_unit` | TEXT | | NOT NULL; CHECK IN (`none`,`dollars`,`visits`) | discriminant |
| `limit_amount_cents` | INTEGER | | NULL unless unit=dollars; CHECK > 0 | union shape enforced |
| `limit_count` | INTEGER | | NULL unless unit=visits; CHECK > 0 | union shape enforced |
| `requires_prior_auth` | INTEGER | | NOT NULL; CHECK IN (0,1) | bool |
| `created_at` | TEXT | | NOT NULL DEFAULT now | metadata |
| — | | UK | UNIQUE(`policy_id`,`service_code`) | one rule/service/policy; also serves coverage match |
| — | | CHECK | `ck_cr_cost_share_shape` | exactly the right typed column non-null per discriminant |
| — | | CHECK | `ck_cr_limit_shape` | exactly the right typed column non-null per discriminant |

### 4. `claims` — submission envelope (status DERIVED; PHI provider/diagnosis)

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `member_id` | TEXT | FK→members.id | NOT NULL; ON DELETE RESTRICT / ON UPDATE CASCADE | claims are audit/financial records |
| `policy_id` | TEXT | FK→policies.id | NOT NULL; ON DELETE RESTRICT / ON UPDATE CASCADE | resolved & recorded at intake (review finding #4-major) |
| `service_date` | TEXT | | NOT NULL; GLOB `____-__-__` | claim-level; drives policy-active gate |
| `provider` | TEXT | | NULL | PHI; not adjudicated |
| `diagnosis_code` | TEXT | | NULL | PHI; not adjudicated |
| `status` | TEXT | | NOT NULL DEFAULT `SUBMITTED`; CHECK in claim enum | derived by aggregation; stored source of truth |
| `claim_seq` | INTEGER | | NOT NULL DEFAULT 0; CHECK ≥ 0 | head of the claim-aggregate logical clock for `status_transitions` |
| `created_at` | TEXT | | NOT NULL DEFAULT now | metadata |
| `updated_at` | TEXT | | NOT NULL DEFAULT now | metadata |

### 5. `line_items` — unit of adjudication

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `claim_id` | TEXT | FK→claims.id | NOT NULL; ON DELETE CASCADE / ON UPDATE CASCADE | one aggregate with its claim |
| `service_code` | TEXT | | NOT NULL; **free text, no catalog CHECK** | unlisted accepted at intake → `NO_COVERAGE` at adjudication (PRD:171); matched by (policy_id, service_code) |
| `billed_cents` | INTEGER | | NOT NULL; CHECK > 0 | positive |
| `units` | INTEGER | | NOT NULL DEFAULT 1; CHECK > 0 | positive |
| `prior_auth_present` | INTEGER | | NOT NULL DEFAULT 1; CHECK IN (0,1) | absence = present (decision #13) |
| `status` | TEXT | | NOT NULL DEFAULT `PENDING`; CHECK IN (PENDING,APPROVED,DENIED,NEEDS_REVIEW) | PARTIALLY_APPROVED is claim-only |
| `fingerprint` | TEXT | | NOT NULL | member_id+service_code+service_date+billed_cents |
| `created_at` | TEXT | | NOT NULL DEFAULT now | metadata |
| `updated_at` | TEXT | | NOT NULL DEFAULT now | metadata |

### 6. `adjudications` — APPEND-ONLY immutable decisions (current = MAX(seq))

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `line_item_id` | TEXT | FK→line_items.id | NOT NULL; ON DELETE RESTRICT / ON UPDATE CASCADE | decision trail must not be deletable |
| `plan_year` | TEXT | | NOT NULL | accumulator window this decision wrote (review finding #4-major); self-contained audit |
| `seq` | INTEGER | | NOT NULL; CHECK > 0 | per-line logical clock; current = MAX(seq) |
| `status` | TEXT | | NOT NULL; CHECK IN (APPROVED,DENIED) | concrete line outcome of THIS decision |
| `billed_cents` | INTEGER | | NOT NULL; CHECK > 0 | billed snapshot at decision time (review finding #payable-sum) |
| `payable_cents` | INTEGER | | NOT NULL; CHECK ≥ 0 | plan pays |
| `member_responsibility_cents` | INTEGER | | NOT NULL; CHECK ≥ 0 | member owes |
| `reasons_json` | TEXT | | NOT NULL; CHECK json_type=array AND length ≥ 1 | JSON ReasonCode[]; dominant first |
| `explanation` | TEXT | | NOT NULL | EOB sentence |
| `delta_deductible_inc_cents` | INTEGER | | NOT NULL DEFAULT 0; CHECK ≥ 0 | accumulator delta |
| `delta_oop_inc_cents` | INTEGER | | NOT NULL DEFAULT 0; CHECK ≥ 0 | accumulator delta |
| `delta_limit_inc` | INTEGER | | NOT NULL DEFAULT 0; CHECK ≥ 0 | rule unit (cents or count) |
| `created_at` | TEXT | | NOT NULL DEFAULT now | metadata only |
| — | | UK | UNIQUE(`line_item_id`,`seq`) | clean MAX(seq) ordering |
| — | | UK | UNIQUE(`id`,`line_item_id`) | composite FK target for disputes (review finding #2-critical) |
| — | | CHECK | `ck_adj_sum` | DENIED→both 0; else payable+member = billed_cents (review finding #payable-sum) |

### 7. `accumulators` — per-member-per-plan_year memory (UPDATE-in-place)

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `member_id` | TEXT | FK→members.id | NOT NULL; ON DELETE RESTRICT / ON UPDATE CASCADE | audit/financial |
| `plan_year` | TEXT | | NOT NULL | reset = NEW rows per plan_year |
| `dimension` | TEXT | | NOT NULL | `DEDUCTIBLE` \| `OOP` \| `LIMIT:<service_code>` |
| `unit` | TEXT | | NOT NULL; CHECK IN (`CENTS`,`COUNT`) | ties populated column to rule unit (review finding #3-major) |
| `used_cents` | INTEGER | | NOT NULL DEFAULT 0; CHECK ≥ 0 | DEDUCTIBLE/OOP/dollar-limit |
| `used_count` | INTEGER | | NOT NULL DEFAULT 0; CHECK ≥ 0 | visit-limit |
| `updated_at` | TEXT | | NOT NULL DEFAULT now | metadata |
| — | | UK | UNIQUE(`member_id`,`plan_year`,`dimension`) | point-lookup key for writeback |
| — | | CHECK | `ck_acc_unit_dimension` | DEDUCTIBLE/OOP are CENTS; `unit=CENTS`→used_count=0; `unit=COUNT`→used_cents=0 |

### 8. `disputes` — first-class member challenge of one terminal line decision

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `line_item_id` | TEXT | FK→line_items.id | NOT NULL; ON DELETE CASCADE / ON UPDATE CASCADE | a dispute is owned by its line |
| `original_adjudication_id` | TEXT | composite FK | NOT NULL; (id,line_item_id)→adjudications; ON DELETE RESTRICT | immutable decision challenged; same-line guaranteed |
| `resolved_adjudication_id` | TEXT | composite FK | NULL while OPEN; (id,line_item_id)→adjudications; ON DELETE RESTRICT | new decision; same-line guaranteed |
| `reason` | TEXT | | NOT NULL | member rationale; surfaced verbatim |
| `corrected_prior_auth_present` | INTEGER | | NULL; CHECK IN (0,1) | only amendable field |
| `corrected_service_code` | TEXT | | NULL; free text (no catalog CHECK) | only amendable field; mirrors line_items |
| `corrected_billed_cents` | INTEGER | | NULL; CHECK > 0 | only amendable field |
| `corrected_units` | INTEGER | | NULL; CHECK > 0 | only amendable field |
| `outcome` | TEXT | | NULL while OPEN; CHECK IN (UPHELD,OVERTURNED,PARTIALLY_OVERTURNED,MODIFIED) | diff of new vs original |
| `state` | TEXT | | NOT NULL DEFAULT `OPEN`; CHECK IN (OPEN,RESOLVED) | lifecycle |
| `opened_at` | TEXT | | NOT NULL DEFAULT now | ISO-8601 |
| `resolved_at` | TEXT | | NULL while OPEN | ISO-8601 |
| — | | UK (partial) | UNIQUE(`line_item_id`,`original_adjudication_id`) WHERE state=OPEN | at most one OPEN dispute per decision (review finding #dup-open) |
| — | | CHECK | `ck_disputes_state_shape` | OPEN→resolution NULL; RESOLVED→resolution fully populated |

> Enforced by trigger (cross-row, not single-row CHECK): a `resolved_adjudication_id`, when set, must have a **higher `seq`** than `original_adjudication_id` (review finding #seq-order) — the resolved decision supersedes the challenged one.

### 9. `status_transitions` — APPEND-ONLY polymorphic audit log

| column | type | key | constraints | notes |
|---|---|---|---|---|
| `id` | TEXT | PK | NOT NULL | UUID surrogate |
| `entity_type` | TEXT | | NOT NULL; CHECK IN (CLAIM,LINE_ITEM) | discriminant |
| `claim_id` | TEXT | FK→claims.id | NOT NULL (always set); ON DELETE CASCADE / ON UPDATE CASCADE | the owning claim aggregate (review finding #timeline-order) |
| `line_item_id` | TEXT | FK→line_items.id | NOT NULL iff entity_type=LINE_ITEM; ON DELETE CASCADE / ON UPDATE CASCADE | the line target |
| `from_status` | TEXT | | NULL on create | the move's source |
| `to_status` | TEXT | | NOT NULL | the move's target |
| `actor` | TEXT | | NOT NULL; CHECK IN (SYSTEM,MEMBER) | no auth/user entity |
| `reason` | TEXT | | NOT NULL; CHECK IN (SUBMIT,ADJUDICATED,AGGREGATED,DISPUTE_REOPEN) | coarse cause, NOT a ReasonCode |
| `seq` | INTEGER | | NOT NULL; CHECK > 0 | claim-aggregate logical clock (total order over merged timeline) |
| `created_at` | TEXT | | NOT NULL DEFAULT now | metadata only |
| — | | UK | UNIQUE(`claim_id`,`seq`) | one monotonic clock per claim aggregate |
| — | | CHECK | `ck_st_polymorphic` | exactly-one target keyed by entity_type; CLAIM→line_item_id NULL, LINE_ITEM→line_item_id NOT NULL |

---

## SQLite DDL

```sql
-- =====================================================================
-- Insurance Claims Adjudication — Physical Schema
-- Dialect: SQLite (better-sqlite3, synchronous single-writer) + Drizzle.
-- Conventions: snake_case columns, plural tables, surrogate TEXT(UUID) PKs,
--   money/counts as INTEGER (64-bit) cents/units, dates/timestamps as TEXT ISO-8601,
--   booleans as INTEGER CHECK IN (0,1), enums as TEXT CHECK IN (...), REAL for rate.
-- =====================================================================

-- REQUIRED at every connection open (better-sqlite3 defaults FKs OFF per-connection):
PRAGMA foreign_keys = ON;
-- Single-writer adjudication model; defensive concurrency settings:
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- =====================================================================
-- 1) members — the insured person. PHI lives here.
-- =====================================================================
CREATE TABLE members (
  id          TEXT NOT NULL PRIMARY KEY,
  name        TEXT NOT NULL,                         -- PHI: encrypt-at-rest; engine never reads
  dob         TEXT NOT NULL,                         -- PHI: ISO-8601; not adjudicated
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- =====================================================================
-- 2) policies — binds a member to a plan year. 1 per (member, plan_year).
-- =====================================================================
CREATE TABLE policies (
  id                TEXT    NOT NULL PRIMARY KEY,
  member_id         TEXT    NOT NULL,
  plan_year         TEXT    NOT NULL,                -- accumulator window key
  effective_date    TEXT    NOT NULL,
  termination_date  TEXT    NOT NULL,
  deductible_cents  INTEGER NOT NULL,
  oop_max_cents     INTEGER NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_policies_member
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT uq_policies_member_plan_year UNIQUE (member_id, plan_year),
  CONSTRAINT ck_policies_deductible_nonneg CHECK (deductible_cents >= 0),
  CONSTRAINT ck_policies_oop_nonneg        CHECK (oop_max_cents    >= 0),
  CONSTRAINT ck_policies_oop_ge_deductible CHECK (oop_max_cents    >= deductible_cents),
  CONSTRAINT ck_policies_date_window       CHECK (effective_date  <= termination_date),
  -- lightweight ISO-8601 date format guard (review finding: malformed dates):
  CONSTRAINT ck_policies_eff_fmt  CHECK (effective_date   GLOB '____-__-__'),
  CONSTRAINT ck_policies_term_fmt CHECK (termination_date GLOB '____-__-__')
) STRICT;

-- =====================================================================
-- 3) coverage_rules — typed config: cost_share union + limit union per service.
--    service_code is constrained to the CLOSED 12-entry catalog (decision #10).
-- =====================================================================
CREATE TABLE coverage_rules (
  id                  TEXT    NOT NULL PRIMARY KEY,
  policy_id           TEXT    NOT NULL,
  service_code        TEXT    NOT NULL,
  covered             INTEGER NOT NULL,
  excluded            INTEGER NOT NULL,
  -- cost_share discriminated union -----------------------------------
  cost_share_type     TEXT    NOT NULL,
  copay_cents         INTEGER,
  coinsurance_rate    REAL,
  applies_deductible  INTEGER NOT NULL,
  -- limit discriminated union ----------------------------------------
  limit_unit          TEXT    NOT NULL,
  limit_amount_cents  INTEGER,
  limit_count         INTEGER,
  requires_prior_auth INTEGER NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_coverage_rules_policy
    FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT uq_coverage_rules_policy_service UNIQUE (policy_id, service_code),
  -- closed 12-entry service-code catalog (decision #10; reconciles review finding):
  CONSTRAINT ck_cr_service_code CHECK (service_code IN (
    'PREVENTIVE','PCP_VISIT','SPECIALIST_VISIT','URGENT_CARE','EMERGENCY_ROOM','LAB',
    'MRI','OUTPATIENT_SURGERY','INPATIENT_HOSPITAL','PHYSICAL_THERAPY','CHIROPRACTIC','ADULT_DENTAL')),
  -- booleans:
  CONSTRAINT ck_cr_covered_bool  CHECK (covered             IN (0,1)),
  CONSTRAINT ck_cr_excluded_bool CHECK (excluded            IN (0,1)),
  CONSTRAINT ck_cr_apdeduc_bool  CHECK (applies_deductible  IN (0,1)),
  CONSTRAINT ck_cr_pa_bool       CHECK (requires_prior_auth IN (0,1)),
  -- cost_share enum + discriminated-union shape:
  CONSTRAINT ck_cr_cost_share_type
    CHECK (cost_share_type IN ('full_coverage','copay','coinsurance')),
  CONSTRAINT ck_cr_cost_share_shape CHECK (
       (cost_share_type = 'full_coverage' AND copay_cents IS NULL     AND coinsurance_rate IS NULL)
    OR (cost_share_type = 'copay'         AND copay_cents IS NOT NULL  AND coinsurance_rate IS NULL)
    OR (cost_share_type = 'coinsurance'   AND copay_cents IS NULL      AND coinsurance_rate IS NOT NULL)
  ),
  CONSTRAINT ck_cr_copay_nonneg CHECK (copay_cents IS NULL OR copay_cents >= 0),
  CONSTRAINT ck_cr_rate_range   CHECK (coinsurance_rate IS NULL OR (coinsurance_rate >= 0.0 AND coinsurance_rate <= 1.0)),
  -- limit enum + discriminated-union shape:
  CONSTRAINT ck_cr_limit_unit
    CHECK (limit_unit IN ('none','dollars','visits')),
  CONSTRAINT ck_cr_limit_shape CHECK (
       (limit_unit = 'none'    AND limit_amount_cents IS NULL     AND limit_count IS NULL)
    OR (limit_unit = 'dollars' AND limit_amount_cents IS NOT NULL  AND limit_count IS NULL)
    OR (limit_unit = 'visits'  AND limit_amount_cents IS NULL      AND limit_count IS NOT NULL)
  ),
  CONSTRAINT ck_cr_limit_amount_pos CHECK (limit_amount_cents IS NULL OR limit_amount_cents > 0),
  CONSTRAINT ck_cr_limit_count_pos  CHECK (limit_count        IS NULL OR limit_count        > 0)
) STRICT;

-- =====================================================================
-- 4) claims — submission envelope. status DERIVED. PHI: provider, diagnosis_code.
--    policy_id recorded at intake so the adjudication window is self-contained.
-- =====================================================================
CREATE TABLE claims (
  id             TEXT    NOT NULL PRIMARY KEY,
  member_id      TEXT    NOT NULL,
  policy_id      TEXT    NOT NULL,                   -- resolved & recorded at intake
  service_date   TEXT    NOT NULL,                   -- claim-level
  provider       TEXT,                               -- PHI nullable; not adjudicated
  diagnosis_code TEXT,                               -- PHI nullable; not adjudicated
  status         TEXT    NOT NULL DEFAULT 'SUBMITTED',
  claim_seq      INTEGER NOT NULL DEFAULT 0,         -- head of claim-aggregate logical clock
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_claims_member
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_claims_policy
    FOREIGN KEY (policy_id) REFERENCES policies(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT ck_claims_status
    CHECK (status IN ('SUBMITTED','UNDER_REVIEW','APPROVED','PARTIALLY_APPROVED','DENIED')),
  CONSTRAINT ck_claims_seq_nonneg CHECK (claim_seq >= 0),
  CONSTRAINT ck_claims_service_date_fmt CHECK (service_date GLOB '____-__-__')
) STRICT;

-- =====================================================================
-- 5) line_items — unit of adjudication.
-- =====================================================================
CREATE TABLE line_items (
  id                 TEXT    NOT NULL PRIMARY KEY,
  claim_id           TEXT    NOT NULL,
  service_code       TEXT    NOT NULL,               -- FREE TEXT (no catalog CHECK); unlisted accepted at intake, NO_COVERAGE at adj (PRD:171, domain-model:66)
  billed_cents       INTEGER NOT NULL,
  units              INTEGER NOT NULL DEFAULT 1,
  prior_auth_present INTEGER NOT NULL DEFAULT 1,
  status             TEXT    NOT NULL DEFAULT 'PENDING',
  fingerprint        TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_line_items_claim
    FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- NO catalog CHECK on service_code: an unlisted code is accepted at intake and denied
  -- NO_COVERAGE at adjudication (PRD:171 "never an intake reject"); coverage match is a
  -- (policy_id, service_code) lookup against coverage_rules, not a DB constraint.
  CONSTRAINT ck_li_billed_pos CHECK (billed_cents > 0),
  CONSTRAINT ck_li_units_pos  CHECK (units > 0),
  CONSTRAINT ck_li_pa_bool    CHECK (prior_auth_present IN (0,1)),
  CONSTRAINT ck_li_status     CHECK (status IN ('PENDING','APPROVED','DENIED','NEEDS_REVIEW'))
) STRICT;

-- =====================================================================
-- 6) adjudications — APPEND-ONLY immutable decisions. current = MAX(seq).
--    Carries billed_cents snapshot + plan_year for self-contained audit.
--    UNIQUE(id, line_item_id) is the composite-FK target for disputes.
-- =====================================================================
CREATE TABLE adjudications (
  id                            TEXT    NOT NULL PRIMARY KEY,
  line_item_id                  TEXT    NOT NULL,
  plan_year                     TEXT    NOT NULL,             -- accumulator window written (audit anchor)
  seq                           INTEGER NOT NULL,             -- per-line clock; current = MAX(seq)
  status                        TEXT    NOT NULL,
  billed_cents                  INTEGER NOT NULL,             -- billed snapshot at decision time
  payable_cents                 INTEGER NOT NULL,
  member_responsibility_cents   INTEGER NOT NULL,
  reasons_json                  TEXT    NOT NULL,
  explanation                   TEXT    NOT NULL,
  delta_deductible_inc_cents    INTEGER NOT NULL DEFAULT 0,
  delta_oop_inc_cents           INTEGER NOT NULL DEFAULT 0,
  delta_limit_inc               INTEGER NOT NULL DEFAULT 0,
  created_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_adjudications_line_item
    FOREIGN KEY (line_item_id) REFERENCES line_items(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT uq_adjudications_line_seq UNIQUE (line_item_id, seq),
  CONSTRAINT uq_adjudications_id_line  UNIQUE (id, line_item_id),  -- composite-FK target for disputes
  CONSTRAINT ck_adj_status       CHECK (status IN ('APPROVED','DENIED')),
  CONSTRAINT ck_adj_seq_pos      CHECK (seq > 0),
  CONSTRAINT ck_adj_billed_pos   CHECK (billed_cents                > 0),
  CONSTRAINT ck_adj_payable      CHECK (payable_cents               >= 0),
  CONSTRAINT ck_adj_member       CHECK (member_responsibility_cents >= 0),
  CONSTRAINT ck_adj_delta_deduc  CHECK (delta_deductible_inc_cents  >= 0),
  CONSTRAINT ck_adj_delta_oop    CHECK (delta_oop_inc_cents         >= 0),
  CONSTRAINT ck_adj_delta_limit  CHECK (delta_limit_inc             >= 0),
  -- reasons_json must be a non-empty JSON array (stronger than json_valid):
  CONSTRAINT ck_adj_reasons_json CHECK (json_type(reasons_json) = 'array' AND json_array_length(reasons_json) >= 1),
  -- payable + member == billed for covered lines; both 0 on denial (invariant):
  CONSTRAINT ck_adj_sum CHECK (
       (status = 'DENIED'   AND payable_cents = 0 AND member_responsibility_cents = 0)
    OR (status = 'APPROVED' AND payable_cents + member_responsibility_cents = billed_cents)
  )
) STRICT;

-- =====================================================================
-- 7) accumulators — per-member-per-plan_year memory. UPDATE-in-place.
--    `unit` ties the populated column to the rule's limit unit.
-- =====================================================================
CREATE TABLE accumulators (
  id          TEXT    NOT NULL PRIMARY KEY,
  member_id   TEXT    NOT NULL,
  plan_year   TEXT    NOT NULL,
  dimension   TEXT    NOT NULL,                      -- 'DEDUCTIBLE' | 'OOP' | 'LIMIT:<service_code>'
  unit        TEXT    NOT NULL,                      -- 'CENTS' | 'COUNT'
  used_cents  INTEGER NOT NULL DEFAULT 0,
  used_count  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_accumulators_member
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT uq_accumulators_member_year_dim UNIQUE (member_id, plan_year, dimension),
  CONSTRAINT ck_acc_unit       CHECK (unit IN ('CENTS','COUNT')),
  CONSTRAINT ck_acc_used_cents CHECK (used_cents >= 0),
  CONSTRAINT ck_acc_used_count CHECK (used_count >= 0),
  -- unit/column coherence (review finding: visit-limit must not store dollars):
  --   DEDUCTIBLE/OOP are always CENTS; the populated column matches `unit`,
  --   the other stays 0; LIMIT rows pick exactly one column by `unit`.
  CONSTRAINT ck_acc_unit_dimension CHECK (
       (dimension IN ('DEDUCTIBLE','OOP') AND unit = 'CENTS' AND used_count = 0)
    OR (dimension LIKE 'LIMIT:%'
        AND ( (unit = 'CENTS' AND used_count = 0)
           OR (unit = 'COUNT' AND used_cents = 0) ))
  )
) STRICT;

-- =====================================================================
-- 8) disputes — first-class member challenge of one terminal line decision.
--    Composite FKs (adjudication_id, line_item_id) -> adjudications(id, line_item_id)
--    guarantee the challenged AND resolved decisions belong to the disputed line.
-- =====================================================================
CREATE TABLE disputes (
  id                           TEXT    NOT NULL PRIMARY KEY,
  line_item_id                 TEXT    NOT NULL,
  original_adjudication_id     TEXT    NOT NULL,
  resolved_adjudication_id     TEXT,                          -- NULL while OPEN
  reason                       TEXT    NOT NULL,
  corrected_prior_auth_present INTEGER,
  corrected_service_code       TEXT,
  corrected_billed_cents       INTEGER,
  corrected_units              INTEGER,
  outcome                      TEXT,                          -- NULL while OPEN
  state                        TEXT    NOT NULL DEFAULT 'OPEN',
  opened_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at                  TEXT,                          -- NULL while OPEN
  CONSTRAINT fk_disputes_line_item
    FOREIGN KEY (line_item_id) REFERENCES line_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- composite FKs anchor both adjudications to THIS line (review finding #2-critical):
  CONSTRAINT fk_disputes_original_adj
    FOREIGN KEY (original_adjudication_id, line_item_id)
    REFERENCES adjudications(id, line_item_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_disputes_resolved_adj
    FOREIGN KEY (resolved_adjudication_id, line_item_id)
    REFERENCES adjudications(id, line_item_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT ck_disputes_state   CHECK (state IN ('OPEN','RESOLVED')),
  CONSTRAINT ck_disputes_outcome CHECK (outcome IS NULL OR outcome IN ('UPHELD','OVERTURNED','PARTIALLY_OVERTURNED','MODIFIED')),
  CONSTRAINT ck_disputes_corr_pa   CHECK (corrected_prior_auth_present IS NULL OR corrected_prior_auth_present IN (0,1)),
  CONSTRAINT ck_disputes_corr_bill CHECK (corrected_billed_cents IS NULL OR corrected_billed_cents > 0),
  CONSTRAINT ck_disputes_corr_unit CHECK (corrected_units        IS NULL OR corrected_units        > 0),
  -- corrected_service_code: free text (mirrors line_items.service_code) — no catalog CHECK;
  -- a correction to an unlisted code re-adjudicates to NO_COVERAGE, never an intake/DB reject.
  -- state coherence: OPEN has no resolution; RESOLVED is fully populated:
  CONSTRAINT ck_disputes_state_shape CHECK (
       (state = 'OPEN'     AND resolved_adjudication_id IS NULL     AND outcome IS NULL     AND resolved_at IS NULL)
    OR (state = 'RESOLVED' AND resolved_adjudication_id IS NOT NULL  AND outcome IS NOT NULL  AND resolved_at IS NOT NULL)
  )
) STRICT;

-- at most one OPEN dispute per (line, challenged decision) (review finding #dup-open):
CREATE UNIQUE INDEX uq_dispute_open
  ON disputes(line_item_id, original_adjudication_id) WHERE state = 'OPEN';

-- =====================================================================
-- 9) status_transitions — APPEND-ONLY polymorphic audit log.
--    claim_id is ALWAYS set (the owning claim aggregate); line_item_id is set
--    only for LINE_ITEM rows. seq is a SINGLE monotonic clock per claim aggregate,
--    so the merged GET /claims/:id timeline has a total order (review finding #timeline-order).
-- =====================================================================
CREATE TABLE status_transitions (
  id           TEXT    NOT NULL PRIMARY KEY,
  entity_type  TEXT    NOT NULL,
  claim_id     TEXT    NOT NULL,                     -- owning claim aggregate; always set
  line_item_id TEXT,                                 -- set iff entity_type='LINE_ITEM'
  from_status  TEXT,
  to_status    TEXT    NOT NULL,
  actor        TEXT    NOT NULL,
  reason       TEXT    NOT NULL,
  seq          INTEGER NOT NULL,                     -- claim-aggregate logical clock
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_st_claim
    FOREIGN KEY (claim_id)     REFERENCES claims(id)     ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_st_line_item
    FOREIGN KEY (line_item_id) REFERENCES line_items(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT ck_st_entity_type CHECK (entity_type IN ('CLAIM','LINE_ITEM')),
  CONSTRAINT ck_st_actor       CHECK (actor       IN ('SYSTEM','MEMBER')),
  CONSTRAINT ck_st_reason      CHECK (reason      IN ('SUBMIT','ADJUDICATED','AGGREGATED','DISPUTE_REOPEN')),
  CONSTRAINT ck_st_seq_pos     CHECK (seq > 0),
  -- exactly-one polymorphic target, keyed by discriminant (claim_id always present):
  CONSTRAINT ck_st_polymorphic CHECK (
       (entity_type = 'CLAIM'     AND line_item_id IS NULL)
    OR (entity_type = 'LINE_ITEM' AND line_item_id IS NOT NULL)
  ),
  -- one monotonic clock per claim aggregate => total order over the merged timeline:
  CONSTRAINT uq_st_claim_seq UNIQUE (claim_id, seq)
) STRICT;

-- =====================================================================
-- INDEXES — one per real access path.
-- =====================================================================
CREATE INDEX idx_claims_member_id       ON claims(member_id);            -- claims by member
CREATE INDEX idx_claims_policy_id       ON claims(policy_id);            -- claims under a policy
CREATE INDEX idx_line_items_claim_id    ON line_items(claim_id);         -- assemble claim -> lines
CREATE INDEX idx_line_items_fingerprint ON line_items(fingerprint);      -- duplicate detection
CREATE INDEX idx_adjudications_line     ON adjudications(line_item_id);  -- adjudication history per line
-- current-decision lookup (MAX(seq) per line) served by composite:
CREATE INDEX idx_adjudications_line_seq ON adjudications(line_item_id, seq);
CREATE INDEX idx_disputes_line_id       ON disputes(line_item_id);       -- disputes[] per line
-- merged timeline read, ordered by the claim-aggregate clock:
CREATE INDEX idx_st_claim_seq           ON status_transitions(claim_id, seq);
CREATE INDEX idx_st_line                ON status_transitions(line_item_id) WHERE entity_type = 'LINE_ITEM';
-- coverage match (policy_id, service_code) already served by uq_coverage_rules_policy_service.
-- accumulator point lookup already served by uq_accumulators_member_year_dim.

-- =====================================================================
-- APPEND-ONLY ENFORCEMENT — adjudications + status_transitions.
-- BEFORE UPDATE / DELETE / INSERT triggers RAISE(ABORT).
-- The BEFORE INSERT existence-check closes the INSERT OR REPLACE / REPLACE gap:
-- REPLACE silently deletes the conflicting PK row WITHOUT firing BEFORE DELETE,
-- so a same-PK insert must be rejected explicitly (review finding #1-critical).
-- =====================================================================
CREATE TRIGGER trg_adjudications_no_update
BEFORE UPDATE ON adjudications
BEGIN
  SELECT RAISE(ABORT, 'adjudications is append-only: UPDATE forbidden');
END;

CREATE TRIGGER trg_adjudications_no_delete
BEFORE DELETE ON adjudications
BEGIN
  SELECT RAISE(ABORT, 'adjudications is append-only: DELETE forbidden');
END;

-- closes REPLACE / INSERT OR REPLACE overwrite path:
CREATE TRIGGER trg_adjudications_no_overwrite
BEFORE INSERT ON adjudications
WHEN EXISTS (SELECT 1 FROM adjudications WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM adjudications WHERE line_item_id = NEW.line_item_id AND seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'adjudications is append-only: REPLACE/overwrite forbidden');
END;

CREATE TRIGGER trg_status_transitions_no_update
BEFORE UPDATE ON status_transitions
BEGIN
  SELECT RAISE(ABORT, 'status_transitions is append-only: UPDATE forbidden');
END;

CREATE TRIGGER trg_status_transitions_no_delete
BEFORE DELETE ON status_transitions
BEGIN
  SELECT RAISE(ABORT, 'status_transitions is append-only: DELETE forbidden');
END;

CREATE TRIGGER trg_status_transitions_no_overwrite
BEFORE INSERT ON status_transitions
WHEN EXISTS (SELECT 1 FROM status_transitions WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM status_transitions WHERE claim_id = NEW.claim_id AND seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'status_transitions is append-only: REPLACE/overwrite forbidden');
END;

-- =====================================================================
-- DISPUTE CROSS-ROW ORDERING — resolved decision must supersede the original.
-- The same-line anchoring is already enforced by the composite FKs above;
-- this closes the seq-ordering loophole (review finding #seq-order).
-- =====================================================================
CREATE TRIGGER trg_disputes_resolved_seq_insert
BEFORE INSERT ON disputes
WHEN NEW.resolved_adjudication_id IS NOT NULL
 AND (SELECT seq FROM adjudications WHERE id = NEW.resolved_adjudication_id)
   <= (SELECT seq FROM adjudications WHERE id = NEW.original_adjudication_id)
BEGIN
  SELECT RAISE(ABORT, 'dispute resolved_adjudication seq must exceed original_adjudication seq');
END;

CREATE TRIGGER trg_disputes_resolved_seq_update
BEFORE UPDATE OF resolved_adjudication_id ON disputes
WHEN NEW.resolved_adjudication_id IS NOT NULL
 AND (SELECT seq FROM adjudications WHERE id = NEW.resolved_adjudication_id)
   <= (SELECT seq FROM adjudications WHERE id = NEW.original_adjudication_id)
BEGIN
  SELECT RAISE(ABORT, 'dispute resolved_adjudication seq must exceed original_adjudication seq');
END;

-- =====================================================================
-- updated_at TOUCH — keep updated_at honest on the UPDATE-in-place tables
-- (claims, line_items, accumulators). Without this, updated_at depends on app
-- discipline and silently goes stale. The WHEN guard (NEW.updated_at = OLD.updated_at)
-- stops the trigger's own UPDATE from re-firing it, and leaves an explicit
-- app-supplied updated_at intact. (created_at is set once by its column DEFAULT.)
-- updated_at is wall-clock metadata — excluded from determinism comparisons (cycle 30).
-- =====================================================================
CREATE TRIGGER trg_claims_touch_updated_at
AFTER UPDATE ON claims
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE claims SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_line_items_touch_updated_at
AFTER UPDATE ON line_items
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE line_items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_accumulators_touch_updated_at
AFTER UPDATE ON accumulators
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE accumulators SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
END;
```

---

## Design decisions & rationale

### Dialect & STRICT tables
SQLite via better-sqlite3 + Drizzle is locked (decision #2; `connection.ts` / `drizzle.config.ts` stub comments confirm "better-sqlite3 + drizzle()" and "sqlite dialect"). All code is one-line stubs, so the docs are authoritative. Tables are `STRICT` (SQLite ≥ 3.37) so declared `TEXT`/`INTEGER`/`REAL` types are enforced rather than advisory affinity. `PRAGMA foreign_keys = ON` **must** run on every connection (better-sqlite3 defaults it OFF per-connection).

### Surrogate keys
Every table uses `id TEXT` (UUID v4, app-generated via `crypto.randomUUID`). Natural keys are mutable/compound (e.g. `policies(member_id,plan_year)`, `coverage_rules(policy_id,service_code)`); they are preserved as `UNIQUE` constraints, not PKs.

### Foreign keys & ON DELETE/UPDATE
`ON UPDATE CASCADE` everywhere (harmless — PKs are immutable UUIDs). `ON DELETE` per relationship: **RESTRICT** for audit/financial parents (`members`←policies/claims/accumulators, `line_items`←adjudications, `adjudications`←disputes); **CASCADE** for owned children (`policies`←coverage_rules, `claims`←line_items, `line_items`←disputes/status_transitions, `claims`←status_transitions). `claims.policy_id`→`policies` is RESTRICT (a policy under which claims were adjudicated must not vanish).

### Polymorphic strategy (`status_transitions`)
**Chosen:** two typed FK columns (`claim_id`, `line_item_id`) + `entity_type` discriminant + exactly-one CHECK. **Rejected** the single `entity_id` column because SQLite cannot FK one column to two tables — orphan transitions would be possible, defeating the audit log's integrity. The logical `entity_id` is `COALESCE(claim_id, line_item_id)` on read. **Refinement from review (timeline ordering, major):** `claim_id` is now **always** populated (even for `LINE_ITEM` rows it carries the owning claim), and `seq` is a **single monotonic clock per claim aggregate** rather than per-entity. This gives the merged `GET /claims/:id` timeline a **total order** — previously each entity's `seq` started at 1 and claim/line streams were mutually unorderable, and `created_at` (metadata-only) could not break the tie. `UNIQUE(claim_id, seq)` enforces the single clock; `claims.claim_seq` holds its head.

### Discriminated-union CHECKs (`coverage_rules`)
Two unions, each as discriminant + typed nullable columns + an exactly-shape CHECK. `cost_share`: `copay_cents` non-null iff `copay`, `coinsurance_rate` non-null iff `coinsurance`, both null for `full_coverage`. `limit`: `limit_amount_cents` non-null iff `dollars`, `limit_count` non-null iff `visits`, both null for `none`. Incoherent rules (a copay with a rate) are unrepresentable. `coverage_rules.covered`/`excluded` are kept as **distinct** booleans (NO_COVERAGE vs EXCLUDED are different pipeline paths); no `covered`/`excluded` cross-CHECK is added — an excluded rule's cost-share/limit columns are inert filler short-circuited at gate 3 before they are read, which is harmless and documented rather than constrained.

### Append-only mechanism (`adjudications`, `status_transitions`)
INSERT-only. Enforced three ways: (a) app discipline (repositories expose insert only); (b) `BEFORE UPDATE`/`BEFORE DELETE` triggers RAISE(ABORT); (c) **`BEFORE INSERT` existence-check trigger (review finding #1, critical)** that aborts when the PK — or the `(line_item_id, seq)` / `(claim_id, seq)` natural key — already exists. This closes the `INSERT OR REPLACE` / `REPLACE INTO` hole: REPLACE deletes the conflicting row **without** firing `BEFORE DELETE` and is **not** an UPDATE, so neither pre-existing trigger caught it; it could silently overwrite an immutable decision. The app must additionally never issue `INSERT OR REPLACE` on these tables. A migration that must touch them has to `DROP TRIGGER` first — intentional; the guarantee is the point.

### Current-adjudication resolution
Current decision = row with `MAX(seq)` per `line_item_id`. **No `is_current` flag** — a flag is a derived value that can drift under append-only. The composite index `idx_adjudications_line_seq` makes `MAX(seq)` O(log n). A dispute appends a **new** adjudication (higher `seq`); the original is never mutated. The composite FK + a cross-row trigger guarantee `resolved_adjudication_id.seq > original_adjudication_id.seq` (review finding #seq-order).

### Dispute cross-row coherence (review finding #2, critical)
**Relational fix adopted.** `adjudications` carries `UNIQUE(id, line_item_id)`; `disputes` declares **composite** FKs `(original_adjudication_id, line_item_id) -> adjudications(id, line_item_id)` and likewise for `resolved_adjudication_id`. This makes it impossible for a dispute on line L1 to reference an adjudication belonging to a different line — the prior plain FKs were individually satisfiable across lines and would corrupt the net-out invariant. A partial `UNIQUE(line_item_id, original_adjudication_id) WHERE state='OPEN'` enforces **at most one OPEN dispute per challenged decision** (review finding #dup-open), matching the synchronous open→resolve model.

### Claim↔Policy linkage & audit self-containment (review finding #4, major)
**Both** anchors recorded: `claims.policy_id` (FK→policies, RESTRICT) is resolved at intake, and `adjudications.plan_year` captures the **exact accumulator window** the immutable decision wrote to. The audit trail is now self-contained — you can reconstruct which policy/plan_year a decision drew its deductible/OOP/limit deltas from without re-deriving from `service_date`, and a dispute net-out anchors to recorded data even if a policy's dates were later corrected.

### `payable + member == billed` invariant (review finding #payable-sum, minor → applied)
`adjudications.billed_cents` snapshots the billed amount at decision time (it belongs on the immutable decision anyway — improves auditability), and `ck_adj_sum` enforces the core invariant in one row: `DENIED` ⇒ both 0; `APPROVED` ⇒ `payable + member = billed`. Previously this cross-row invariant could only live in app code/tests because `billed_cents` lived on `line_items`.

### Accumulator unit/column coherence (review finding #3, major)
`accumulators.unit` (`CENTS`|`COUNT`) discriminant added. `ck_acc_unit_dimension`: `DEDUCTIBLE`/`OOP` are always `CENTS` with `used_count = 0`; a `LIMIT:%` row picks exactly one column by `unit` (CENTS ⇒ `used_count=0`, COUNT ⇒ `used_cents=0`). This closes the hole where a visit-limit row could store dollars in `used_cents` and be silently misread as 0 visits used. Plan-year reset = **new rows** per `plan_year` (the `(member_id, plan_year, dimension)` uniqueness makes each year fresh), never in-place — prior-year totals are preserved for audit. `accumulators` is the **one** UPDATE-in-place table; immutable history lives in the adjudication deltas.

### service_code: catalog CHECK on coverage_rules, FREE TEXT on line_items (review finding #catalog — CORRECTED)
A reviewer pushed to constrain every `service_code` to the closed 12-entry catalog. That is correct for **`coverage_rules.service_code`** (seeded config — a rule should only exist for a known service), and the catalog CHECK stays there. It is **wrong for `line_items.service_code`** (and `disputes.corrected_service_code`): the locked spec is explicit that an unlisted code is *accepted* at intake and *denied* `NO_COVERAGE` at adjudication — **"never an intake reject"** (PRD.md:171; domain-model.md:66; the scenario-flowchart matrix row *"Service code not in catalog → `NO_COVERAGE` at adjudication, HTTP 200"*). A DB `CHECK` on `line_items.service_code` would fail the intake `INSERT` for an unlisted code, turning an adjudication **decision** (`NO_COVERAGE`, HTTP 200, with an explanation) into a structural **error** (HTTP 4xx) — violating the decision-vs-error boundary and the "explain WHY denied" capability the brief rewards. So `line_items.service_code` is **free text (NOT NULL, no catalog CHECK)**; coverage is a `(policy_id, service_code)` lookup against `coverage_rules`, and `NO_COVERAGE` covers *both* an unlisted code *and* a catalog code with no matching rule on the policy. Decision #10's "closed catalog" governs what gets a *coverage rule*, not what intake *accepts*.

### PHI
`members.name`/`dob`, `claims.provider`/`diagnosis_code` are PHI, isolated to member/claim records; the adjudication engine input is typed to exclude them (keys on `member_id` → policy + accumulators), so it **structurally** never reads them. SQLite has no native column encryption; documented approach is SQLCipher whole-file encryption-at-rest or app-level field encryption before insert.

### Date format guards (review finding #date-fmt, minor → applied)
Logic-driving date columns (`policies.effective_date`/`termination_date`, `claims.service_date`) carry `GLOB '____-__-__'` CHECKs. STRICT enforces TEXT affinity only, not format; the policy-active gate compares dates lexically, which is correct **only** for well-formed zero-padded ISO dates — so well-formedness is now a constraint, not an assumption. (Timestamp columns remain unguarded for brevity; they are metadata or app-set ISO strings.)

### reasons_json (review finding #reasons-1NF, minor → hardened, kept as JSON)
Stored as an ordered JSON `ReasonCode[]` (dominant first), `CHECK (json_type = 'array' AND json_array_length >= 1)` — strengthened beyond `json_valid` to guarantee a non-empty array. The closed `ReasonCode` enum membership is enforced in the zod/app layer (`src/domain/reason-codes.ts`); SQLite cannot CHECK every array element without a recursive trigger. A child `adjudication_reasons` table was considered and **rejected** for v1: it adds a join + ordinal column for a small, immutable, always-read-together array. Documented compromise; promote to a child table only if pure-relational queryability by reason code is required.

### Normalization
3NF/BCNF: rules (static config), facts (claims/line_items), memory (accumulators), and decisions (adjudications) are cleanly separated. The two discriminated unions are vertically decomposed into discriminant + typed columns (not a sub-table — over-normalizing a closed 3-variant union adds joins for no benefit; the CHECK guarantees coherence). The only persisted derived values are `claims.status` / `line_items.status` (documented source of truth, not event-sourced); `status_transitions` is a parallel audit trail and accumulator values are running totals. `reasons_json` is the one deliberate 1NF compromise (above).

### Policy CHECKs beyond spec (review finding #policy-checks, minor → kept)
`oop_max_cents >= deductible_cents` and `effective_date <= termination_date` encode real domain invariants. The standard seed plan ($500 deductible / $3000 OOP) satisfies them. Kept as hard CHECKs; if any in-scope plan ever violates `oop >= deductible`, relax to an app-layer assertion.

---

## Enum value sets

| Enum (column) | Full value set |
|---|---|
| `claims.status` | `SUBMITTED`, `UNDER_REVIEW`, `APPROVED`, `PARTIALLY_APPROVED`, `DENIED` |
| `line_items.status` | `PENDING`, `APPROVED`, `DENIED`, `NEEDS_REVIEW` (no `PARTIALLY_APPROVED` — claim-only; no `PAID` in v1) |
| `adjudications.status` | `APPROVED`, `DENIED` (a decision records a concrete line outcome; `PENDING`/`NEEDS_REVIEW` are lifecycle states, not decision outcomes) |
| `coverage_rules.cost_share_type` | `full_coverage`, `copay`, `coinsurance` |
| `coverage_rules.limit_unit` | `none`, `dollars`, `visits` |
| `service_code` (**`coverage_rules` only** — CHECK-enforced; `line_items` / `disputes.corrected_service_code` are free text) | `PREVENTIVE`, `PCP_VISIT`, `SPECIALIST_VISIT`, `URGENT_CARE`, `EMERGENCY_ROOM`, `LAB`, `MRI`, `OUTPATIENT_SURGERY`, `INPATIENT_HOSPITAL`, `PHYSICAL_THERAPY`, `CHIROPRACTIC`, `ADULT_DENTAL` (closed 12) |
| `accumulators.unit` | `CENTS`, `COUNT` |
| `accumulators.dimension` | `DEDUCTIBLE`, `OOP`, `LIMIT:<service_code>` (structural, not a fixed CHECK — free suffix) |
| `disputes.outcome` | `UPHELD`, `OVERTURNED`, `PARTIALLY_OVERTURNED`, `MODIFIED` (NULL while OPEN) |
| `disputes.state` | `OPEN`, `RESOLVED` |
| `status_transitions.entity_type` | `CLAIM`, `LINE_ITEM` |
| `status_transitions.actor` | `SYSTEM`, `MEMBER` |
| `status_transitions.reason` | `SUBMIT`, `ADJUDICATED`, `AGGREGATED`, `DISPUTE_REOPEN` (coarse cause, NOT a ReasonCode) |
| `ReasonCode` (in `adjudications.reasons_json`; app/zod-enforced) | `APPROVED`, `NO_COVERAGE`, `EXCLUDED`, `LIMIT_EXCEEDED`, `DEDUCTIBLE_APPLIED`, `COPAY_APPLIED`, `COINSURANCE_APPLIED`, `OOP_MAX_REACHED`, `PRIOR_AUTH_REQUIRED`, `DUPLICATE_LINE_ITEM`, `POLICY_NOT_ACTIVE`, `DISPUTED_OVERRIDE` (v2-reserved, unused in v1) |

---

## Drizzle / zod mapping (snake_case DB ↔ camelCase TS)

DB snake_case maps 1:1 to domain camelCase. Drizzle column defs use the camelCase property name with the snake_case DB name; the two `coverage_rules` unions re-inflate to TS discriminated unions in the rule loader; `reasons_json` re-inflates to `ReasonCode[]`.

| DB column | TS property |
|---|---|
| `member_id` | `memberId` |
| `policy_id` | `policyId` |
| `plan_year` | `planYear` |
| `effective_date` / `termination_date` | `effectiveDate` / `terminationDate` |
| `deductible_cents` / `oop_max_cents` | `deductibleCents` / `oopMaxCents` |
| `service_code` | `serviceCode` |
| `cost_share_type` | `costShare.type` |
| `copay_cents` | `costShare.copayCents` |
| `coinsurance_rate` | `costShare.rate` |
| `applies_deductible` | `appliesDeductible` |
| `limit_unit` | `limit.unit` |
| `limit_amount_cents` | `limit.amountCents` |
| `limit_count` | `limit.count` |
| `requires_prior_auth` | `requiresPriorAuth` |
| `service_date` | `serviceDate` |
| `diagnosis_code` | `diagnosisCode` |
| `billed_cents` | `billedCents` |
| `prior_auth_present` | `priorAuthPresent` |
| `payable_cents` | `payableCents` |
| `member_responsibility_cents` | `memberResponsibilityCents` |
| `reasons_json` | `reasons` (`ReasonCode[]`) |
| `delta_deductible_inc_cents` / `delta_oop_inc_cents` / `delta_limit_inc` | `deltas.deductibleIncCents` / `deltas.oopIncCents` / `deltas.limitInc` |
| `used_cents` / `used_count` / `unit` | `usedCents` / `usedCount` / `unit` |
| `original_adjudication_id` / `resolved_adjudication_id` | `originalAdjudicationId` / `resolvedAdjudicationId` |
| `corrected_prior_auth_present` / `corrected_service_code` / `corrected_billed_cents` / `corrected_units` | `corrected.priorAuthPresent` / `corrected.serviceCode` / `corrected.billedCents` / `corrected.units` |
| `entity_type` / `from_status` / `to_status` | `entityType` / `fromStatus` / `toStatus` |
| `claim_seq` / `seq` | `claimSeq` / `seq` |

> `status_transitions` exposes a uniform `entityId = COALESCE(line_item_id, claim_id)` on read so app code matches the logical single-`entity_id` contract in decision #15, while the DB keeps two real FKs for referential integrity.

---

## v1 scope & SQLite limitations

- **Concurrency.** better-sqlite3 is synchronous single-writer; no real concurrency story. Adjudication writeback is one transaction per claim — deterministic, no interleaving. Called out as a demo limitation (decision #2).
- **Column encryption.** SQLite has no native column encryption. PHI is protected via SQLCipher (whole-file) or app-level field encryption; demonstrated in stance, not over-built.
- **UUIDs are app-side.** No DB UUID generator; all `id`s are `crypto.randomUUID()` `TEXT`.
- **STRICT requires SQLite ≥ 3.37** (bundled in current better-sqlite3). On older engines drop `STRICT` — CHECKs still hold, affinity becomes advisory.
- **`reasons_json` enum membership** is app/zod-enforced, not DB-enforced (SQLite can't CHECK array elements without a recursive trigger). DB guarantees only non-empty-array shape.
- **REPLACE discipline.** Append-only is defended by triggers including a `BEFORE INSERT` existence check, but the app must still never issue `INSERT OR REPLACE` on `adjudications` / `status_transitions`.
- **Dispute scope.** Single-line net-out (`current accumulator − this line's original deltas`); intervening sibling / cross-claim lines are not cascaded (documented v1 limitation, decision #16).
- **No `PAID` state / settle action** (decision #14); lifecycle ends at `APPROVED`/`PARTIALLY_APPROVED`/`DENIED`. The transition log has the slot for a future `PAID`.
- **Status-machine transition guards** (legal-transition allow-lists) live in the app `setStatus()` chokepoint (C4), not the DB. The DB enforces enum membership and append-only history, not the legality of a given `from → to` move.
- **Multi-edge ER rendering.** Mermaid `erDiagram` collapses the two `disputes → adjudications` FKs to a single visual edge; the DDL carries both (see diagram note).
```
