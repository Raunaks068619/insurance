# Problem-Statement Coverage Analysis — Scenario Flowchart

> Scope: judges whether the problem-statement questions/problems are FULFILLED and visually SHOWN in `docs/scenarios-flowchart.md` (5 Mermaid flowcharts + 45-row scenario coverage matrix); cross-references the design docs where a concern legitimately lives off-diagram.

## Headline verdict

**Yes — every problem-statement concern that *belongs* in a scenario flowchart is shown, and the rest is correctly delegated to the design docs.** Of 40 traced requirements: **19 are SHOWN** (fully drawn as nodes/branches), **5 are PARTIAL** (the decision-classification half is drawn; the human-readable/text-generation half is doc-side), and **16 are N/A for a flowchart** (structural, security, interface, or process deliverables that a behavioral flowchart cannot and should not depict).

**Zero true gaps.** No requirement that *should* appear in a flowchart is missing. The 5 PARTIALs all share one root cause (explanation **reason codes** are shown; explanation **text/EOB builder** is doc-side) and one deliberate divergence (the brief's literal `PAID` lifecycle state is intentionally not modeled — decision #14). The trace and the adversarial verifier **agreed on all 40 rows**; there are no disagreements to flag.

## Traceability matrix

| ID | Requirement | Category | Flowchart verdict | Evidence (diagram / node) | Also covered in |
|---|---|---|---|---|---|
| Q1 | Model coverage rules (service type X covered up to $Y/yr) | interesting-problem | N/A_FLOWCHART | FC2 only *consults* rule fields: Step 2 "Rule exists for serviceCode?", Step 3 "Covered && !excluded?", Step 5 limit gates, Step 7 "Cost-share switch on costShare.type" — never depicts rule structure/storage | domain-model.md:80-108; erd.md:37-49,140-176; PRD.md:87-108; decisions.md #3,#6,#7 |
| Q2 | Track what's already used against limits | interesting-problem | SHOWN | FC2 Step 5 reads prior usage (VISCHECK `used_count<count`, DOLCHECK `used_cents<amountCents`); Step 9 writeback `deltas.limit_inc`; Step 7b straddle; matrix CROSS-LINE rows + Axiom 3 (accrual) | adjudication-plan.md:122-137; domain-model.md:25; erd.md ACCUMULATOR |
| Q3 | Mixed-outcome aggregation (3 covered/1 denied/1 review) | interesting-problem | SHOWN | FC3 CHECK1 (any NEEDS_REVIEW/disputed → UNDER_REVIEW) precedes CHECK2/CHECK3; PARTIAL node catches approved+denied mix; matrix AGGREGATION:* rows | domain-model.md:168-175; adjudication-plan.md:86-97 |
| Q4 | Explain WHY something was denied | interesting-problem | PARTIAL | FC2 emits a reason code at every terminal node; matrix has Reason Code(s) column. Missing: human-readable EOB text builder / `/explanation` endpoint (no node) | adjudication-plan.md:34-42,99-109; domain-model.md:228-236; PRD.md:42,64 |
| Q5 | State machine of claim vs. line item (two lifecycles) | interesting-problem | SHOWN | FC5 distinguishes `CLAIM:` and `LINE_ITEM:` transition chains explicitly; FC3 derives claim status; PARTIALLY_APPROVED noted claim-level-only | domain-model.md:140-166; erd.md:182-187 |
| WS1 | Accept claim submissions with line items | working-system-capability | SHOWN | FC1 START → VALIDATE ("≥1 line item") → PERSIST (Claim=SUBMITTED, LineItems=PENDING) → 200 | PRD.md:37,174-180; domain-model.md:71-78 |
| WS2 | Apply coverage rules → payable amounts | working-system-capability | SHOWN | FC2 Steps 6-9: allowed=billed, cost-share switch (FC/COPAY/COINS), APPROVED node `payable_cents`/`member_resp_cents` | adjudication-plan.md:47-84; PRD.md:39 |
| WS3 | Move claims through lifecycle states | working-system-capability | SHOWN | FC5 null→SUBMITTED→terminal + dispute reopen; FC3 aggregation to terminal | domain-model.md:140-166; PRD.md:40 |
| WS4 | Produce explanations for every decision | working-system-capability | PARTIAL | Reason code at every FC2 terminal node + matrix column. Missing: explanation-text generation | adjudication-plan.md:34-42,99-109; PRD.md:42,64,83 |
| WS5 | Demonstration interface (REST/UI/CLI — pick one) | working-system-capability | N/A_FLOWCHART | Interface choice is system-design, not a flow. FC1/FC4 only annotate HTTP 200/400/404/409/4xx as a side effect | decisions.md #5 (REST/fastify); PRD.md:58-69 |
| SCOPE1 | Submitting a claim with line items | in-scope-item | SHOWN | FC1 end-to-end: VALIDATE → RESOLVE → FP → PERSIST | PRD.md:174-185; domain-model.md:71-78 |
| SCOPE2 | Adjudicate each line item vs. coverage rules | in-scope-item | SHOWN | FC2 = 9-step pipeline (STEP0–STEP9) short-circuiting to DENY_END | adjudication-plan.md:47-84; PRD.md:38 |
| SCOPE3 | Track claim + line-item states through lifecycle | in-scope-item | SHOWN | FC5 audit log (CLAIM + LINE_ITEM rows) + FC3 derivation | domain-model.md:140-196; adjudication-plan.md:238-260 |
| SCOPE4 | Produce explanations for coverage decisions | in-scope-item | PARTIAL | Reason codes per decision (FC2 + matrix); text builder doc-side | adjudication-plan.md:34-42,99-109; PRD.md:42,64 |
| SCOPE5 | Members disputing decisions | in-scope-item | SHOWN | FC4 full re-adjudication (GUARD1/2, OVERLAY, NET_OUT, RERUN, UPHELD/OVERTURNED/PARTIALLY_OVERTURNED/MODIFIED); FC5 DISPUTE_REOPEN | domain-model.md:198-226; decisions.md #16 |
| SIGNAL1 | Domain decomposition (model entities cleanly) | evaluation-signal | N/A_FLOWCHART | Flowcharts exercise entities behaviorally only; no entity/relationship/cardinality definition | domain-model.md:15-37; erd.md:7-122 |
| SIGNAL2 | Rule representation (structure coverage logic) | evaluation-signal | N/A_FLOWCHART | FC2 Step 7 switch + Step 5 unit branch show the union/limit being *applied*, not their declared structure | domain-model.md:80-108; erd.md:140-176; decisions.md #3,#6,#7 |
| SIGNAL3 | State management (model both lifecycles) | evaluation-signal | SHOWN | FC5 from/to/actor/reason transitions for both entities (TRANS_1..TRANS_7); FC3 derivation | domain-model.md:134-196; erd.md:111-121 |
| SIGNAL4 | Edge case — partial approvals | evaluation-signal | SHOWN | FC2 STEP7B STRADDLE (plan capped, shortfall→member, line stays APPROVED partial); FC3 PARTIAL node; matrix straddle + mix rows | adjudication-plan.md:61,92-97; decisions.md #16 |
| SIGNAL5 | Edge case — limit exhaustion | evaluation-signal | SHOWN | FC2 VISCHECK→VISLIM and DOLCHECK→DOLLIM (LIMIT_EXCEEDED, DENIED) + Step 7b straddle; matrix 3 limit rows | adjudication-plan.md:58,61,170-172 |
| SIGNAL6 | Edge case — retroactive changes | evaluation-signal | SHOWN | FC4 RERUN ("against CURRENT rules & working_acc"), NET_OUT, immutable-original PERSIST, MODIFIED outcome; Axioms #4,#5 (no cross-claim cascade = documented v1 limit) | adjudication-plan.md:262-313; decisions.md #16 |
| SIGNAL7 | Explanation capability (say WHY denied) | evaluation-signal | PARTIAL | Every FC2 denial node emits a WHY code; matrix column. Missing: human-readable WHY sentence/EOB | adjudication-plan.md:34-42,99-109; PRD.md:42,195 |
| FLOW1 | Member has policy with coverage rules/limits/deductibles | context-flow-step | N/A_FLOWCHART | Structural binding; flowcharts only consume policy (Step 1 active, Step 5 limits, Step 7 deductible draw) | domain-model.md:15-37,80-108; erd.md:9-49 |
| FLOW2 | Member incurs expense & submits claim with line items | context-flow-step | SHOWN | FC1 START + VALIDATE ("≥1 line item", `billedCents`) + PERSIST | PRD.md:37,174-180; domain-model.md:71-78 |
| FLOW3 | PHI sensitivity (member names, dx codes, provider) | context-flow-step | N/A_FLOWCHART | Data-handling/security concern; correctly absent from all 5 decision-logic flowcharts | domain-model.md:44-46,68; decisions.md #9; PRD.md:144-145,214 |
| FLOW4 | Adjudicate each line — covered? how much pay? | context-flow-step | SHOWN | FC2 Step 2/3 (covered) + Steps 6-9 (payable) | adjudication-plan.md:47-84; PRD.md:38-39 |
| FLOW5 | Lifecycle submitted→under_review→approved/denied→**PAID** | context-flow-step | PARTIAL | submitted→under_review→approved/denied SHOWN (FC5+FC3); literal **PAID** state absent from every node/edge/matrix row (deliberate — see divergences) | decisions.md #14; domain-model.md:136,161; PRD.md:40,218 |
| FLOW6 | Members can dispute decisions | context-flow-step | SHOWN | FC4 START "Member initiates dispute"; FC5 actor=MEMBER reason=DISPUTE_REOPEN | domain-model.md:198-226; decisions.md #16 |
| DEC1 | Decide: how to handle partial approvals | in-scope-item | SHOWN | FC2 STRADDLE node + FC3 PARTIALLY_APPROVED node (same as SIGNAL4) | adjudication-plan.md:61,92-97; decisions.md #16 |
| DEC2 | Decide: what states exist + how transitions work | in-scope-item | SHOWN | FC5 enumerated states + from/to/actor/reason mechanics; FC3 derivation | domain-model.md:140-196; decisions.md #14,#15 |
| PROC1 | Domain research | process-deliverable | N/A_FLOWCHART | Research *fruit* visible (FC2 denial taxonomy + 9-step order); research activity is doc/JSONL-side | ai-artifacts/02-domain-research/; decisions.md #6 |
| PROC2 | Tests written test-first encoding domain rules | process-deliverable | N/A_FLOWCHART | Proven by git + test files. Matrix is a strong behavioral test-spec blueprint (45 rows) but is not tests | adjudication-plan.md:146-204; git history |
| PROC3 | AI collaboration artifacts (raw JSONL logs) | process-deliverable | N/A_FLOWCHART | Submission artifact; cannot appear in a flowchart | ai-artifacts/ |
| PROC4 | Domain Model doc (entities/relationships/state machines) | process-deliverable | N/A_FLOWCHART | FC5/FC3 visualize the state-machine slice; entity/relationship definitions are doc-side | domain-model.md; erd.md |
| PROC5 | Decisions & Trade-offs doc | process-deliverable | N/A_FLOWCHART | Doc deliverable; only stray decision-number cross-refs in the flowchart | decisions.md; PRD.md:199-219 |
| PROC6 | Self-Review doc | process-deliverable | N/A_FLOWCHART | Doc deliverable; flowchart's documented v1 limitations (line 270, Axiom #5) feed it | docs/self-review.md |
| PROC7 | Working system + README run instructions | process-deliverable | N/A_FLOWCHART | Runtime/README concern | README.md |
| PROC8 | Incremental git commit history | process-deliverable | N/A_FLOWCHART | VCS/process concern; the FC5 audit log is the *domain* status trail, not VCS | .git/ history |
| NSPEC1 | Open choices: rule representation, schema, API, UI | process-deliverable | N/A_FLOWCHART | FC reveals applied logic + closed reason-code set only; representation/schema/API/UI choices are doc-side | decisions.md #3,#5,#6,#7; erd.md; PRD.md:58-69,87-108 |
| SCOPEOUT1 | Out of scope: auth, enrollment, dashboards, admin, multi-tenant | in-scope-item | N/A_FLOWCHART | Negative requirement — confirmed ABSENT from all 5 flowcharts; near-misses (prior_auth, actor=) are in-scope medical auth + audit attribution | PRD.md:45-56,67; problem_statement.md:67-74 |

## Gaps & partials (concerns that *could* live in a flowchart but don't, or only partly do)

The 5 PARTIALs are the only items where flowchart-eligible content is incomplete. There are **no NOT_SHOWN gaps**.

| ID(s) | Severity | What's missing on-diagram | Concrete recommendation |
|---|---|---|---|
| Q4 / WS4 / SCOPE4 / SIGNAL7 (same root cause) | **Low** | Reason **codes** are emitted at every FC2 terminal node and in the matrix, but the **explanation-text / EOB builder** (turning codes into a member-facing sentence) and the `/explanation` endpoint appear in no node. This is correctly a system/data concern living in adjudication-plan.md + PRD.md. | Optional, low-value: add a single trailing node to **Flowchart 2** after the terminal states — e.g. `EXPLAIN["Build explanation: map reason codes → EOB text"]` — purely to make the doc-side text-generation step visible as a downstream stage. Not required; the reason classifier (the flowchart-appropriate half) is already fully shown. |
| FLOW5 | **Low** (and partly a deliberate divergence — see below) | Within this file there is **no in-diagram annotation** that PAID is intentionally deferred; a reviewer reading only the flowchart sees PAID simply omitted. | Optional: add a footnote near **Flowchart 5** (e.g. "Terminal states are final for v1; PAID/payment lifecycle deferred — see decision #14") so the omission reads as deliberate without opening decisions.md. The behavioral lifecycle itself needs no new node. |

## Deliberate divergences from the problem statement (conscious trade-offs, NOT bugs)

- **`PAID` lifecycle state dropped (decision #14).** The brief literally names the arc `submitted → under_review → approved/denied → PAID`. The design **intentionally omits PAID** as a v2 deferral: payment/settlement is out of scope for v1, so the flowcharts correctly model only `SUBMITTED → {APPROVED | PARTIALLY_APPROVED | DENIED | UNDER_REVIEW}` as terminal. This is a documented trade-off (decisions.md #14; domain-model.md:136,161; erd.md:243; adjudication-plan.md:96,317; PRD.md:40,218), not an oversight. **Flag for reviewers:** the flowchart's terminal set deliberately differs from the brief's verbatim arc.
- **No cross-claim cascade on dispute (Axiom #5 / FC4 edge note).** Retroactive re-adjudication nets out the disputed line's own accumulator deltas but does **not** re-run intervening sibling lines across other claims. Explicitly labelled "documented v1 limitation" inside the flowchart file — a conscious scoping decision feeding self-review.
- **Original adjudication is immutable (Axiom #4 / FC4 PERSIST).** Re-adjudication appends a new Adjudication row rather than mutating the original — a deliberate audit-integrity choice, surfaced as a divergence from a naive "update in place" model.

## Items that are N/A for a flowchart — and where they ARE covered

A behavioral scenario flowchart depicts decision/aggregation/transition **logic**. The following 16 requirements are structural, security, interface, or process concerns that legitimately live elsewhere; their absence from the flowchart is **correct**, not a gap.

| Concern | Requirement(s) | Where it actually lives |
|---|---|---|
| Coverage-rule **representation/structure** (discriminated-union costShare, unit-typed limit) | Q1, SIGNAL2, NSPEC1 | domain-model.md:80-108; erd.md:140-176; decisions.md #3,#6,#7 |
| **Entity decomposition** (Member/Policy/CoverageRule/Claim/LineItem/Adjudication/Accumulator/Dispute/StatusTransition) | SIGNAL1, PROC4 | domain-model.md:15-37; erd.md:7-122 |
| **Member→Policy→Rule binding** (setup relationship) | FLOW1 | domain-model.md:15-37,80-108; erd.md:9-49 |
| **Interface / transport choice** (REST vs UI vs CLI) | WS5 | decisions.md #5; PRD.md:58-69 (HTTP codes in FC1/FC4 lightly imply REST) |
| **PHI sensitivity / security** (minimization, encryption-at-rest, engine isolation) | FLOW3 | domain-model.md:44-46,68; decisions.md #9; adjudication-plan.md:139-144; PRD.md:144-145,214 |
| **DB schema / API design / UI** (open design choices) | NSPEC1 | erd.md; PRD.md:58-69,87-108; decisions.md |
| **Process deliverables** (domain research, test-first discipline, JSONL logs, decisions doc, self-review, README, git history) | PROC1–PROC8 | ai-artifacts/; decisions.md; self-review.md; README.md; .git/ history; (matrix supports PROC2 as a test blueprint) |
| **Negative requirement** (out-of-scope features must be ABSENT) | SCOPEOUT1 | PRD.md:45-56,67 — verified absent across all 5 diagrams |
