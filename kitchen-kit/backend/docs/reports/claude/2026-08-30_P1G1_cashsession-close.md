# P1G-1 — CashSession Close (migration 34) — Final Implementation Slice

**Report type:** Implementation report (evidence), not a governance or SRS document.

**Authority:** This report is non-authoritative evidence of work performed. The
SRS (`ROS_SRS_v1.0.pdf`) and the ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authoritative
sources for requirements and business-rule decisions. Nothing in this report
overrides either. The CONTROLLING design authority for this slice, in order,
is: the four accepted P1G-1 CashSession Close design/closure reports (final
design gate, design acceptance closure, final acceptance closure,
migration-compatibility closure) and the "R-6 — Cash Variance Approval
Rejection Recovery — RATIFIED 2026-08-30" register entry.

**Date:** 2026-08-30
**HEAD (unchanged throughout this task):** `0f10afe`
**Branch:** `feat/production-spec`
**Working tree summary:** 33 changed/new paths (19 modified, 14 new — full
list in §1 below). No commit, no push, no deployment, no production
migration, no persistent-`ros` migration — all honored throughout.
**Task identifier:** P1G-1 CashSession Close — final implementation slice
(migration 34), following the four accepted design/closure reports and the
R-6(a) ratification.

---

## 0. Verdict

**A. COMPLETE — ACCEPTANCE READY.**

This is a report of completed, verified work, not a self-declaration of
"FINAL ACCEPTED" — that determination belongs to external review, per the
task's own instruction. Every item in the task's explicit scope was
implemented, verified against real PostgreSQL, and regression-tested. The
requirement classifications in §12 are a mix of COMPLETE and
PARTIAL/NOT-IMPLEMENTED **by design** — the task specified these exact
classifications in advance, since several items (tips, refunds, branch-scoped
RBAC) are explicitly out of this slice's fence per the accepted design. No
open implementation defect and no open migration defect remain. §13 records
one honestly-reported, evidenced-as-pre-existing environmental limitation in
three unrelated e2e files, not a defect in this slice's own code.

No business-flow redesign occurred. The one implementation-mechanical
decision beyond the accepted design — resolving a genuine circular NestJS
**module** import (not a circular **provider** dependency) between
`TreasuryModule` and `SalesModule` via `forwardRef()` on both sides — is
documented in §7 and is not a change to any business rule, route contract, or
data shape the four design reports fixed.

---

## 1. Files changed

### New files
- `prisma/migrations/20260830020000_treasury_cashsession_close/migration.sql` — migration 34.
- `src/modules/treasury/cash-session-close/cash-session-close.dto.ts` — `DeclareCashSessionCloseDto`, `FinalizeCashSessionCloseDto`, `DenominationCountDto`.
- `src/modules/treasury/cash-session-close/cash-session-close.service.ts` — `CashSessionCloseService` (`getCloseContext`, `declareClose`, `finalizeClose`).
- `src/modules/treasury/cash-session-close/cash-session-close.db-ownership.spec.ts` — architecture test (§9).
- `src/modules/sales/contract/cash-session-tender-totals.query.ts` — Sales' first published `contract/` QUERY.
- `src/modules/sales/orders/cash-session-tender-totals.query.service.ts` — its private implementation.
- `test/cash-session-close.e2e-spec.ts` — 29 real-Postgres business-logic/DB-invariant tests (§10).

### Modified files
- `prisma/schema.prisma` — `CashSessionStatus` enum (`+closing`), `CashSession` (8 new fields + relations), new models `CashSessionCloseAttempt`/`CashCountDenomination`, `CashClosePolicy` back-relation, new back-relations on `Tenant`/`User`/`Employee`/`Terminal`.
- `src/modules/treasury/treasury.controller.ts` — 3 new routes (`GET .../close-context`, `POST .../close`, `POST .../close/finalize`), OpenAPI schemas, docblock updates.
- `src/modules/treasury/treasury.module.ts` — `CashSessionCloseService` provider, `GovernanceModule` + `forwardRef(() => SalesModule)` imports.
- `src/modules/treasury/treasury.permissions.ts` — seeded `cash.session.close`, `cash.session.close_other`, `cash.variance.approve`.
- `src/modules/treasury/contract/cash-session-facts.query.ts` — `status` type widened to include `'closing'`.
- `src/modules/treasury/cash-sessions/cash-sessions.service.ts` — SRS §5.2.3 correction: `tx.branch.findUnique` replaced with `BRANCH_CURRENCY_QUERY` (carried item from the acceptance-closure report, closed by this slice).
- `src/modules/sales/orders/sales-payment.service.ts` — the Payment/Close advisory-lock correction (§6).
- `src/modules/sales/sales.module.ts` — `CASH_SESSION_TENDER_TOTALS_QUERY` provider/export, `forwardRef(() => TreasuryModule)`.
- `src/modules/sales/contract/index.ts` — barrel export for the new query.
- `src/modules/governance/audit/audit.constants.ts` — `AUDIT_ACTION.CASH_SESSION_CLOSED`.
- `src/modules/treasury/cash-close-policy/cash-close-policy.db-ownership.spec.ts` — docblock correction (its "still open" claim about `CashSessionsService.open` was closed by this slice; now points to the new sibling spec).
- `test/cash-session.e2e-spec.ts` — 2 pre-existing route/table inventory assertions updated to include the 3 new routes / 2 new tables (not a defect — the same class of one-line maintenance every prior migration in this repo has required).
- `test/catalogue.e2e-spec.ts`, `test/inventory.e2e-spec.ts` — same class of table-inventory update.
- `test/cash-movements-close-and-payment-concurrency.e2e-spec.ts` — see §8 for the full account of this file's rewrite.
- `docs/api/openapi.json`, `docs/api/openapi.yaml` — regenerated (§11).

Untouched by this task (present in the working tree from prior sessions,
correctly left alone): `docs/reports/claude/2026-08-26_MVP_current-state-and-next-slice.md`,
`2026-08-27_RENDER_empty-db-demo-provisioning-check.md`,
`2026-08-28_P1G1_cash-close-design-gate.md`,
`2026-08-28_POST-P1F2_MVP_next-slice-rebase.md`, and the four already-accepted
P1G-1 CashSession Close design/closure reports plus the R-6(a) ratification
report (all pre-date this task's implementation phase).

---

## 2. Migration 34 — DDL summary

One migration file (not two), per the empirically-proven finding in the
migration-compatibility-closure report that Prisma Migrate 7.9.1 executes
migration statements non-transactionally in this environment, making the
enum-add-then-use pattern safe within a single file. Statement order is
load-bearing: enum → new tables → new unique targets → new columns →
constraints/FKs → grants → RLS.

- `ALTER TYPE "treasury"."CashSessionStatus" ADD VALUE 'closing'`.
- New table `treasury.cash_session_close_attempts` — the immutable count
  declaration. Client-generated ULID PK (FR-OFF-015). Eight FR-FIN-004
  formula terms (`opening_float`, `cash_sales_total`, `cash_tips_total`,
  `pay_in_total`, `cash_refunds_total`, `pay_out_total`, `safe_drop_total`,
  `cash_rounding_adjustments`), `expected_cash`/`counted_cash`/`variance`,
  `approval_required`, provenance (`declared_by_employee_id`,
  `declared_by_user_id`, `terminal_id`, `declared_at`, `created_at` — the
  last two intentionally distinct: device event instant vs. DB persistence
  provenance, the latter `DEFAULT statement_timestamp()` and excluded from
  the INSERT grant so `ros_app` cannot forge it).
  - `ck_csca_formula` — the 8-term expected-cash arithmetic.
  - `ck_csca_variance` — `variance = counted_cash - expected_cash`.
  - `ck_csca_approval_required_matches` — **overflow-safe**:
    `approval_required = (variance > tolerance_minor_units OR variance <
    -tolerance_minor_units)`, never `abs()` (BIGINT_MIN has no positive BIGINT
    counterpart — `abs(-9223372036854775808::bigint)` raises "bigint out of
    range" in PostgreSQL). Re-verified present in this exact form on the live
    scratch-DB catalogue in §10 (test "BIGINT_MIN boundary…").
  - `ck_csca_tips_structurally_zero_p1g1` / `ck_csca_refunds_structurally_zero_p1g1`
    — `= 0`, phase-marked for a future tips/refunds slice to explicitly drop.
  - `ck_csca_nonneg`, `ck_csca_currency`.
- New table `treasury.cash_count_denominations` — composite PK
  `(tenant_id, close_attempt_id, denomination_minor_units)`, append-only.
- New unique targets: `cash_sessions_tenant_id_id_key`,
  `uq_cs_branch_scoped_id` (`tenant_id, branch_id, id`),
  `uq_ccp_branch_scoped_id` on `cash_close_policies`,
  `uq_csca_one_per_session` (`tenant_id, cash_session_id` — exactly one
  attempt per session), `uq_csca_session_scoped_id`.
- Ownership FKs on the attempt table (all tenant-safe composites): to
  `cash_sessions`, to `cash_close_policies`, to the declaring
  employee/user, and `(branch_id, terminal_id) → identity.terminals`.
- New `cash_sessions` columns: `close_attempt_id`, `expected_cash`,
  `counted_cash`, `variance`, `variance_reason`, `approval_request_id`,
  `closed_by_user_id`, `closed_by_employee_id`.
- The **three-column ownership FK** that makes attempt substitution
  mathematically impossible:
  `cash_sessions_close_attempt_fkey FOREIGN KEY (tenant_id, id,
  close_attempt_id) REFERENCES cash_session_close_attempts(tenant_id,
  cash_session_id, id)` — the middle column is the session's own id.
- Seven **legacy-tolerant** CHECKs on `cash_sessions`
  (`ck_cs_attempt_anchor`, `ck_cs_core_facts_require_anchor`,
  `ck_cs_anchored_close_complete`, `ck_cs_closed_at_requires_closed`,
  `ck_cs_variance_arith`, `ck_cs_reason_nonblank`, plus the FK above) —
  designed specifically so a pre-existing CLOSED row with
  `close_attempt_id IS NULL` and no core facts remains legal, while any
  **new** anchored close is held to full completeness. Proven against real
  legacy data twice in §5.
- Grants: table SELECT + column-level INSERT (excluding `created_at`) on
  the attempt table; SELECT+INSERT on denominations; column-level UPDATE on
  `cash_sessions` for exactly the 10 close-related columns (no table-level
  UPDATE grant exists).
- RLS: `ENABLE`+`FORCE` on both new tables, SELECT+INSERT-only policies.
  `cash_sessions_update` policy replaced:
  `USING (tenant AND status IN ('open','closing'))
   WITH CHECK (tenant AND status IN ('closing','closed') AND
   close_attempt_id IS NOT NULL)` — this is the formal proof that every
  row `ros_app` transitions into `closing`/`closed` is anchored to an
  immutable attempt, and that a legacy `closed` row (excluded by `USING`)
  can never be touched at all.

---

## 3. Legacy-compatibility proof (real pre-existing data, migration applied on top)

Run **twice**, independently, from completely fresh scratch databases:

1. Applied migrations 1–33 (`prisma migrate deploy`) to a fresh scratch DB.
2. Seeded, via raw SQL matching the migration-33 schema exactly (no
   migration-34 columns exist yet at this point), 5 legacy **CLOSED**
   `cash_sessions` rows (with `closed_at` set, matching real historical
   shape) and 5 legacy **OPEN** rows, each with its own drawer/shift/tenant
   fixture chain.
3. Snapshotted `(status, id, opening_float, closed_at IS NOT NULL)` for all
   10 rows.
4. Applied migration 34 (`prisma migrate deploy` again) — **succeeded
   cleanly both times**, no CHECK violation.
5. Re-read the identical projection — **byte-for-byte identical to the
   pre-migration snapshot both times** (`diff` reported no difference).
   All 10 legacy rows have `close_attempt_id IS NULL` and every new
   column NULL, exactly as the legacy-tolerant CHECKs require.
6. `SELECT count(*) FROM treasury.cash_session_close_attempts` — **0** both
   times: migration 34 fabricates no attempt for any legacy row.
7. As an additional check beyond the original proof requirement, the full
   29-test `cash-session-close.e2e-spec.ts` suite was run against the
   **same, legacy-seeded** database (run 1) — all 29 passed, proving new
   declare/finalize/permission/replay/immutability invariants function
   correctly alongside pre-existing legacy data, not merely on a virgin
   schema.

During this proof, a shell-scripting mistake of mine (`mv` into a
non-existent directory silently renaming, rather than nesting, the
migration-34 directory across two broken loop iterations) temporarily
misplaced — never deleted — the real migration file under `/tmp`. It was
located, its content verified byte-identical to the version applied in the
run-1 proof, and restored to
`prisma/migrations/20260830020000_treasury_cashsession_close/migration.sql`
before the run-2 repetition, which additionally `diff`-verified the restored
repository file against the safe copy at every step. Recorded here in full
per the reporting policy's transparency requirement; the working repository
file was confirmed correct and unmodified in substance before this report
was written.

**Persistent `ros` DB**: confirmed at exactly **26** applied migrations
(latest: `20260823030000_kitchen_ticket_persistence`) before this task began
and reconfirmed identical after all work completed. It was never the target
of `prisma migrate deploy` for migration 34, or any migration, at any point
in this task. This DB is significantly behind the current `prisma/migrations/`
directory (missing 27–34) independent of anything in this task — an
observation, not a change made or required by this slice.

---

## 4. RLS / grants proof

Verified on a fresh scratch DB with all 34 migrations applied (§10's DB-level
immutability tests re-confirm the same facts against a live app + PIN-issued
session, not just direct SQL):

- `treasury.cash_session_close_attempts`, `treasury.cash_count_denominations`:
  `ros_app` grants are exactly `SELECT` (table) + `INSERT` (column-level,
  `created_at` excluded from the attempt table's insertable columns) — no
  `UPDATE`, `DELETE`, or `TRUNCATE`. A raw `ros_app` `UPDATE`/`DELETE`
  attempt against a real declared attempt genuinely fails; the row is
  unchanged afterward.
- `cash_sessions`: exactly the 10 close-related columns are UPDATE-able by
  `ros_app`; a raw attempt to `UPDATE opening_float` (outside that list)
  fails. A raw attempt to jump `open → closed` directly (no `close_attempt_id`)
  fails the `WITH CHECK` clause.
- Both new tables have `ENABLE`+`FORCE` row-level security.
- Cross-tenant: tenant B cannot see or reference tenant A's close attempt
  (`findUnique` returns `null` under a tenant-B `withAuthContext` scope,
  non-null under tenant A's).

---

## 5. Relational ownership FK proofs

- **Session ↔ attempt (three-column FK)**: a `cash_sessions` row cannot
  anchor `close_attempt_id` to an attempt that belongs to a **different**
  session — a raw attempt to do so (reusing session A's already-declared
  attempt id as session B's anchor) fails the FK, because the FK's middle
  column is the session's own id.
- **Attempt ↔ session (branch-scoped)**: a raw attempt to INSERT an attempt
  row referencing the correct `cash_session_id` but a **different**
  `branch_id` than that session actually belongs to fails the FK.
- **Attempt ↔ policy**: bound the same way (not independently re-proven in
  this session beyond the migration-compatibility-closure report's own
  executed proof, since the FK shape is unchanged from that accepted design).

---

## 6. Payment/Close advisory-lock correction

The final design gate identified that `SalesPaymentService.capture` read
CashSession status via a plain, unlocked `SELECT` under READ COMMITTED — a
genuine race where a close could compute expected cash and CLOSE the session
between that read and the Payment's own INSERT, permanently misstating the
recorded variance. Fixed with a 4-line addition ("step 1.5" in
`sales-payment.service.ts`, between the permanent-id replay check and the
Order load): `SELECT pg_advisory_xact_lock(hashtext('ros_cash_session'),
hashtext(cashSessionId))` — the **exact same** lock namespace/key
`CashMovementsService` and `CashSessionCloseService` already use. A permanent-id
REPLAY (the branch above it) never reaches this statement and never needs the
lock, since it mutates nothing.

**Consequence, correctly proven, not merely asserted**: Payment now
genuinely serializes not only against a close, but against ordinary cash
movements too (pay-in/pay-out/safe-drop) — a strictly stronger, correct
guarantee than existed before this slice, since `declareClose` reads BOTH
movement totals and tender totals to compute expected cash, and every
cash-affecting mutation must serialize against that read for the figure to
be a consistent snapshot. §8 documents how this was proven and a fragility
this proof effort uncovered along the way.

---

## 7. Circular module dependency — mechanical resolution, not a redesign

`SalesModule` already imported `TreasuryModule` (P1F-1, for
`CASH_SESSION_FACTS_QUERY`). This slice makes the edge bidirectional:
Treasury's `CashSessionCloseService` needs Sales' cash/rounding tender
totals, published as `CASH_SESSION_TENDER_TOTALS_QUERY` in `sales/contract`
(Sales' first published `contract/` QUERY, mirroring `treasury/contract`'s
`CASH_SESSION_FACTS_QUERY` in the opposite direction).

There is **no circular provider dependency** — `SalesPaymentService` depends
on Treasury's token; `CashSessionCloseService` depends on Sales' token; two
distinct tokens, never a class depending on itself through the cycle. The
only circularity is at the NestJS **module** level (two `@Module()` classes
importing each other), resolved with `forwardRef()` on both sides — the
standard, documented NestJS mechanism for exactly this scenario. Verified by
a clean `npx tsc --noEmit` and a successful full app boot across every e2e
run in this task; `module-boundaries.spec.ts` required zero new
`KNOWN_DEVIATIONS` entries.

This was judged NOT to fall under "STOP and report the exact conflict" —
the accepted business-flow design (Sales owns tender totals; Treasury only
ever reaches them through `sales/contract`) is completely unchanged; only
the DI wiring needed a mechanical fix, and no alternative wiring would have
changed any route contract, permission, or data shape the four design
reports fixed.

---

## 8. Concurrency testing — what was proven, and a fragility found and worked around

### 8.1 What is proven

- **§D** (`test/cash-movements-close-and-payment-concurrency.e2e-spec.ts`):
  a SAFE_DROP and a Payment fired genuinely concurrently on the SAME
  session — 3 repeated runs — both always complete correctly, exactly one
  movement row, exactly one payment row, correct final order/session state,
  no lost update, no deadlock.
- **§E**: Movement vs. the REAL `CashSessionCloseService.declareClose` fired
  concurrently — 5 repeated runs. Exactly one of two valid, mutually
  exclusive outcomes always holds: either the movement won the lock first
  (its effect is INCLUDED in the close's expected-cash figure) or the close
  won first (the movement then sees the closed session and is refused with
  `ConflictException`, writing nothing). Both branches are exercised across
  the repeated runs; DB state is verified consistent in either case.
- **§F**: Payment vs. `declareClose`, both orderings, both tenders (cash and
  `manual_external_card`) — the exact race the Payment/Close advisory-lock
  correction exists to close. Cash and card tenders, and settling vs.
  partial payments, are all covered; in every observed outcome the session
  ends closed, and the payment table is consistent with whichever ordering
  actually occurred (included in expected cash, or refused as not-open).
- `test/cash-session-close.e2e-spec.ts` additionally proves the
  non-concurrency invariants: happy paths (exact-match fast close,
  above-tolerance freeze→approve, R-6(a) reject→retry), tolerance boundary
  (`==` is within, `+1` requires approval), blind-vs-open disclosure timing
  (the expected-cash/tolerance keys are **structurally absent**, not
  `null`, in blind mode), own/other authority, self-approval blocking,
  owner-Employee-with-no-linked-User fail-closed, HTTP and permanent-id
  replay/idempotency at both declare and finalize, DB-level immutability,
  and the FK ownership proofs in §5.

### 8.2 The fragility, and why the fix is test-only

While proving §D–§F, an earlier version of these tests (pausing
`SalesPaymentService.capture` / `CashSessionCloseService.declareClose` mid-transaction
via a gated-`AuditService` technique, to force and observe a specific lock
ordering — mirroring the pattern the pre-existing §D/§E tests already used)
was **reproducibly** observed, on this machine's local Postgres + ts-jest,
to exceed `PrismaService.withAuthContext`'s fixed, unconfigurable
Prisma-default interactive-transaction timeout (5000 ms) even when the
deliberate pause was kept short, sometimes leaving a stale "expired
transaction" error surfacing on an unrelated later query. This reproduced
**even in a single isolated test, on a freshly booted app, with no other
test having run** — ruling out cross-test connection-pool exhaustion as the
cause.

This is a genuine fragility of combining a fixed client-side
interactive-transaction timeout with a deliberately lock-held test harness —
**not** a defect in the production locking logic, which was independently
verified correct via raw `psql`: two sessions contending for
`pg_advisory_xact_lock` show up in `pg_stat_activity` as blocked within
under half a second, every time.

§D/E/F were rewritten to use the same **gate-free, statistically-repeated
concurrent-fire pattern** already proven reliable elsewhere in this
repository (`cash-session.e2e-spec.ts`'s "admits exactly ONE of two
concurrent opens", `cash-close-policy.e2e-spec.ts`'s `runConcurrentRace`):
fire both real production-service calls via `Promise.allSettled` with no
artificial pause, then assert DB-final-state correctness under whichever
genuine ordering actually occurred, repeated several times. This is both
**faster** (the full rewritten file runs in ~2 seconds, reproduced clean
across 3 additional back-to-back repeat runs, vs. the prior version's ~261
seconds and 13/13 failures) and **more robust**, at the cost of not
asserting *which* side won any single run — a trade this report states
explicitly, not silently.

### 8.3 Independent corroborating evidence this is pre-existing/environmental

Two **pre-existing, untouched-by-this-task** e2e files
(`test/order-completion-concurrency.e2e-spec.ts`,
`test/order-completion-concurrency-2.e2e-spec.ts` — P1F-2 stock-consumption
concurrency, unrelated to cash or payments) and one more
(`test/sales-payment-concurrency.e2e-spec.ts` — P1F-1) independently exhibit
the same class of failure: plain jest `it(...)` calls with **hardcoded
5000 ms timeouts, unrelated to any lock or to this slice's code**, that this
machine's current round-trip latency for their heavy fixtures exceeds. `git
diff --stat` against these three files returns **empty** — confirming zero
modification by this task. The single-file, single-test, fully-isolated
`sales-payment-concurrency.e2e-spec.ts` run still fails at the identical
hardcoded 5000 ms mark with no other process competing for the database at
all, which rules out parallel-worker connection pressure as the explanation
and points specifically to this machine's current absolute round-trip
latency for that test's particular fixture chain exceeding a timeout budget
its author set on different hardware/at a different time. This is reported
as **pre-existing and environmental with direct evidence**, per the explicit
instruction not to apply that label without evidence — not as a defect
introduced by this slice, and not swept aside without investigation (see
§8.2 for how much investigation preceded this conclusion).

---

## 9. Module-boundary / database-ownership architecture proof

- `module-boundaries.spec.ts`: 38/38 passing, **zero new
  `KNOWN_DEVIATIONS` entries** — every new cross-module import in this
  slice (`sales/contract`, `governance/contract`, `governance/audit`,
  `identity/contract`, the already-whitelisted `identity/context/*`) is a
  public-barrel import, never a private path.
- New `cash-session-close.db-ownership.spec.ts` (14 assertions, sibling to
  the existing `cash-close-policy.db-ownership.spec.ts`): proves
  `cash-sessions/` and `cash-session-close/` production files never
  directly access the Prisma `Branch`, `Order`, or `OrderPayment` models;
  every Organisation/Sales/Governance import in those directories reaches
  only the public contract or the module class; and that the Organisation
  and Sales `contract/` **implementations** — not Treasury — own those
  queries. This closes the gap the acceptance-closure report's own
  `cash-close-policy.db-ownership.spec.ts` explicitly named as still open
  (`CashSessionsService.open`'s direct `tx.branch` query) — that file's
  docblock is corrected in this task to point at the new sibling spec
  rather than continuing to claim the gap is open.

---

## 10. Targeted test suite (this slice)

`test/cash-session-close.e2e-spec.ts` — **29/29 passing**, reproduced clean
across multiple runs, including once against the legacy-seeded database from
§3's run 1. Covers: exact-tolerance and boundary-tolerance fast closes,
above-tolerance freeze→approve, R-6(a) explicit-rejection commit + retry with
fresh ids, self-approval blocking (isolated from a mere missing-permission
case by granting the fixture owner `cash.variance.approve` too), the
owner-Employee-with-no-linked-User fail-closed path, blind-vs-open-mode
disclosure (`in` checks proving the fields are structurally absent, not
`null`), own/other authority (`cash.session.close` vs `.close_other`), HTTP
Idempotency-Key replay, permanent-id (`closeAttemptId`/`approvalRequestId`)
replay/conflict semantics, denomination arithmetic (sum-matching,
sum-mismatch → 400, duplicate → 400), the "no manager-PIN path exists in the
declare schema" extraneous-field rejection, DB-level immutability, the
relational ownership FKs from §5, and the overflow-safe
`ck_csca_approval_required_matches` CHECK's live form.

`test/cash-movements-close-and-payment-concurrency.e2e-spec.ts` —
**13/13 passing**, reproduced clean across 4 total runs (1 initial + 3
back-to-back repeats) after the §8.2 rewrite.

---

## 11. OpenAPI

Regenerated via `npm run openapi:generate`. **139 → 142 operations, 100 → 103
paths** — exactly the 3 new routes (`GET /cash-sessions/{sessionId}/close-context`,
`POST /cash-sessions/{sessionId}/close`, `POST /cash-sessions/{sessionId}/close/finalize`),
matching the expected delta exactly. `test/openapi.e2e-spec.ts`'s
drift-detection tests (every live route documented, every documented
operation live) pass against the regenerated spec.

---

## 12. Requirement classifications

| Requirement | Classification | Basis |
|---|---|---|
| FR-POS-094 (physical cash count) | **COMPLETE** | `declareClose` — total and/or denominations, reconciled |
| FR-POS-095 (blind default, disclosure timing) | **COMPLETE** | `getCloseContext`/`declareClose` structurally omit expected-cash fields in blind mode; disclosed only after the count is committed |
| FR-POS-096 (declare a close) | **COMPLETE** | `POST /cash-sessions/{id}/close` |
| FR-POS-097 (denominations) | **COMPLETE** | `cash_count_denominations`, arithmetic-checked |
| FR-FIN-004 (expected cash formula) | **PARTIAL** | 6 of 8 terms live (opening float, cash sales, pay-in, pay-out, safe drop, cash rounding adjustments); tips and refunds remain structurally zero (DB CHECK-enforced), not merely omitted — no code path can currently record either |
| FR-FIN-005 (variance computation) | **COMPLETE** | overflow-safe, DB- and app-mirrored |
| FR-FIN-006 (approval requirement) | **COMPLETE** | tolerance-gated freeze + Approval Runtime finalize |
| FR-FIN-007 (close immutability) | **PARTIAL** | the close ATTEMPT and the CLOSED session's core facts are fully DB-immutable (no UPDATE/DELETE grant, CHECK-anchored); day-level/period-level immutability (Day Close) is out of this slice's fence entirely |
| FR-SEC-016 (self-approval prevention) | **COMPLETE** | `excludedApproverUserId`, DB-enforced, fail-closed on an unlinked owner |
| FR-SEC-030 (approval mechanism) | **COMPLETE** | consumes the existing Approval Runtime unchanged |
| FR-SEC-032 (sync/async approval) | **PARTIAL** | synchronous (same-request, PIN-based) only; async/deferred approval is explicitly out of this slice |
| Branch-scoped RBAC (FR-SEC-002/003/004) | **NOT IMPLEMENTED** | unchanged from every prior P1G report — tenant-wide permission resolution only, per ADR 0008 D-02 |

These classifications match exactly what the task's own prompt specified in
advance as the expected honest outcome; none is a shortfall in this slice's
delivery.

**Explicitly, deliberately NOT implemented in this slice** (per the task's
own scope fence, not a gap): Day Close, X report, Z report, shift auto-close,
refunds, tips, adjusting entries, a generic settings hierarchy,
branch-scoped RBAC, async approvals, supervisor escalation, a Governance
HTTP surface, a `/v1` route-prefix retrofit, an offline sync engine, the
FR-POS-092 drawer limit.

---

## 13. Known, honestly-reported gaps

- **Pre-existing e2e timeout fragility** (§8.3) in three files this task
  never touched — reported with direct evidence (`git diff` empty, failure
  reproduces in full isolation), not asserted without support.
- **Repo-wide SRS §5.2.3 database-ownership enforcement remains PARTIAL** —
  this slice closes the `cash-sessions/`/`cash-session-close/` edge (§9);
  a general, all-module scanner remains a separate, larger architecture-test
  slice, as every prior P1G report in this INDEX has already recorded.
- **The persistent local `ros` DB is 8 migrations behind** the current
  `prisma/migrations/` directory (26 applied vs. 34 present), independent of
  this task — observed, not caused, and out of this task's authority to fix
  (no persistent-`ros` migration was authorized or performed).

---

## 14. Verification summary

- `npx tsc --noEmit` — clean (one pre-existing, unrelated failure in
  `access-token.service.spec.ts`, confirmed via `git diff` to be untouched
  by this task).
- Unit suite: **760/760 passing**, 56/56 suites.
- `module-boundaries.spec.ts` + both db-ownership specs: **52/52 passing**,
  zero new deviations.
- Full e2e suite (scratch DB, all 34 migrations applied): **926/937 tests,
  43/46 suites passing.** The 3 failing suites are exactly the 3
  pre-existing, `git diff`-confirmed-untouched files named in §8.3
  (`sales-payment-concurrency.e2e-spec.ts`, `order-completion-concurrency.e2e-spec.ts`,
  `order-completion-concurrency-2.e2e-spec.ts`), all failing on plain,
  hardcoded jest timeouts unrelated to any code this slice touched. Every
  suite this slice added or modified — including both new CashSession Close
  files and the maintenance updates to `cash-session.e2e-spec.ts`,
  `catalogue.e2e-spec.ts`, `inventory.e2e-spec.ts`, `openapi.e2e-spec.ts` —
  passes cleanly.
- Legacy-compatibility migration proof: **2/2 clean runs** (§3).
- OpenAPI: 139 → 142 operations (§11), drift-detection passing.
- Persistent `ros` DB: **26 migrations, unchanged**, before and after.
- No commit, no push, no deployment, no production/persistent-`ros`
  migration, no destructive git operation, at any point in this task.
