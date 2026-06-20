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
  CONSTRAINT ck_policies_eff_fmt  CHECK (effective_date   GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT ck_policies_term_fmt CHECK (termination_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
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
  CONSTRAINT ck_claims_service_date_fmt CHECK (service_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
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
