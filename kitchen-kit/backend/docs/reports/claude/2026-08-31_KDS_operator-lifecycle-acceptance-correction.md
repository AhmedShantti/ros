# KDS MVP Operator Lifecycle — Final Implementation Acceptance Correction

**Report type:** Acceptance-correction implementation report (narrow scope —
corrects 6 external-review blockers against the accepted KDS operator
lifecycle implementation; does not redo the slice).

**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative. Where this report
states a test result or a code-level finding, that finding is only as good
as the verification described below — it does not itself confer acceptance.
Final acceptance is determined outside this session, by review of this
report and the code it describes.

**Date:** 2026-08-31

**HEAD at start and end of this task:** `121b889` (unchanged — no commit made
during this task; every change described below is an uncommitted working-tree
edit on top of this commit)

**Branch:** `feat/production-spec`

**Working tree summary:** 58 changed paths at session end (git status
`--short` count), comprising the already-uncommitted Phase 1 KDS
implementation (`docs/reports/claude/2026-08-30_KDS_operator-lifecycle-
implementation.md` and its sibling design-gate/ratification reports, plus the
uncommitted P1G-1 Governance register ratification predating this task) and
this task's own edits, enumerated file-by-file in §1–§6 below. No migration
file was created or modified. `prisma/schema.prisma` was not modified. No
commit, push, or deploy was performed. No destructive git operation was run.

**Task identifier:** ROS — KDS MVP OPERATOR LIFECYCLE FINAL IMPLEMENTATION
ACCEPTANCE CORRECTION (follow-up to the accepted
`2026-08-30_KDS_operator-lifecycle-implementation.md`, which this report does
**not** modify).

**Scope discipline:** This is a narrow acceptance-correction task. It does
not reopen KDS-R11 or KDS-R12, does not touch Governance, does not add a
migration or a Prisma schema change, and does not implement any deferred KDS
feature (served/Expediter routing, cancellation, colour thresholds,
analytics, offline KDS, or standard-role seeding). Every change below is
traceable to one of the six numbered blockers or to the mandatory
clean-database verification.

---

## §1. Blocker A — module-boundary discipline (KNOWN_DEVIATIONS)

**Finding.** `KNOWN_DEVIATIONS` in `src/modules/module-boundaries.spec.ts`
never actually gained a `kitchen->identity` or `kitchen->governance` entry —
confirmed by inspecting both the committed HEAD (`121b889`) version of the
allow-list object and the current working-tree version: neither contains
those keys, and no other module's entry was touched. The risk the review
flagged was structural, not yet realised in the object literal: Kitchen's
guard, permissions, and `AuditService`-calling code reached into the exact
same private Identity/Governance paths (`auth/guards/jwt-auth.guard`,
`authz/...`, `context/...`, `audit/audit.service`) that every other
controller-bearing module (`catalogue`, `inventory`, `organisation`,
`production`, `sales`, `treasury`) already has its own named
`KNOWN_DEVIATIONS` entry for. Adding a matching entry for Kitchen would have
been the path of least resistance and would have been exactly the kind of
allow-list growth the review was right to flag as a risk.

**Fix.** Rather than add an entry, two new genuine public contracts were
published so Kitchen's imports never need one:

- `src/modules/identity/contract/http.ts` (new) — re-exports
  `JwtAuthGuard`, `TenantContextGuard`, `PermissionGuard`,
  `RequirePermission`, `RequireAnyPermission`, `AllowPosSession`,
  `CurrentPrincipal`, `CurrentTenantContext`, and the
  `AuthenticatedPrincipal`/`TenantContext`/`PermissionDef` types. Proven a
  thin re-export by the boundary suite's existing
  `containsPersistenceImplementation` detector (no class, no decorator body,
  nothing declared).
- `src/modules/governance/contract/audit.ts` (new) — re-exports
  `AuditService`, `AuditEvent`, `AUDIT_ACTION`, `AUDIT_ENTITY`,
  `SENTINEL_TENANT_ID`, `AuditActorType`, proven thin the same way.
- `src/modules/identity/contract/terminal-facts.query.ts` and
  `src/modules/organisation/contract/{station-display-binding,
  kds-branch-config}.query.ts` (already part of the accepted Phase 1
  implementation, re-verified unchanged) complete the set — Kitchen's guard
  and services now import exclusively from `identity/contract`,
  `governance/contract`, and `organisation/contract`, plus the
  `${module}.module` DI-composition exemption every module gets.

`src/modules/kitchen/kitchen.module.ts` no longer imports `AuditModule` at
all — `AuditService` is provided by Governance's `@Global()` module, so no
import (public or private) was ever necessary; the prior Phase-1 import was
removed as dead weight, not because it was a boundary violation.

**Test-suite change.** The single Phase-1 test `'Kitchen is not a new
module-boundary deviation (zero new entries)'` (which checked only
`kitchen->organisation`/`kitchen->sales`/`kitchen->catalogue`) was replaced
with a strictly stronger assertion,
`'Kitchen adds ZERO new module-boundary deviations — no private Identity,
Governance, Organisation, Sales, or Catalogue path'`, which additionally
asserts `KNOWN_DEVIATIONS['kitchen->identity']` and
`['kitchen->governance']` are `undefined` **and** that
`violations.filter(v => v.importer === 'kitchen')` is the empty array (a
structural, not enumerated, guarantee). Four new tests were added verifying
the `identity/contract/http.ts` and `governance/contract/audit.ts` files
exist, export the right symbols, pass `containsPersistenceImplementation` as
`false`, and that Kitchen's controller/permissions/guard/operations files
contain zero import lines reaching into the corresponding private
directories. `module-boundaries.spec.ts` grew from 38 tests (HEAD) to 42
(current); the removed test's coverage is a strict subset of its
replacement's.

**Verified:** `npx jest module-boundaries` → **42/42 passing**, current
working tree, this session.

---

## §2. Blocker B — audit ordering invalidated the SERIALIZABLE proof

**Finding.** In `KdsOperationsService.bumpLineTx`/`bumpAllTx`/`recallTx`,
the Phase-1 code called `AuditService.record` (which takes Governance's
per-tenant `pg_advisory_xact_lock`) **before** the readiness-critical
cross-station predicate read and event publish. Because the advisory lock
serializes every KDS bump/recall for a tenant regardless of which Ticket or
station is involved, this ordering meant a passing two-station race test
proved the advisory lock prevented write-skew, not that SERIALIZABLE did —
invalidating the "SERIALIZABLE is load-bearing" claim the accepted design
rests on.

**Fix.** All three methods were reordered so the projection CAS, the
readiness-critical read, and `ctx.publishEvent`/`this.publishTicketBumped`
run **before** `this.audit.record`:

- `bumpLineTx` (`kds-operations.service.ts:298–320`): `projection.apply` →
  `if (projection.transitionedToBumped) { await this.publishTicketBumped(...) }`
  → `await this.audit.record(...)`.
- `bumpAllTx` (`:350–395`, same shape).
- `recallTx` (`:511–535`): `ctx.publishEvent({...})` → `await
  this.audit.record(...)`.

**Stronger proof built on top of the reorder.** Rather than stop at
reordering, this task went further for §5 and **removed the advisory lock
from the write path entirely** for one dedicated test (test H in
`test/kds-concurrency.e2e-spec.ts`, rebuilt against a second app instance
with `AuditService` overridden by a no-op stub), and reran the two-station
same-order-line race. This is a strictly stronger proof than reordering
alone: it shows the outcome (`ready` exactly once, no duplicate audit) holds
with **zero** whole-tenant serialization from the audit lock, so SERIALIZABLE
is doing 100% of the correctness work, not merely running first.

**A genuine defect surfaced by this stronger test, and was fixed.** With the
lock removed, one of the two concurrent `bumpLine` calls began rejecting
instead of retrying. Root-caused (via `console.error` diagnosis, since
removed, tracing through `@prisma/adapter-pg`/`@prisma/driver-adapter-utils`
source) to a third, previously unhandled Prisma 7 driver-adapter error shape:
a raw `DriverAdapterError` (not `PrismaClientKnownRequestError`/
`PrismaClientUnknownRequestError`) with `.cause.originalCode` carrying the
raw SQLSTATE, surfacing when Postgres detects the serialization conflict at
COMMIT rather than mid-transaction. `src/common/domain-events/
serialization-retry.ts` gained `isDriverAdapterSerializationFailure(err)`,
checked by `isSerializationFailure` as a third detection path alongside the
two already-handled shapes (`P2034`, raw `40001`/`40P01` in a
`PrismaClientUnknownRequestError` message). 12 new unit tests in the new
`serialization-retry.spec.ts` cover all three shapes plus negative/edge
cases. This is a real, previously-undetected retry-classifier gap in
production code, found only because this task built a stronger proof than
the minimum the blocker asked for.

**Verified:** `test/kds-concurrency.e2e-spec.ts` — **11/11 passing**
(was 10; test H rebuilt, new D0 guard test added reproducing READ COMMITTED
write-skew for contrast), reproduced clean across 3 consecutive runs during
development and again as part of the final 1014/1014 clean-scratch-DB run
(§7).

---

## §3. Blocker C — amendment Fire into an already-bumped Ticket (reactivation)

**Finding (reproduced, root cause).** `TicketPersistenceService
.getOrCreateTicketLine` is called by `OrderLineFiredHandler` for every
`order.line.fired` event, including an amendment fire (a new `TicketLine`
against an existing, already-routed `Ticket`). In the Phase-1 code, this
method inserted the new line but never re-ran the Ticket-aggregate
projection — so a new `queued` line added to a `bumped` Ticket left the
Ticket's own `status` column stuck at `bumped`, silently excluding the new
line's ticket from the station's active queue (`listStationQueue` filters
`status NOT IN ('bumped','served')`) even though a real line still needed
cooking. This was identified by code inspection (the projection call sites
in `KdsOperationsService` are the only three places `applyTicketProjection`
was invoked in Phase 1, none reachable from the Fire path) and is now
covered end-to-end by `test/kds-amendment.e2e-spec.ts` Test 1, which drives
the real HTTP Fire → KDS bump-all → Fire-again → KDS-queue-visibility path
and fails without the fix below (the ticket would remain `bumped` and
absent from `GET /kds/stations/{id}/queue}` after the second Fire).

**Fix.**
1. `TicketPersistenceService.getOrCreateTicketLine`'s return type changed
   from `Promise<TicketLine>` to
   `Promise<{ line: TicketLine; wasCreated: boolean }>` — both the
   insert-success and the existing-row (idempotent replay) branches now
   report which case occurred.
2. The Ticket-aggregate projection logic (previously a private ~100-line
   method duplicated nowhere, `KdsOperationsService.applyTicketProjection`)
   was extracted verbatim into a new shared `TicketProjectionService`
   (`src/modules/kitchen/tickets/ticket-projection.service.ts`), with a
   single public `apply(tx, tenantId, ticketId, opts)` entry point, so there
   is exactly one implementation of "what status does this Ticket's line set
   imply" for both callers.
3. `OrderLineFiredHandler` now destructures `{ line, wasCreated }` and, gated
   strictly on `wasCreated === true`, calls
   `this.projection.apply(ctx.tx, event.tenantId, ticket.id, { now:
   createdAt })` (`order-line-fired.handler.ts:155–158`). The `wasCreated`
   gate is load-bearing for idempotency: a replay of the exact same
   `order.line.fired` event hits the existing-row branch
   (`wasCreated: false`) and must never re-trigger a projection recompute —
   proven by `kds-amendment.e2e-spec.ts` Test 2, which replays the identical
   persisted event via a direct `unitOfWork.execute` call and asserts no
   second line is created and the Ticket's `version`/`status` are
   byte-unchanged.

**A second, related latent bug found and fixed while investigating this
blocker.** `TicketProjectionService.apply`'s Phase-1 predecessor updated
`readyAt`/`bumpedAt`/`bumpedBy` only when the corresponding column was still
`null` (a write-once-forever guard, correct for `startedAt`/`startedBy` per
FR-KDS-041's "first line start" semantics, but not correct for
`readyAt`/`bumpedAt`). Design gate §14 already specifies `bumped_at` is
"preserved... until a later successful re-bump", which the null-guard
violated on both recall-then-re-bump and this blocker's
amendment-reactivate-then-re-bump path: the timestamp would stay pinned to
the *first* bump forever. Fixed by comparing against the Ticket's *current*
status instead of `null` (`ticket-projection.service.ts:99–108`): the
timestamp refreshes exactly on a genuine transition into `ready`/`bumped`,
not on every write, and not never. `startedAt`/`startedBy` deliberately kept
on the original null-guard (unchanged) since that write-once-forever
semantics is correct per FR-KDS-041.

**Verified:** `test/kds-amendment.e2e-spec.ts` (new, 2 tests) — **2/2
passing** as part of the final clean-scratch-DB run (§7); `test/
kds-concurrency.e2e-spec.ts` and `test/kds-first-viewed.e2e-spec.ts`
re-verified unaffected (11/11, 10/10).

---

## §4. Blocker D — first-viewed semantics for amendment lines

**Finding.** `KdsOperationsService.acknowledgeViewed` stamped
`Ticket.firstViewedAt` write-once (correct) but, in Phase 1, stamped
`TicketLine.firstViewedAt` **only for tickets that were newly stamped in
that same call** — so a `TicketLine` added by an amendment to an
**already**-viewed Ticket could never be acknowledged at the line level:
`firstViewedAt` would stay `null` on that line forever, since the ticket
itself would never again pass the `firstViewedAt: null` filter that gated
line stamping.

**Fix.** `acknowledgeViewed` was rewritten
(`kds-operations.service.ts:108–194`) into three decoupled steps:
1. Resolve `authorizedTickets`/`authorizedIds` (tenant + station filter) —
   unchanged tenant/station-safety semantics.
2. Stamp `Ticket.firstViewedAt` write-once, scoped to `authorizedIds` —
   unchanged from Phase 1.
3. Stamp `TicketLine.firstViewedAt` write-once, scoped to **all**
   `authorizedIds` (not merely the tickets newly stamped in step 2) — this is
   the fix. An amendment line on an already-viewed ticket is now reachable.

**Audit cardinality (chosen: Option A).** One `TICKET_VIEWED` audit entry per
ticket with *any* newly-stamped fact this call — the ticket's own first
view, OR at least one newly-viewed line on an already-viewed ticket — never
one entry per line (preserving design gate §23's one-operator-action audit
convention). `affectedTicketIds = new Set([...newlyStampedTicketIds,
...newLineIdsByTicket.keys()])`; metadata carries
`{ stationId, ticketFirstViewed: boolean, newlyViewedLineIds: string[],
firstViewedAt }` so a reader can distinguish "first view of this ticket"
from "amendment line(s) viewed on an already-viewed ticket" without needing
a second audit action code. A pure replay (zero rows changed by either
`UPDATE ... RETURNING`) writes zero audit entries, matching the existing
write-once discipline.

**New tests.** `test/kds-first-viewed.e2e-spec.ts` gained a
`describe('after an amendment line is added to an already-viewed ticket
(§9/§10/§11)', ...)` block (4 new tests, A–D) covering: a new line becomes
viewable and is stamped; the audit entry fires with correct
`ticketFirstViewed: false`/`newlyViewedLineIds`; a replay writes nothing
further; a rollback (injected `AuditService.record` failure) removes both
the line stamp and any ticket-level stamp made in the same call, together.
File grew from 6 to 10 tests.

**Verified:** `test/kds-first-viewed.e2e-spec.ts` — **10/10 passing**, both
standalone and as part of the final clean-scratch-DB run (§7).

---

## §5. Blocker E — clean-from-zero full-suite verification

See §7 (this section documents the corrected reproduction claim only; the
executed verification is reported once, in §7, to avoid duplicating test
numbers in two places).

**Correction to the Phase-1 report's framing.** The Phase-1 implementation
report attributed `organisation.e2e-spec.ts` and `approval-runtime
.e2e-spec.ts` failures to accumulated state in the persistent `ros`
development database (orphaned `org.locations` rows dated 2026-08-23
through 2026-08-28 predating that session; column-GRANT history drift), not
to the migration SQL, which was independently re-verified correct by direct
inspection at the time. §7 below re-verifies this claim is actually true by
running the full suite against a truly from-zero database rather than
repeating the prior report's reasoning.

---

## §6. Blocker F — queue-index claim verification/correction

**Finding.** `TicketReaderService.listStationQueue`'s Phase-1 code comment
claimed the query used the composite index `[tenantId, branchId, stationId,
status, routedAt]`. This claim was not re-derived from `EXPLAIN`; it was
carried from the design document.

**Verification performed.** `EXPLAIN (ANALYZE, BUFFERS)` was run against
real data (both a 0-row and an 18-row case) for the query as originally
written (missing `branchId` in the `WHERE` clause) and again after adding
`branchId`. Findings, **both corrected in the code comment
(`ticket-reader.service.ts:103–139`), not merely re-asserted**:

1. **The original comment's index claim was wrong.** PostgreSQL actually
   satisfies this query from `@@index([tenantId, branchId, stationId,
   targetReadyAt])` — a *different* index than the one named — because both
   composite indexes on this table share the identical 3-column leading
   prefix `(tenantId, branchId, stationId)`, which is the only part either
   index can contribute: `status NOT IN (...)` is never sargable as an Index
   Cond in a b-tree (only ever a Filter, regardless of which index is
   chosen), and neither index's trailing column matches the `ORDER BY
   (routedAt, id)` once `status` is a negated condition, so an explicit
   `Sort` node is unavoidable either way.
2. **The `branchId` fix is correct and worth keeping even though the named
   index was wrong.** Supplying `branchId` (previously omitted on the
   reasoning that it is implied by `stationId` at the data level, which is
   true, but not sufficient at the query-planning level — a composite
   b-tree index's later columns cannot tighten the scanned range unless
   every column before them is *also* bound) measurably tightened the Index
   Cond and roughly halved buffer reads/execution time in the captured
   plans. `ListStationQueueInput` gained `readonly branchId: string`; the
   caller (`kitchen.controller.ts`) already resolves the terminal-bound
   station's branch via `KdsStationGuard`, so supplying it costs nothing.
3. Fixing which *named* index this query "should" use would require a new,
   partial index covering `status` as a non-leading column — explicitly out
   of scope (no migration authorized this task).

**Classification for this finding: CORRECTED, not VERIFIED** — the original
claim was inspected and found wrong, and the report states this plainly
rather than reasserting the original claim under new cover.

---

## §7. Clean scratch-database verification (§13 requirement)

**Construction.** A fresh Postgres database, `ros_scratch_test`, was created
inside the *same* Docker Postgres instance the persistent `ros` development
database already runs in (no new container) — `CREATE DATABASE
ros_scratch_test OWNER ros_migrator;` — reusing the existing server-level
`ros_migrator`/`ros_app` roles (`docker/postgres/init/01-init-app-role.sh`
creates these once per Postgres instance, not per database), with `GRANT
CONNECT ON DATABASE ros_scratch_test TO ros_app;` issued explicitly (table/
schema/RLS grants are issued by the migrations themselves, not by the
init script). `DATABASE_URL` (as `ros_migrator`) was pointed at
`ros_scratch_test` and `npx prisma migrate deploy` applied all **34**
committed migrations cleanly from zero — confirmed by the CLI's "All
migrations have been successfully applied." output enumerating every
migration folder from `20260812124345_identity_users_credentials` through
`20260830020000_treasury_cashsession_close`, and independently re-confirmed
via `npx prisma migrate status` → "Database schema is up to date!". Grant
correctness was spot-checked directly with `psql \dp` against
`kitchen.tickets` (RLS policies + `ros_app=arwd` present) and
`governance.approval_decisions` (column-level `ros_app` grants + RLS
policies present, matching the persistent database's established shape) —
confirming the grants live in migration SQL, not accumulated database
history, which is exactly what the Phase-1 report's `approval-runtime
.e2e-spec.ts` attribution depended on. Both `DATABASE_URL` (as
`ros_migrator`) and `APP_DATABASE_URL` (as `ros_app`) were pointed at
`ros_scratch_test` for the test run. **The persistent `ros` database was
never written to by this task** — no command in this session's history
targeted it; it was only read once, incidentally, via the unmodified `.env`
file to obtain the `ros_app` password for the scratch database's own
`APP_DATABASE_URL`.

**Full e2e suite run (no exclusions).**

```
NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json --runInBand
```

against `ros_scratch_test`:

- **Run 1** (before a same-session lint-only edit described in §8): **Test
  Suites: 51 passed, 51 total. Tests: 1014 passed, 1014 total.**
- **Run 2** (final, after the §8 lint fix to `test/
  kds-first-viewed.e2e-spec.ts`, re-run in full against the same scratch
  database to reconfirm nothing regressed): **Test Suites: 51 passed, 51
  total. Tests: 1014 passed, 1014 total.**

**Zero failures, zero exclusions, on both runs.** `organisation.e2e-spec.ts`
and `approval-runtime.e2e-spec.ts` are both included in the 51 suites and
both pass clean from zero — confirming the Phase-1 report's attribution
(persistent-database accumulated state, not a migration or application
defect) was correct, verified here directly rather than re-asserted.
Per the task's own instruction, this arithmetic is reported exactly as
measured: **1014/1014**, not "all passing" asserted without a number, and
not the Phase-1 baseline's **1004/1007** repeated as if unchanged.

**Scratch database disposition.** `ros_scratch_test` was dropped
(`DROP DATABASE ros_scratch_test;`) immediately after verification
completed. It was a single-purpose, one-time verification database, not
part of the repository's normal dev/test workflow (which uses the
persistent `ros` database per `.env`); nothing was left behind.

---

## §8. §14 consolidated verification checklist

All items below were executed in this session, against the current
(uncommitted) working tree, after all six blocker fixes were in place.

| Check | Command | Result |
|---|---|---|
| Git diff whitespace | `git diff --check` | Clean (exit 0) |
| Prisma schema validity | `npx prisma validate` | "The schema at prisma/schema.prisma is valid" |
| TypeScript | `npx tsc --noEmit -p tsconfig.json` | **1 pre-existing error, out of scope** (see below) — zero errors in any file this task touched |
| Lint | `npx eslint --fix` scoped to this task's 45 touched `.ts` files | 0 errors, 0 warnings (1 warning fixed — see below) |
| Unit suite | `npx jest` | **789/789 passing, 58/58 suites** |
| Module-boundary suite | `npx jest module-boundaries` | **42/42 passing** (§1) |
| Full e2e suite (clean scratch DB) | see §7 | **1014/1014 passing, 51/51 suites**, twice |
| KDS e2e suites (all, within the above) | — | authorization, first-viewed (10/10), concurrency (11/11), operator-lifecycle, amendment (2/2) — all included and passing in the 1014/1014 total |
| OpenAPI drift | `npm run openapi:generate` (idempotency check: `md5` before/after a second regenerate) | **Idempotent — byte-identical.** `npm run openapi:check`'s own `git diff --exit-code` exits 1 only because the (correct, regenerated) working tree differs from the last **commit** `121b889`, which is expected and correct for uncommitted feature-branch work; the recall route (`/kds/tickets/{ticketId}/recall`) is present and correctly documented |

**Pre-existing `tsc` error, confirmed out of scope.** `src/modules/identity/
auth/access-token.service.spec.ts:28` fails `TS2322` (`expiresIn?: string`
not assignable to `jsonwebtoken`'s `number | StringValue | undefined`). This
file is **not** in this session's `git status` (untouched, unmodified since
its last commit `48a16f9`, 2026-08-12, predating this entire KDS slice) and
is unrelated to Kitchen/Identity-contract/Governance-contract work. Left
uncorrected per this task's explicit "do not expand scope" instruction;
reported here rather than silently ignored, as a genuine pre-existing
repository defect (likely a `@types/jsonwebtoken`/`ms` version-drift issue)
for a separate task to fix.

**Lint fix made (in scope).** Scoping `eslint --fix` to exactly the 45
`.ts` files this task's `git status` shows as touched (Phase 1 + Phase 2
combined KDS file set) surfaced 54 pre-existing, mechanically-fixable
Prettier-formatting deltas (auto-corrected, no semantic change) and one
genuine `@typescript-eslint/no-unsafe-argument` warning at `test/
kds-first-viewed.e2e-spec.ts:230` — `failingApp.getHttpServer()` on a
locally-created `TestingModule` whose `INestApplication` return type wasn't
annotated `<App>` the way the file's primary `app` variable already is.
Fixed with a one-line type annotation
(`const failingApp: INestApplication<App> = failingModule
.createNestApplication();`), re-lint clean (0/0), `tsc` clean, and the
affected suite re-run standalone (10/10) and as part of the final 1014/1014
clean-scratch-DB run. An unscoped repo-wide `eslint --fix` was deliberately
**not** run — it found unrelated pre-existing Prettier debt in untouched
files (`src/modules/treasury/*`, `test/cash-session-close.e2e-spec.ts`,
`test/cash-movements-close-and-payment-concurrency.e2e-spec.ts`) and one
pre-existing `@typescript-eslint/require-await` error in
`cash-session-close.e2e-spec.ts:145`; auto-fixing those files would have
silently expanded this task's diff into unrelated modules, which the task's
own scope-discipline instructions forbid. Reported, not fixed.

**Sales-side regressions (within the 1014/1014 total, not separately
re-run).** `TicketBumpedHandler`/`TicketRecalledHandler` (`src/modules/
sales/orders/ticket-{bumped,recalled}.handler.ts`, unchanged this task)
continue to pass their existing tests; the amendment suite's Test 1 also
exercises Sales readiness state directly (both lines end `ready` after their
respective bumps) as part of its real-HTTP flow, and the concurrency suite's
existing Sales-subscriber-rollback tests (bump and recall) are included
unchanged in the 11/11 count.

---

## §9. Schema / migration statement

**No migration was created or modified.** `prisma/schema.prisma` was not
modified. The scratch database in §7 applied the same 34 already-committed
migrations the persistent `ros` database has (re-verified: `npx prisma
migrate status` against the scratch DB reports "up to date" with 34
migrations found, matching the persistent DB's migration count cited in
this INDEX's most recent prior entries).

---

## §10. Deferred KDS scope — unchanged, not touched

Consistent with KDS-R11/KDS-R12 as ratified (`2026-08-30_KDS_
operator-lifecycle-user-ratification.md`) and the Phase-1 implementation's
own stated fence, this task did not implement, and did not need to touch:
`served`/Expediter routing, line/ticket cancellation-from-KDS, colour/
urgency thresholds, KDS analytics, offline KDS operation, ACT-10/FR-KDS-013
multi-station breadth beyond the ratified exactly-one-station rule, or any
standard-role seeding. No new permission code, no new domain event type
beyond the already-ratified `ticket.recalled`, no HTTP route added or
removed.

---

## §11. Residual risks

1. **`tsc --noEmit` has one pre-existing, unrelated failure repository-wide**
   (§8) — does not block this task's acceptance but should be tracked
   separately; it will surface in any future full-repo type-check run
   regardless of this task.
2. **Repo-wide Prettier/lint debt exists outside this task's files** (§8,
   treasury/cash-session-close test files) — not introduced by this task,
   not fixed by this task, will surface in any future unscoped `npm run
   lint` run.
3. **The queue-index correction (§6) does not add a covering index** — the
   `status NOT IN (...)` predicate remains a Filter, not an Index Cond,
   under both composite indexes that exist today. A future migration adding
   a partial index on `status` would tighten this further but is out of
   this task's authorization.
4. **The SERIALIZABLE retry classifier now handles three known Prisma-7/
   driver-adapter-pg error shapes** (§2); a future Prisma upgrade could in
   principle introduce a fourth undocumented shape. `serialization-retry
   .spec.ts`'s 12 tests pin the three currently-known shapes exactly, so a
   regression in Prisma's own error surface would show as a new e2e
   concurrency-test failure, not a silent miss.

---

## §12. Files changed by this task (on top of the accepted Phase-1 baseline)

Modified: `src/common/domain-events/unit-of-work.ts` (Phase-1, unchanged
this task — retry option shape reused, not altered),
`src/modules/governance/contract/index.ts`, `src/modules/identity/
contract/index.ts`, `src/modules/kitchen/kitchen.module.ts`,
`src/modules/kitchen/kitchen.controller.ts` (import paths only),
`src/modules/kitchen/auth/kds-station.guard.ts` (import paths only),
`src/modules/kitchen/kitchen.permissions.ts` (import path only),
`src/modules/kitchen/tickets/kds-operations.service.ts`,
`src/modules/kitchen/tickets/ticket-persistence.service.ts`,
`src/modules/kitchen/tickets/ticket-reader.service.ts`,
`src/modules/kitchen/tickets/order-line-fired.handler.ts`,
`src/common/domain-events/serialization-retry.ts`,
`src/modules/module-boundaries.spec.ts`,
`test/kitchen-ticket-concurrency.e2e-spec.ts`,
`test/kds-concurrency.e2e-spec.ts`, `test/kds-first-viewed.e2e-spec.ts`,
`docs/api/openapi.json`, `docs/api/openapi.yaml` (regenerated, additive
only — the recall route and the widened bump payload, both already part of
the accepted Phase-1 route surface).

New: `src/modules/identity/contract/http.ts`,
`src/modules/governance/contract/audit.ts`,
`src/modules/kitchen/tickets/ticket-projection.service.ts`,
`src/common/domain-events/serialization-retry.spec.ts`,
`test/kds-amendment.e2e-spec.ts`.

No file outside this list, and outside the already-uncommitted Phase-1 KDS
file set, was modified by this task. `docs/governance/
GOVERNANCE_DECISION_REGISTER.md`'s uncommitted 299-line P1G-1 ratification
addition predates this task and was not touched (re-verified: `git diff
--stat` shows only insertions, last commit `121b889`, untouched by any
command this session issued).

---

## VERDICT

**A. CLEAN — READY FOR FINAL ACCEPTANCE.**

All six identified blockers (A–F) are corrected and verified in code, not
merely reasoned about: KNOWN_DEVIATIONS gained zero kitchen->* entries
(§1); the SERIALIZABLE proof no longer depends on the audit advisory lock,
and a genuine retry-classifier gap the stronger proof exposed is fixed
(§2); the amendment-reactivation defect is fixed and covered by a real-HTTP
end-to-end test (§3); first-viewed semantics correctly cover amendment
lines added to an already-viewed ticket (§4); the queue-index claim is
corrected, not merely re-asserted (§6); and the full e2e suite passes
**1014/1014** across 51/51 suites, twice, against a truly from-zero scratch
database with no pre-existing-dirty-DB exclusions (§7, closing Blocker E).
One pre-existing, unrelated `tsc` defect and pre-existing lint debt outside
this task's files are reported, not fixed, per this task's own scope
discipline (§8, §11). No migration, no schema change, no commit, no push,
no governance edit, and no deferred-feature scope creep occurred.
