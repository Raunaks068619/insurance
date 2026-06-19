# 02 — Domain research: claim intake structure & verifications

Synthesis of a web-research pass (2026-06-18) across **UnitedHealthcare, Cigna, Aetna**
member-claim pages + the **CMS-1500 / X12 837 standard** and clearinghouse edit literature
(Stedi, WEDI SNIP, Noridian crosswalk). Purpose: ground the C2 (intake) module in how real
payers take and verify claims. Raw multi-agent output in the session JSONL.

## The boundary the research confirms: REJECT ≠ DENY

> **Reject** = front-end / pre-adjudication refusal. The claim fails a technical or identity
> edit (bad syntax, missing/malformed field, unparseable amount/date, **unidentifiable
> member**, exact duplicate) and is bounced **before** adjudication. Never adjudicated, no
> EOB, **no appeal rights** — fix and resubmit.
> **Deny** = post-adjudication adverse decision. The claim was clean enough to process; the
> payer evaluated coverage and paid nothing/part (eligibility, prior-auth, limit, medical
> necessity, timely filing, cost-share). Reported on the EOB with reason codes, **carries
> appeal/dispute rights**.
> One-line rule (Stedi): *once a claim enters adjudication it can no longer be rejected,
> only denied.* Conflating them is the classic modeling mistake.

→ In our system: **C2 intake = the reject layer** (well-formedness + member existence);
**C3 adjudication = the deny layer** (per-line coverage). Note: `POLICY_NOT_ACTIVE` is a
**DENY**, not a reject — it's a coverage decision about a *real* member; only an
*unidentifiable* member is a reject.

## Canonical claim structure → what we keep

**Envelope (claim header)** — real payers carry member ID, patient name/DOB/relationship,
group/plan number, billing+rendering provider NPI/TaxID, COB/other-insurance, total charge,
frequency/resubmission code, prior-auth number, signatures/assignment-of-benefits.
**We keep only `member_id`.** Everything else is derived (policy), out of scope (COB,
assignment, provider/network), or PII we minimize (patient name). Total charge = *derived*
from line sum, never submitted (avoids a balancing-edit reject we don't need).

**Line item** — real payers carry CPT/HCPCS, DOS, charge, units, ICD diagnosis + pointer,
modifiers, place-of-service, rendering NPI.
**We keep `{ service_code, billed_cents, service_date, prior_auth_present }`.** Setting is
encoded in the service_code (EMERGENCY_ROOM, INPATIENT_HOSPITAL are distinct rules), so no
place-of-service field. **Diagnosis (ICD) is the single biggest deliberate omission** — v1
coverage keys off `service_code` alone; capturing Dx adds clinical PHI with zero math
effect. Upgrade path: add Dx *and* a medical-necessity rule together, never Dx alone.

## Verification taxonomy (sorted by layer)

**Intake — REJECT (well-formedness + identity; never adjudicated):**
- Required fields present & correctly typed (member_id, ≥1 line, service_code, valid date, amount) → **in scope**
- `billed_cents` non-negative integer; `service_date` real & not future → **in scope**
- `member_id` resolves to a known member (existence only) → **in scope** (fork #3)
- EDI/HIPAA 837 syntax (999/TA1), subscriber-name match → **out** (we take JSON, not X12; no name)

**Adjudication — DENY (coverage; carries dispute rights):**
- Policy active on DOS → `POLICY_NOT_ACTIVE` (step 1) · Covered/excluded → `EXCLUDED`/`NO_COVERAGE`
- Prior auth → `PRIOR_AUTH_REQUIRED` · Annual limit → `LIMIT_EXCEEDED` · Cost-share → payable split
- Medical necessity / NCCI / Dx-Px consistency → **out** (no ICD) · Timely filing → **out** (noted) · COB → **out**

## How the top-3 actually take member claims

All three are **reimbursement-model member self-filing** — the member files **only when the
provider doesn't** (out-of-network / foreign care); in-network providers bill electronically.

| Payer | Channels | Member reimbursement form |
|---|---|---|
| **UnitedHealthcare** | myuhc.com portal · mobile app · mail | "Direct Medical Reimbursement Form" + CMS-1500-style PDF |
| **Cigna** | myCigna portal/app · mail (primary) | "Medical Claim Form" 591692c + DMR form; 180-day filing |
| **Aetna** | Health.Aetna.com / app · mail · fax · phone | "Medical Benefits Request"; member ID on every receipt; 365-day filing |

The common gate everywhere: **member ID + itemized bill**. That maps exactly to our
`member_id` + line items.

## Recommendations on the 5 C2 forks

1. **Rejection model → `400`, never persist `REJECTED`** (research diverges from the earlier (c) lean). A reject by definition "never entered the system / no record / no appeal"; persisting a `REJECTED` Claim row contradicts that and bloats the frozen state machine. Both malformed shape *and* unknown-member → structured `4xx` (`{ errors: [{field, code, message}] }`). Want an audit trail of bad attempts? Log separately, not as Claim rows.
2. **PHI fields → do NOT capture diagnosis/provider in v1.** Line stays `{ service_code, billed_cents, service_date, prior_auth_present }`. Biggest deliberate divergence; flag in self-review.
3. **Member/policy split → existence = intake reject (`400` unknown member); active-on-DOS = adjudication `POLICY_NOT_ACTIVE`.** Two layers, don't let one leak into the other.
4. **Sync vs two-phase → one synchronous `POST /claims`**, but two separate functions inside it: `validateIntake()` (can only reject) → `adjudicate()` (can only deny). The real two-phase split exists only because EDI is async/batched — out of scope. One transaction, two visible logical stages.
5. **Duplicate → soft flag at adjudication** (`DUPLICATE_LINE_ITEM`, payable 0), fingerprint = `member_id + service_code + service_date + billed_cents`. Keeps it in the explainable/disputeable trail. Closes Q5. (Intake-level idempotency key = out-of-scope-but-noted.)

## Key citations

- Stedi — reject vs denial boundary (canonical)
- UHC / Cigna / Aetna member-claim pages + reimbursement forms
- CMS 837P ↔ CMS-1500 crosswalk (Noridian); WEDI SNIP edit levels; X12 277CA
