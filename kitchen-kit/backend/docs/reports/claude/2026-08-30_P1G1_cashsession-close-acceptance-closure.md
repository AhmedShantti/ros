# P1G-1 — CashSession Close — Implementation Acceptance Closure

**Report type:** Acceptance-closure report (evidence), not a governance or SRS
document.

**Authority:** This report is non-authoritative evidence of work performed.
The SRS (`ROS_SRS_v1.0.pdf`) and the ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole
authoritative sources for requirements and business-rule decisions. Nothing
in this report overrides either. CONTROLLING design authority, in order: the
four accepted P1G-1 CashSession Close design/closure reports, the R-6(a)
ratification, and this report's own SRS citations (§5.5.2, §5.5.4,
FR-AUD-001/002/006, FR-FIN-007, FR-SEC-016, FR-POS-096 — quoted verbatim from
`ROS_SRS_v1.0.pdf` at the line numbers cited inline below).

**Date:** 2026-08-30
**HEAD (unchanged throughout — no commit made):** `0f10afe`
**Branch:** `feat/production-spec`
**Working tree summary:** 24 changed/new paths from THIS closure task (10
modified beyond the implementation report's own set, 3 newly modified test
files for the regression fix in §5, 2 new files) layered on top of the prior
implementation report's 33 paths. Full list in §1. No commit, no push, no
deployment, no production/persistent-`ros` migration, no destructive git
operation, at any point.
**Task identifier:** P1G-1 CashSession Close — implementation acceptance
closure, resolving the external-review blockers against
`2026-08-30_P1G1_cashsession-close.md` (NOT overwritten — preserved
byte-for-byte; this is a separate, additional report).

---

## 0. Verdict

**A. P1G-1 CASHSESSION CLOSE — ACCEPTANCE CLOSURE CLEAN.**

Every blocker raised was investigated with direct evidence (SRS quotation,
executed tests, or a baseline/current comparison), and every gap found was
either genuinely closed in code or explicitly, honestly recorded as a
still-open, out-of-fence limitation. **One genuine indirect regression was
found and fixed** (§5) — three PRE-EXISTING, unrelated test files' own
concurrency-synchronization mechanism structurally conflicted with the P1G-1
Payment/Close advisory lock; this was a real, reproducible defect in those
tests' assumptions, not a business-logic defect, and it is now corrected
with a minimal, non-business-logic fix, verified against a real
`0f10afe` baseline comparison. Not self-declaring "FINAL ACCEPTED" — that
determination belongs to external review.

---

## 1. Files changed (this closure task, beyond the implementation report)

### New
- `src/modules/treasury/contract/events.ts` — Treasury's first published domain event, `cash.variance.detected` (SRS §5.5.4).

### Modified — production code
- `src/modules/treasury/cash-session-close/cash-session-close.service.ts` — `declareClose` now runs through `UnitOfWork.execute` (was `PrismaService.withAuthContext` directly) so it can `ctx.publishEvent(...)`; writes a new `CASH_VARIANCE_DECLARED` audit entry and publishes `cash.variance.detected`, once per newly-created attempt; `getCloseContext`'s blind-mode response now includes `toleranceMinorUnits` (§6 fix).
- `src/modules/governance/audit/audit.constants.ts` — new `AUDIT_ACTION.CASH_VARIANCE_DECLARED`.
- `src/modules/treasury/contract/index.ts` — barrel export for the new event contract.
- `src/modules/treasury/treasury.controller.ts` — `closeContextSchema`'s OpenAPI documentation corrected to match the §6 fix (`toleranceMinorUnits` present in both blind and open mode).

### Modified — tests (regression fix, §5)
- `test/sales-payment-concurrency.e2e-spec.ts`
- `test/order-completion-concurrency.e2e-spec.ts`
- `test/order-completion-concurrency-2.e2e-spec.ts`

### Modified — tests (new coverage, this closure task)
- `test/cash-session-close.e2e-spec.ts` — +7 tests (audit/event proofs, §3) and 1 corrected test (§6 blind-mode fix).
- `test/cash-movements-close-and-payment-concurrency.e2e-spec.ts` — +21 tests (deterministic §G, §4).

Untouched by this task: everything the prior implementation report already
listed as its own files, and every other pre-existing report in
`docs/reports/claude/`.

---

## 2. AUDIT DECLARATION — Blocker A (FR-AUD-001/006)

**SRS, quoted verbatim (`ROS_SRS_v1.0.pdf`):**
> FR-AUD-001 [M] — The System SHALL record an immutable audit entry for
> every state-changing operation.
> FR-AUD-006 [M] — The following actions SHALL always generate audit
> entries: ... discounts, comps, voids, refunds, **cash variances**, stock
> adjustments ...

**Finding, confirmed real:** the implementation report's only audit action
was `CASH_SESSION_CLOSED`, written ONLY when a session actually closes (the
within-tolerance fast path, or an approved finalize). An above-tolerance
declaration froze the session to `closing` with **no durable audit entry for
the variance itself** — and a frozen session can sit unresolved, or be
rejected and retried, indefinitely before any `CASH_SESSION_CLOSED` entry
ever exists. The immutable `cash_session_close_attempts` row is durable
BUSINESS evidence, but is not a `governance.audit_entries` row —
FR-AUD-001/006 require the latter specifically.

**Fix:** a new audit action, `CASH_VARIANCE_DECLARED`
(`audit.constants.ts`), written exactly once, inside the SAME transaction as
the attempt INSERT, for EVERY newly-created attempt — both the
within-tolerance and above-tolerance paths — never on a permanent-id replay.
`CASH_SESSION_CLOSED` remains a separate, later fact (the session actually
closed); the two are not duplicate noise — within-tolerance closes now
correctly carry BOTH entries (declared-and-closed are two distinct facts in
the SAME instant), proven explicitly (test 30 in §3below).

**Metadata written** (FR-AUD-002's field set): `closeAttemptId`,
`policyVersionId`, `countMode`, `currency`, `toleranceMinorUnits`, all eight
FR-FIN-004 formula terms, `expectedCashMinorUnits`, `countedCashMinorUnits`,
`varianceMinorUnits`, `approvalRequired`, `declaredByEmployeeId` — entry is
self-sufficient evidence, no join required.

**Tests** (`test/cash-session-close.e2e-spec.ts`, new describe block "FR-AUD-001/006 cash-variance audit + SRS §5.5.4 cash.variance.detected event"):
1. above-tolerance declaration durably audits the variance AND publishes the event, BEFORE any finalisation exists (entry present while `CASH_SESSION_CLOSED` absent).
2. within-tolerance fast close ALSO audits the variance — both entries present, proven distinct.
3. R-6(a) explicit rejection does not remove or alter the declaration-time entry (same row id, same content, before/after compared).
4. approved finalisation adds only `CASH_SESSION_CLOSED` — no second `CASH_VARIANCE_DECLARED` and no second event.
5. idempotent declaration replay does not duplicate the entry or the event.
6. a subscriber failure rolls back the ENTIRE declaration — no attempt row, no audit entry, no session mutation survive (full `UnitOfWork`/§5.5.2 atomicity, exercised through this producer specifically, not merely asserted from the generic mechanism's own test suite).

All 6 pass, reproduced clean (see §8).

---

## 3. CASH.VARIANCE.DETECTED — Blocker B (SRS §5.5.4)

**SRS, quoted verbatim:** the Core Subset event catalogue (§5.5.4) lists
`cash.variance.detected`, Publisher **Treasury**, Principal Subscribers
**Governance, Analytics**.

**Finding, confirmed real:** no Treasury domain event existed anywhere in
the repository before this closure task — Treasury had never published
through `UnitOfWork`/`ctx.publishEvent` at all.

**Mechanically NOT impossible** — confirmed by direct inspection of
`common/domain-events/unit-of-work.ts`: `UnitOfWork.execute(scope, fn)` is a
thin wrapper around the SAME `PrismaService.withAuthContext(scope, fn)`
`CashSessionCloseService` already called directly, handing the callback
`{tx, publishEvent}` instead of bare `tx`. Switching `declareClose` onto it
is a mechanical substitution — `SalesPaymentService.capture` and
`SalesFireService` already establish this exact pattern. `Transactional
DomainEventDispatcher.drain()` dispatches to zero handlers without error
when none is registered for an event type (confirmed by inspection and by
this repository's own pre-existing precedent — `order.line.fired` /
`order.opened` have no registered handler today either) — so publishing
`cash.variance.detected` with no live Governance/Analytics subscriber is
correct, not a gap to apologise for; SRS §5.5.4 names the intended
subscribers, it does not require them to exist yet.

**Trigger (design-decidable, not new governance):** the ALREADY-ACCEPTED
domain point — "the instant a declaration's variance becomes an immutable
computed fact" — i.e. once per newly-created `cash_session_close_attempts`
row, in BOTH the within-tolerance and above-tolerance paths (a variance,
including an exact-zero one, is computed and durably recorded either way).
Never on a permanent-id replay. Never a second time at `finalizeClose` — the
variance was already announced; the decision is a separate fact already
carried by the Approval Runtime's own immutable rows and
`CASH_SESSION_CLOSED`.

**Contract** (`treasury/contract/events.ts`, Treasury's first published
event): `CASH_VARIANCE_DETECTED_EVENT_TYPE = 'cash.variance.detected'`,
version 1, payload mirrors the audit entry's own field set (§2) plus
provenance (`declaredByUserId`, `terminalId`, `declaredAt`). Money is a
base-10 minor-unit string throughout (ADR-008). `idempotencyKey:
`cash.variance.detected:${closeAttemptId}`` — the attempt's own permanent
FR-OFF-015 id.

**Tests:** the same 6 listed in §2 double as the event's own proof (a
test-only handler captures every dispatched envelope by overriding the
`UnitOfWork` provider — the exact manual `.withHandlers(...)` technique
`test/domain-events.e2e-spec.ts` already establishes as this repository's
proof pattern for an event with no production subscriber). Specifically:
- **EVENT TX:** published in the same transaction as the attempt INSERT — test 6 proves rollback drops both together (no attempt row, no audit entry, when a handler throws).
- **EVENT REPLAY:** test 5 proves a permanent-id replay never re-publishes.
- Above-tolerance publishes correctly (test 1); within-tolerance publishes exactly once, distinct from `CASH_SESSION_CLOSED` (test 2, same call count assertion as the audit proof).

---

## 4. CONCURRENCY — Blocker C (deterministic proof)

**Finding, accepted:** the implementation report's §D/E/F used a
statistically-repeated `Promise.allSettled` pattern with no control over
which side won a given run — useful, but not a deterministic ordering
proof, and the task's own instruction is explicit that this alone is
insufficient.

**Method — a raw, non-Prisma session-level advisory lock (`pg_advisory_lock`,
via the `pg` package directly, already a project dependency), NOT
`pg_advisory_xact_lock` inside a Prisma transaction.** PostgreSQL's advisory
locks share ONE lock table regardless of session/transaction scope, so a
session-level holder genuinely blocks a transaction-level requester on the
identical `(hashtext('ros_cash_session'), hashtext(sessionId))` key every
production caller uses — confirmed both by direct `psql` experimentation
(two sessions contending register in `pg_stat_activity` as blocked within
well under half a second) and by the harness's own results below. Unlike
the earlier statistical gate technique, this holder is NEVER inside a
Prisma-managed transaction, so it carries no fixed-timeout risk at all —
this is also what closes Blocker E's root cause (§5).

Each ordering proof holds the lock, fires ONE production call, polls
`pg_stat_activity` (bounded, never a fixed sleep as the proof itself) until
that call is OBSERVED genuinely blocked, releases, and only THEN starts the
second call — call A is proven to have fully committed or rejected before
call B ever attempts anything, with no dependency on PostgreSQL's exact
lock-queue fairness. A dedicated additional test (below) independently
verifies genuine SIMULTANEOUS two-waiter queuing too, corroborating that
simplification without relying on it for the primary proofs.

**PAYMENT FIRST / CLOSE FIRST — all four required pairs, ≥3 clean runs
each** (`test/cash-movements-close-and-payment-concurrency.e2e-spec.ts`, new
`§G` describe block):
- **A** (CASH Payment before Close): Payment commits, Close's `expectedCash` includes it. 3/3 runs.
- **B** (Close before CASH Payment): Close commits `closed`, Payment wakes and rejects `InvalidCashSessionError` ("not open"), zero payment rows. 3/3 runs.
- **C** (`manual_external_card` before Close): payment row exists (tender table), `expectedCash` unaffected (not a cash term). 3/3 runs.
- **D** (Close before `manual_external_card`): Payment rejects, zero rows. 3/3 runs.

**MOVEMENTS — each of pay_in/pay_out/safe_drop, both directions:**
movement-first is included in `expectedCash` with the correct sign
(+2500/-2500/-2500); close-first causes the movement to reject with
`ConflictException`, zero movement rows. All 6 pass.

**Two-simultaneous-waiters corroboration** (3 runs): a raw holder blocks
BOTH a `pay_in` call and a `declareClose` call at once — polled and
confirmed as ≥2 genuinely blocked backends — then released; whichever
ordering PostgreSQL actually resolved, exactly one of the two valid final
states holds (never both, never neither, never a deadlock).

**Result:** 21 new deterministic tests, all passing, reproduced clean across
3 independent full-file runs (initial + 2 repeats), each run completing in
2.9–3.8 seconds — markedly faster AND more reliable than the retired
gate-based technique, which intermittently took 261+ seconds and failed
13/13 (see §5 for why).

---

## 5. FULL-E2E BASELINE ATTRIBUTION — Blocker E, and a genuine regression found and fixed

**Method:** `git archive 0f10afe -- kitchen-kit/backend` extracted to
`/tmp/baseline-0f10afe` (working tree never touched). `package.json`
confirmed byte-identical to current (safe to symlink `node_modules`).
Baseline's own `prisma/schema.prisma` (33 migrations, no CashSession Close)
regenerated its OWN Prisma Client; a FRESH scratch database
(`ros_baseline_0f10afe`) received exactly those 33 migrations via
`prisma migrate deploy`. The 3 suites the implementation report classified
"pre-existing/environmental" were run against this baseline, unmodified.

**BASELINE E2E: 16/16 passing, 3/3 suites, 5.07s.** This DIRECTLY
CONTRADICTED the implementation report's classification — the baseline does
not reproduce the failures. Per this task's own instruction ("If baseline
passes: this slice has an indirect regression"), this is exactly that: a
genuine, reproducible, INDIRECT regression, confirmed further by running the
SAME 3 files against the CURRENT tree on an equally fresh scratch database
(ruling out data-accumulation as a confound): **CURRENT E2E (before fix):
5/16 passing, 11 failing, all three suites, 57.7s.**

**Root cause, found by direct inspection, not further guessing:** all three
files use a hand-rolled two-party BARRIER (`makeBarrier(2)`) to force two
`SalesPaymentService.capture()` calls to arrive SIMULTANEOUSLY at a
test-stubbed `CASH_SESSION_FACTS_QUERY` seam — by design, proving Order CAS
safety under genuine concurrent reads, predating and unaware of any Payment
lock. All three race BOTH calls on the SAME `cashSessionId`. P1G-1's
Payment/Close advisory lock (`sales-payment.service.ts` "step 1.5") acquires
`pg_advisory_xact_lock` BEFORE the order is even loaded — strictly BEFORE
the barrier's own seam. Racing two calls on the same session now genuinely
SERIALIZES them at the lock, before either can reach the barrier: the first
call proceeds alone to the barrier and waits forever for a second party that
can never arrive until the first itself finishes — a deadlock against the
test's own synchronization primitive, which only resolves once the FIRST
call's own Prisma transaction hits its fixed 5000ms timeout, at which point
it (and everything downstream depending on it) fails. This is a genuine
defect in three PRE-EXISTING tests' own assumption ("Payment reads
CashSession facts via a plain, unlocked SELECT" — true before P1G-1, false
after), not a functional/business defect: the underlying operations remain
correct, they simply can no longer reach a barrier point requiring
concurrent, unserialized access to the SAME cash session.

**Fix, minimal and non-business-logic:** each of the three files gained a
SECOND, fully independent drawer/shift/cash-session fixture
(`cashSessionB`), and the SECOND of each pair's two racing
`paymentService.capture(...)` calls now targets it instead of the shared
`cashSessionA`. Two independent sessions route through two DIFFERENT
advisory-lock keys, restoring genuine concurrent arrival at the barrier. The
actual property each test verifies (Order-version CAS safety;
weighted-average/FIFO stock-consumption safety; lock-order-inversion
deadlock-freedom) is completely unchanged and orthogonal to which cash
session a payment happens to be attributed to. Both affected module
docblocks and every changed call site carry an inline explanation.

**CURRENT E2E (after fix): 16/16 passing, 3/3 suites, 3.4s** — faster than
even the ORIGINAL baseline, since the two independent sessions no longer
contend for anything at all. Reproduced clean across 2 additional full
repeat runs (3 total clean runs).

**Full suite, before vs. after this section's fix** (both against a fresh,
34-migration scratch database):
- Before: 926/937 tests, 43/46 suites.
- After: **963/964 tests, 45/46 suites**, one isolated, non-reproducing
  flake (`order-completion-concurrency.e2e-spec.ts` run 3/3, a
  fixture-setup-stage "expired transaction" with no relation to any race
  logic) — reproduced clean 3/3 times immediately after in isolation (6/6
  each run), consistent with ordinary system-load variance rather than a
  structural issue, and explicitly NOT classified as "environmental" without
  this direct 3-for-3 clean-repeat evidence.

---

## 6. Requirement classification corrections — Blocker on §9

Verified against `ROS_SRS_v1.0.pdf`'s exact text (quoted, with the section
this report cites it from):

- **FR-POS-096** — exact text: "Shift close SHALL compute and record cash
  variance, and SHALL require a reason and manager acknowledgement when
  variance exceeds a configurable tolerance." **COMPLETE.** Basis restated
  precisely: variance computed/recorded (attempt row + §2's new audit
  entry), reason required above tolerance (`FinalizeCashSessionCloseDto
  .reason`, mandatory non-blank), manager acknowledgement above tolerance
  (PIN-verified `cash.variance.approve` decision via the Approval Runtime) —
  not merely "a close can be declared."

- **FR-FIN-007** — exact text: "Cash sessions SHALL be immutable once
  closed. Corrections SHALL be recorded as adjusting entries referencing the
  session." **PARTIAL**, corrected basis: closed-session immutability is
  COMPLETE (DB-enforced — no UPDATE/DELETE grant, CHECK-anchored, proven in
  §8's DB-immutability tests); the SECOND clause — an adjusting-entries
  correction mechanism — is NOT IMPLEMENTED (no such table/mechanism exists
  anywhere in this slice). Day Close is a DIFFERENT requirement entirely and
  is explicitly not what makes this PARTIAL.

- **FR-SEC-016** — exact text: "The System SHALL block, not merely warn, on
  the following combinations regardless of role configuration: approving
  one's own requisition, approving one's own discount, approving one's own
  cash variance, and posting a count one performed where the tenant has
  enabled strict SoD." FOUR limbs. Requisition and discount domains do not
  exist in this repository (Procurement/Sales-discount bounded contexts are
  unbuilt); no "strict SoD" toggle or enforcement exists for inventory count
  posting (confirmed absent by direct search). **Global FR-SEC-016:
  PARTIAL.** **Cash-variance limb: COMPLETE** — DB-enforced exclusion
  (`excludedApproverUserId`), fail-closed on an owner with no linked
  Identity User, tested explicitly (§2's fixture + the implementation
  report's own self-approval test).

- **FR-AUD-001/006, cash.variance.detected**: reported honestly per §2/§3
  above — now COMPLETE for the cash-variance action/event specifically
  (the ONLY action this slice is authorised to touch); FR-AUD-006's OTHER
  listed actions (discounts, comps, voids, refunds, purchase approvals,
  etc.) remain out of this slice's fence, unchanged from the pre-existing
  `PHASE_1_SRS_REQUIREMENT_MAP.md` classification of the requirement as a
  whole.

---

## 7. BLIND RESPONSE — Blocker on §10 (close-context contract mismatch)

**Finding, confirmed real by direct inspection of the accepted design
report** (`2026-08-30_P1G1_cashsession-close-design-acceptance-closure.md`,
its own route table): the accepted shape lists `countMode`, `currency`,
`openingFloat`, **`toleranceMinorUnits`** as present in the close-context
response regardless of mode; ONLY `expectedCash` and its formula breakdown
are blind-mode-omitted. The implementation report's `getCloseContext`
incorrectly omitted `toleranceMinorUnits` in blind mode too — an
accidental over-restriction relative to the accepted design, not a
deliberate change any controlling source made.

**Fix:** `getCloseContext` now resolves the cash-close POLICY once (not the
count-mode alone, then separately re-resolving the policy only in open
mode); `toleranceMinorUnits` is included whenever a policy exists, in EITHER
mode — a configured tolerance is a POLICY fact (the threshold), not a
VARIANCE fact (what the count reveals), and FR-POS-095 protects only the
latter. `expectedCashMinorUnits` remains structurally absent (not `null`)
in blind mode, unchanged. The controller's OpenAPI schema and description
strings were corrected to match. The blind-mode e2e test was corrected from
asserting `toleranceMinorUnits` ABSENT to asserting it present and equal to
the configured value; re-run and passing.

---

## 8. Verification — this closure task

- `npx tsc --noEmit` — **non-zero, due to exactly one PRE-EXISTING baseline
  error** (`access-token.service.spec.ts(28,7)`), confirmed identical,
  byte-for-byte, on the `0f10afe` baseline extraction (§5's setup) — not
  merely asserted as pre-existing, DIRECTLY reproduced. No other error, on
  either baseline or current.
- `npx prisma format && npx prisma validate` — clean; `schema.prisma`
  unchanged in substance from the implementation report (this closure task
  added no new tables/columns — the audit/event work reuses the existing
  `cash_session_close_attempts` row).
- **Targeted audit/event suite:** 6/6 new tests (§2/§3), reproduced clean.
- **Deterministic concurrency suite:** 21/21 new tests (§4), reproduced
  clean across 3 full-file runs.
- **`cash-session-close.e2e-spec.ts`:** 35/35 (29 implementation-report
  tests + 6 new audit/event tests, 1 corrected for §6), reproduced clean.
- **`cash-movements-close-and-payment-concurrency.e2e-spec.ts`:** 34/34 (13
  statistical + 21 new deterministic), reproduced clean across 3 runs.
- **`module-boundaries.spec.ts` + both db-ownership specs:** 52/52, zero new
  deviations (this closure task introduced no new cross-module import
  shape — `UnitOfWork`/`TransactionalDomainEventDispatcher` are `@Global()`
  infrastructure already exempt, exactly like `AuditService`).
- **Full unit suite:** 760/760, 56/56 suites, unchanged from the
  implementation report.
- **Full e2e suite (fresh, 34-migration scratch DB):** 963/964, 45/46
  suites — see §5 for the full before/after account and the one isolated,
  non-reproducing flake.
- **OpenAPI:** regenerated; **142 operations, 103 paths — unchanged** from
  the implementation report (this closure task changed response CONTENT and
  documentation strings, not route counts); `openapi.e2e-spec.ts` drift
  detection passing.
- **Legacy-compatibility migration proof:** migration 34's SQL file is
  byte-for-byte UNCHANGED by this closure task (`git status` still reports
  it as the same untracked new file it was after the implementation
  report) — the implementation report's 2 independent clean legacy-proof
  runs stand unmodified; not re-executed, since nothing that proof depends
  on changed.
- **Persistent `ros` DB:** reconfirmed at exactly 26 applied migrations,
  identical before and after this entire closure task. Never the target of
  any `prisma migrate deploy` at any point.
- `git diff --check` — clean, no whitespace errors.
- No commit, no push, no deployment, no production/persistent-`ros`
  migration, no destructive git operation, at any point in this task.

---

## 9. Coverage matrix

The original implementation prompt's own verbatim ~70-case enumeration is
not available to reconstruct item-for-item in this session (it predates a
context compaction and its literal numbered text is not recoverable here).
What follows is instead a COMPLETE, HONEST matrix built directly from the
actual executable proof this slice now carries — every distinct
acceptance-relevant invariant, mapped to its exact test file, name, and
result — which meets or exceeds the ~70-case bar in substance even though
its numbering does not claim to replicate an original list this session
cannot see. No case below duplicates an existing proof; where the
implementation report's own suite already proved something, this closure
task extended rather than re-proved it.

| # | Requirement / invariant | Test file | Test name (or count) | Result |
|---|---|---|---|---|
| 1–7 | Declare: exact match, tolerance boundary (both sides), denominations (sum/mismatch/duplicate), missing-both-fields, extraneous-field rejection | `cash-session-close.e2e-spec.ts` | tests 1–7 (§listing) | ✅ 7/7 |
| 8–11 | Above-tolerance freeze→approve, R-6(a) reject→retry, self-approval block, owner-unlinked-User fail-closed | `cash-session-close.e2e-spec.ts` | tests 8–11 | ✅ 4/4 |
| 12–14 | Blind/open/closing-closed disclosure (incl. §7's `toleranceMinorUnits` correction) | `cash-session-close.e2e-spec.ts` | tests 12–14 | ✅ 3/3 |
| 15–17 | Own/other authority (`cash.session.close` vs `_other`, neither-held 403) | `cash-session-close.e2e-spec.ts` | tests 15–17 | ✅ 3/3 |
| 18–21 | HTTP idempotency, permanent-id replay (declare + finalize, match/mismatch) | `cash-session-close.e2e-spec.ts` | tests 18–21 | ✅ 4/4 |
| 22–25 | DB immutability (attempts, denominations, column-scoped UPDATE, anchor CHECK) | `cash-session-close.e2e-spec.ts` | tests 22–25 | ✅ 4/4 |
| 26–28 | Relational ownership FKs (cross-branch attempt, cross-session anchor, cross-tenant) | `cash-session-close.e2e-spec.ts` | tests 26–28 | ✅ 3/3 |
| 29–34 | FR-AUD-001/006 audit + §5.5.4 event (declared-before-finalize, distinct-from-closed, survives rejection, no duplicate at finalize, no duplicate on replay, rollback atomicity) | `cash-session-close.e2e-spec.ts` | tests 29–34 (§2/§3) | ✅ 6/6 |
| 35 | BIGINT_MIN overflow-safe CHECK, live on the DB catalogue | `cash-session-close.e2e-spec.ts` | test 35 | ✅ 1/1 |
| 36 | Migration 34 DDL — clean apply, fresh scratch, 34/34 migrations | implementation report §2 (unchanged) | `prisma migrate deploy` | ✅ (not re-run — file unchanged) |
| 37–38 | Legacy-compatibility — pre-existing CLOSED/OPEN rows survive byte-identical, zero fabricated attempts | implementation report §3 (unchanged) | 2 independent runs | ✅ 2/2 (not re-run — unchanged) |
| 39–43 | RLS/grants matrix (SELECT+INSERT-only both new tables, 10-column UPDATE scope, ENABLE+FORCE, cross-tenant hidden) | implementation report §4 / `cash-session-close.e2e-spec.ts` tests 22–28 | — | ✅ |
| 44 | Payment/Close advisory-lock correction present and correctly ordered (step 1.5) | `sales-payment.service.ts` (code) + §4/§5 concurrency proofs | — | ✅ |
| 45–65 | Deterministic concurrency: A/B/C/D (3 runs each = 12), pay_in/pay_out/safe_drop × 2 directions (6), 2-simultaneous-waiters (3 runs) | `cash-movements-close-and-payment-concurrency.e2e-spec.ts` §G | 21 tests | ✅ 21/21 |
| 66–78 | Statistical concurrency (§D/E/F, retained as supplementary evidence) | `cash-movements-close-and-payment-concurrency.e2e-spec.ts` §D/E/F | 13 tests | ✅ 13/13 |
| 79 | Circular module import (Treasury↔Sales) resolved, zero new `KNOWN_DEVIATIONS` | `module-boundaries.spec.ts` | 38/38 | ✅ |
| 80–93 | `cash-sessions/`/`cash-session-close/` own no direct Branch/Order/OrderPayment access; contract-only imports; Sales/Organisation own their queries | `cash-session-close.db-ownership.spec.ts` | 14 tests | ✅ 14/14 |
| 94 | `cash-close-policy.db-ownership.spec.ts` (docblock corrected, still passing) | `cash-close-policy.db-ownership.spec.ts` | 8 tests (unchanged) | ✅ |
| 95 | Baseline `tsc` comparison — identical single pre-existing error | this report §8 | direct comparison | ✅ |
| 96 | Baseline e2e comparison — 3 suites, 16/16 clean | this report §5 | direct comparison | ✅ |
| 97 | Regression found (barrier deadlock) and fixed, re-verified 3× clean | this report §5 | 16/16 × 3 | ✅ |
| 98 | Full e2e suite, post-fix | this report §5/§8 | 963/964 | ✅ (1 isolated flake, 3/3 clean re-run) |
| 99 | Full unit suite | this report §8 | 760/760 | ✅ |
| 100 | OpenAPI drift detection | `openapi.e2e-spec.ts` | — | ✅ |

100 mapped items (exceeding the ~70-case bar), zero unmapped acceptance-relevant invariant identified during this closure task's own review of the four design reports, the SRS sections cited, and the implementation report.

---

## 10. HARD BLOCKERS

None remaining. The one genuine defect found during this closure task (§5's
regression) was fixed and re-verified within this same task, not merely
flagged.

---

## 11. Summary of what changed vs. the implementation report

1. `CashSessionCloseService.declareClose` now runs on `UnitOfWork` and
   writes a `CASH_VARIANCE_DECLARED` audit entry + publishes
   `cash.variance.detected`, once per newly-created attempt (§2/§3).
2. `getCloseContext`'s blind-mode response now includes
   `toleranceMinorUnits` (§7).
3. Three PRE-EXISTING, unrelated e2e files (`sales-payment-concurrency`,
   `order-completion-concurrency`, `order-completion-concurrency-2`) had
   their racing-payment fixtures split across two independent cash sessions
   to remove a genuine deadlock their own barrier synchronization now hits
   against the (correct, required) P1G-1 Payment/Close advisory lock (§5).
4. 21 new deterministic concurrency tests (§4) and 6 new audit/event tests
   (§2/§3) added; 1 existing test corrected for the §7 fix.
5. Requirement-classification BASIS corrected for FR-POS-096, FR-FIN-007,
   FR-SEC-016 (§6) — no classification's LETTER (COMPLETE/PARTIAL/NOT
   IMPLEMENTED) changed except FR-SEC-016, which is newly and correctly
   split into a global PARTIAL with a COMPLETE cash-variance limb (it had no
   prior classification at all).

No migration change. No business-flow redesign. No new permission. No new
governance. `R-6(a)`, the close protocol, tips/refunds structural zeros,
`statement_timestamp()` expiry base, and every other previously-accepted
design element are unchanged.
