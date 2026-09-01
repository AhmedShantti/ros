# DayClose — Final Acceptance Cleanup

**Report type:** NARROW ACCEPTANCE-CORRECTION task report. Two specific
gaps only. DayClose business semantics, DC-R1/DC-R2/DC-R3, D-2, and P1C-1
were NOT reopened. No migration #36 was created.

**Authority statement:** This report is non-authoritative evidence only.
The SRS (`ROS_SRS_v1.0.pdf`) and ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole
authority. Nothing in this report creates, amends, or reinterprets any
ratified decision. The broad DayClose verification recorded in
`2026-09-01_DAYCLOSE-acceptance-completion.md` is treated as ACCEPTED and
is not re-litigated here except where this task's two named gaps required
a correction.

**Date:** 2026-09-01
**HEAD:** `7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` — unchanged; nothing
committed.
**Branch:** `feat/production-spec`
**Working tree summary:** Identical to the prior report's working tree,
with exactly one additional change: `test/day-close.e2e-spec.ts` was
edited in place (typed response helpers added, one new dedicated
immutability test added). No other file changed in this task.
**Task identifier:** ROS — DAYCLOSE FINAL ACCEPTANCE CLEANUP (narrow
acceptance-correction task; Gap A: new-test-file ESLint debt; Gap B:
mechanical `closed_business_day` immutability proof).

---

## 1. Baseline

```
HEAD:   7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c (unchanged)
BRANCH: feat/production-spec
```

Matches the expected baseline. The uncommitted DayClose implementation and
its verification tests were present as expected and were not discarded.
`2026-09-01_DAYCLOSE-acceptance-completion.md` was read in full before this
task began.

---

## 2. GAP A — new-test ESLint debt

### Original count

**76 errors, 2 warnings**, entirely in `test/day-close.e2e-spec.ts`
(confirmed by re-running ESLint on the exact same file set the prior
report covered) — almost all `@typescript-eslint/no-unsafe-member-access`
/ `no-unsafe-assignment` from accessing untyped `res.body.*` on supertest
responses, plus one `@typescript-eslint/require-await` on the
`TransactionalDomainEventHandler.handle` callback and two
`no-unsafe-argument` warnings.

### Fix approach taken

No repository-wide `eslint --fix`. No rule weakened. No `eslint-disable`
comment added anywhere. No response cast to `any`. No production DTO
touched. Only `test/day-close.e2e-spec.ts` was edited:

- Imported the REAL, already-exported response types from the production
  source itself — `DayClosePostResult` and `DayCloseView`
  (`src/modules/treasury/day-close/day-close.service.ts`) — rather than
  hand-duplicating shapes that could drift from the implementation.
- Added five small, local, typed accessor functions: `postBody()`,
  `getBody()`, `asClosed()` (narrows the `DayClosePostResult` union to its
  `CLOSED` variant, throwing loudly on a real narrowing failure — this
  additionally makes several assertions STRICTER, since TypeScript now
  enforces the outcome is CLOSED before `.dayClose` is reachable at all,
  where before it was an unchecked `any` access), `blockerBody()` (the 409
  Problem-Details-shaped body carrying `blockingOrderIds`/
  `blockingSessions`), `closeContextBody()`/`declareCloseBody()` (the
  `cash-session-close` route's own response shapes — mirroring, not
  duplicating logic from, `cash-session-close.e2e-spec.ts`'s established
  `ContextBody`/`DeclareBody` local-interface convention).
- Replaced every `res.body.X` / `something.body.dayClose.X` occurrence
  (assignment or single a `res` object was `.expect()`-only) with a call
  through the appropriate typed accessor.
- Where a `.find()` over a typed array could legitimately return
  `undefined` (`cashReconciliation.sessions.find(...)`), kept the existing
  `expect(...).toBeDefined()` runtime check and added an explicit `!`
  non-null assertion for the subsequent property access — the assertion is
  justified by, and stated immediately after, the runtime check on the
  preceding line, not a blind cast.
- Fixed the `require-await` on `dayClosedCaptureHandler.handle`: removed
  `async`, return `Promise.resolve()` / `Promise.reject(...)` explicitly.
  This task's instruction that "an identical pre-existing pattern
  elsewhere is not justification" was followed — the matching, unfixed
  pattern in `cash-session-close.e2e-spec.ts:145` was NOT touched (out of
  scope: pre-existing debt in a file this task did not otherwise change),
  but the new file's own instance was fixed regardless of that precedent.
- The 3 remaining issues after the substantive fixes were pure Prettier
  formatting (line-wrapping), fixed via `eslint --fix` scoped to this ONE
  file only (not repo-wide).

### Final result

```
npx eslint test/day-close.e2e-spec.ts   ->  0 errors, 0 warnings
```

Re-ran across the FULL DayClose changeset (§5) — every other new/changed
DayClose file was already clean and remains clean.

---

## 3. GAP B — mechanical `closed_business_day` immutability proof

### What was verified about the existing RLS policy

`treasury.cash_sessions_update` (migration
`20260830020000_treasury_cashsession_close`, unchanged by migration 35):

```sql
CREATE POLICY cash_sessions_update ON "treasury"."cash_sessions" FOR UPDATE
  USING      (tenant_id = ... AND status IN ('open', 'closing'))
  WITH CHECK (tenant_id = ... AND status IN ('closing', 'closed')
              AND close_attempt_id IS NOT NULL);
```

The `USING` clause is the row-VISIBILITY gate for `UPDATE`: a row whose
current `status` is `closed` is not a candidate row for any `UPDATE`
`ros_app` issues, regardless of which column that `UPDATE` targets —
`closed_business_day` included, even though migration 35's own
column-level `GRANT UPDATE ("closed_business_day")` exists.

### New test added

`test/day-close.e2e-spec.ts`, inside the existing `cash_sessions.
closed_business_day (items 24-27)` describe block: **"GAP B:
closed_business_day (and every other close fact) is unwritable via raw
SQL once the session is closed."**

Scenario, exactly as specified:

1. A real `CashSession` is opened, then closed through the ACCEPTED real
   `close-context`/`close` HTTP pipeline (PIN/POS session, matching
   `requirePosIdentity` — the same production write path
   `cash-session-close.e2e-spec.ts` itself exercises).
2. Confirmed: `status = 'closed'`, `closed_business_day = D` (the real
   branch business day).
3. As `ros_app` (via `PrismaService.withAuthContext`, inside valid tenant
   context — the SAME mechanism the real application uses, never a raw
   connection outside RLS), a raw `UPDATE treasury.cash_sessions SET
   closed_business_day = <a different day> WHERE tenant_id = ... AND id =
   ...` is attempted.
4. A SECOND raw `UPDATE ... SET counted_cash = counted_cash + 1 ...`
   against the SAME closed row is also attempted, to demonstrate the row
   itself — not merely this one column — is entirely not update-visible.
5. Both attempts are wrapped in try/catch, handling either possible shape
   (a Postgres error, or a silent zero-rows-affected result) without
   assuming which; the test asserts the DURABLE invariant either way: the
   persisted `closed_business_day`, `counted_cash`, and `status`, re-read
   fresh via the (RLS-bypassing) migrator client, are BYTE-IDENTICAL to
   their values before the attempts.

### Observed PostgreSQL/RLS behaviour

Directly instrumented and captured against a live scratch database (the
instrumentation was then removed before leaving the test in its final,
clean state — the observation is recorded here and in the test's own
comment instead):

```
rewriteRowCount: 0, rewriteErrorPresent: false
secondRowCount:  0, secondErrorPresent: false
```

**Both raw `UPDATE` attempts affected zero rows and threw no error.** This
is PostgreSQL's standard, documented RLS behaviour for a restrictive
`USING` clause on `UPDATE`: a row that fails `USING` is simply not a
candidate for the command — exactly as it would not be for a `SELECT ...
FOR UPDATE` — so the command reports "0 rows affected" rather than a
permission/policy exception. The `GRANT UPDATE` on the column is real and
correct (an `ros_app` `UPDATE` against an `open`/`closing` row DOES
succeed, proven by the SAME test's own step 1-3 — the real close pipeline
itself performs exactly this class of write, successfully, while the
session is still `open`); it is the row-visibility policy, not the grant,
that neutralises the attempt once the row is `closed`.

### Persisted value before/after

| Field | Before attempt | After attempt |
|---|---|---|
| `closed_business_day` | `D` (real branch business day) | `D` — unchanged |
| `counted_cash` | original declared count | unchanged |
| `status` | `closed` | `closed` — unchanged |

**The durable invariant holds: `closed_business_day` after the attempt ===
`closed_business_day` before the attempt.**

### Verdict on this gap

**No immutability defect.** The existing migration-34 RLS policy, unmodified
by migration 35, already fully closes this gap by construction. No
trigger was added (none was needed — the task's own instruction was "do
not add a trigger unless the existing RLS is actually insufficient," and
it is not insufficient). No production or migration file was touched.

---

## 4. Production / migration change verification

**Confirmed: no DayClose production source change. No schema change. No
migration change.** `git status` for this task shows exactly one file
touched beyond documentation: `test/day-close.e2e-spec.ts` (typed
response helpers + the one new Gap B test). `day-close.service.ts`,
`day-close.controller.ts`, `day-close.dto.ts`,
`prisma/migrations/20260831010000_treasury_day_close/migration.sql`, and
`prisma/schema.prisma` are byte-identical to their state when the prior
acceptance-completion report was written. Verdict E (production/migration
correction required) does not apply.

---

## 5. ESLint — full DayClose changeset

Every changed/added TS file across the entire DayClose slice (production,
contracts, module wiring, unit tests, e2e tests, fixtures, and the three
narrowly-corrected pre-existing boundary tests from the prior task) was
re-linted:

**NEW/CHANGED FILE ERRORS: 0**
**NEW/CHANGED FILE WARNINGS: 0**

One pre-existing error outside this changeset's own diff lines is recorded
separately, as instructed: `src/modules/treasury/cash-session-close/
cash-session-close.service.ts:610` (`.decision.decision` on an `any`
value) — confirmed, again, to sit entirely outside every line this
DayClose slice's diff touches in that file (verified against `git diff
7bc5d2c962ec7774dcdb1a0ec1e9602fcad7d54c` for that file). Not fixed — out
of this narrow task's scope, and not new debt introduced by this slice.

---

## 6. Static / test recheck

| Check | Result |
|---|---|
| `npx prisma validate` | Clean |
| `npx nest build` | Clean |
| `npx tsc --noEmit` | 1 pre-existing error (`src/modules/identity/auth/access-token.service.spec.ts:28`), zero new errors |
| `git diff --check` | Clean |
| `npx jest src/modules/module-boundaries.spec.ts` | 45/45 passing |
| Gap B immutability test (dedicated run) | Passing |
| All dedicated DayClose tests | **50/50 passing** (49 prior baseline + 1 new Gap B test) — 45 e2e (35 + 5 cutover-race + 4 Z-number-concurrency + 1 new Gap B) + 5 unit |
| Full unit suite | **797/797 passing**, 59/59 suites (100%) |

---

## 7. Scratch / full e2e final pass

A genuinely disposable database was created fresh for this task
(`ros_scratch_dayclose_final_<timestamp>`, later
`ros_scratch_verify_<timestamp>` for the Gap B instrumentation check) on
the project's own Postgres container, started fresh since it was not
already running. The persistent `ros` database was never connected to,
queried, or dropped by this task.

`npx prisma migrate deploy` from a BLANK database: **35/35 migrations
applied successfully** (run twice across the two scratch databases used in
this task — identical result both times).

Complete e2e suite, one full run, no exclusions:

**63/63 suites, 1120/1120 tests passing (100%).**

1120 = the prior verified baseline of 1119 + this task's 1 new e2e test
(the Gap B immutability test). Both scratch databases were dropped and the
Docker container stopped after use.

**Zero `KNOWN_DEVIATIONS` growth** — `module-boundaries.spec.ts`'s 45/45
still passes unchanged; this task added no new cross-module import
anywhere (the one file it touched is a test file with no module-boundary
relevance).

---

## 8. TSC wording correction (task §7)

The prior report's line "TSC: clean (1 pre-existing unrelated error)" was
internally contradictory, as this task's instructions correctly flagged.
Corrected, precise wording for both this report and going forward:

**TSC: 1 PRE-EXISTING ERROR, ZERO NEW ERRORS.**

(`src/modules/identity/auth/access-token.service.spec.ts:28` — a JWT-
library type mismatch, in a file no DayClose task has ever touched. This
correction is reporting precision only; the underlying Identity debt was
not investigated or fixed, per this task's own explicit instruction.)

---

## 9. Preserved results

Every previously-proven DayClose result named in this task's §8 list
remains proven, unchanged, and was re-verified in this task's own test
runs (§6-§7): activation, `ACTIVATED` idempotency, the strictly-past rule,
FR-FIN-021, the open-order blocker, the cutover shared fence,
`DAY_CLOSE_STATE_QUERY`, closed-business-day ownership, the spanning
session, zero-payment/movement-only variance, Z-number concurrency,
DayClose immutability (now including the specific `closed_business_day`
mechanical proof this task added), historical GET, permissions, audit,
event, rollback, OpenAPI, `FR-FIN-022` PARTIAL, `FR-FIN-026` PARTIAL, the
Reporting-export correction, and the post-fire-void correction. Nothing
was reopened or weakened.

---

## 10. Verdict

**A. DAYCLOSE ACCEPTANCE CLEAN — READY FOR FINAL ACCEPTANCE.**

Gap A (new test-file lint debt) is fully resolved — 0 errors, 0 warnings
on every new/changed file, achieved through typed local response
interfaces sourced from the production types themselves, never a rule
weakening or a blanket cast. Gap B (mechanical `closed_business_day`
immutability) is proven directly against a live database — the pre-
existing migration-34 RLS policy already fully closes it; no defect was
found, so Verdict B does not apply, and no production/migration change was
required, so Verdict E does not apply. All previously-accepted results
remain intact and were re-verified.
