# DEMO-MANAGER-CASH-SESSIONS-P0 — Manager Discovery of Stranded Open Cash Sessions

**Report type:** Investigation + implementation (permission-authority trace,
new branch-scoped read route, targeted tests, OpenAPI regeneration).

**Authority statement:** This report is non-authoritative evidence. The SRS
(`ROS_SRS_v1.0.pdf`) and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. The
permission choice recorded here (reusing `cash.session.close_other` as the
read authority) is a documented engineering judgment applying existing
ratified precedent (D-20's "defer, don't invent" rule, and the
`GET /cash-sessions/current` read-half-of-a-write precedent from
DEMO-CASH-SESSION-RECOVERY-P0), not a new ratification.

**Date:** 2026-09-08

**HEAD at start:** `23630234a1a75b27983bb1f52b48357de60f7d88`
(`2363023` — `feat: add POS cash-session recovery read`)

**Branch:** `full-srs/lane-d4-reporting-demo`

**Working tree summary at start:** `docs/reports/claude/INDEX.md` modified
(pre-existing, unrelated edit — untouched here beyond this report's own
append); untracked
`docs/reports/claude/2026-09-08_DEMO-RELEASE-BRANCH-RECOVERY-P0_render-build-break-diagnosis.md`
(prior, unrelated report — untouched). No other changes present before this
task began.

**Task identifier:** `DEMO-MANAGER-CASH-SESSIONS-P0`

---

## 1. Production symptom and the gap

A POS cashier (`cashtest`) sees `GET /cash-sessions/current -> 200
{"cashSession": null}` (no *own* open session — that route,
DEMO-CASH-SESSION-RECOVERY-P0, is scoped to the caller's own
`(terminalId, employeeId)`), yet drawer `fin-test` is already occupied:
`POST /cash-sessions` on it returns `409 "That drawer already has an open
cash session"`. The session is real, `cash.session.close_other` manager
close-other already exists and is fully implemented
(`GET .../close-context`, `POST .../close`, `POST .../close/finalize` on
`TreasuryController`) — but there was **no route to discover the
`sessionId`** of that stranded session, or which employee/drawer it belongs
to. This is a pure discovery gap, not a close-other gap.

## 2. Authority trace

Traced `src/modules/treasury/treasury.permissions.ts` and
`src/modules/identity/authz/canonical-role-templates.ts`:

- `cash.session.close_other` — "Close another user's shift" — already seeded
  (P1G-1 migration 34), already granted to `shift_supervisor` (and to
  `Owner`, which is granted every permission at signup —
  `registrations.service.ts`), and **deliberately withheld from Cashier**.
  `cash-session-close.e2e-spec.ts`'s "own/other authority" suite already
  proves the full close-other workflow (`close-context`/`close`/`finalize`)
  works correctly for a holder of this code.
- No existing route reads "which sessions are open at a branch". The
  closest reads are `GET /cash-sessions/current` (own session only,
  `cash.session.open`) and `GET /branches/:branchId/drawers`
  (drawer *rows*, not session state, gated on
  `settings.branch.manage`) — neither discloses another employee's session
  ownership or `sessionId`.

**Decision:** reuse `cash.session.close_other` as the read authority,
exactly as the mission's own steer prefers. It is semantically exact: a
manager who may close another employee's session at a branch may see which
sessions exist to close — this is the READ HALF of that WRITE authority, the
identical relationship `GET /cash-sessions/current` already bears to
`cash.session.open` (a precedent this same repository established one task
ago). No permission is invented, `cash.session.open` is not reinterpreted as
a manager-wide read, and Cashier is not widened.

## 3. Route design

New file: `src/modules/treasury/cash-sessions/open-cash-sessions.controller.ts`
(`OpenCashSessionsController`), registered in `treasury.module.ts`.

```
GET /branches/{branchId}/cash-sessions/open
@AuthorizationTarget(branchFromParam('branchId'))
@RequirePermission(cash.session.close_other)
```

**Why a NEW controller, not `TreasuryController`:** `TreasuryController`
carries `@AllowPosSession()` at the CLASS level
(`treasury.controller.ts:344`), and `JwtAuthGuard`'s `getAllAndOverride`
means a route with no route-level override inherits that class-level `true`
— there is no "opt back out" mechanism anywhere in this codebase. Adding the
discovery route there would make it POS/PIN-reachable, contradicting the
mission's explicit "non-POS console session" requirement. The new route
instead follows the proven `DrawersController` /
`CashClosePolicyController` precedent: same `/branches/...` resource family,
no `@AllowPosSession`, so `JwtAuthGuard` refuses a PIN-issued session by
default (FR-SEC-021).

**Branch scope, never trusted:** `branchId` is a client-supplied path
param, exactly like `GET /branches/:branchId/drawers`, but
`@AuthorizationTarget(branchFromParam('branchId'))` resolves it through
`PermissionGuard` BEFORE the handler runs — invisible/cross-tenant branch →
404 (`AuthorizationTargetResolver.finalizeBranchTarget`); visible but not
covered by the caller's own scoped grants → 403
(`ScopeAuthorizationService.assertAuthorized`). `CashSessionsService
.listOpenForBranch` re-checks branch existence itself too (defense in
depth, mirroring `DrawersService.listForBranch`'s own precedent) — via
Organisation's published `BRANCH_CURRENCY_QUERY` contract, never a direct
`tx.branch.*` query (SRS §5.2.3 — this was caught by
`cash-session-close.db-ownership.spec.ts`'s existing architecture scan
during implementation and fixed before commit; see §6).

**Response fields** (`toOpenCashSessionView`, `treasury.views.ts`):
`sessionId`, `branchId`, `drawerId`, `drawerName`, `employeeId`,
`employeeName`, `status` (`open`/`closing`), `openedAt`, `openingFloat`
(minor-unit string), `currency` — resolved via `CashSession.drawer.name`
and `CashSession.employee.displayName` in one query (no N+1). No movement
history, no close/variance internals, no tenant-wide listing.

**Status filter:** `open` AND `closing` are both returned. A `closing`
session (frozen above-tolerance, mid `declareClose`/`finalizeClose`) is
exactly as "stranded" from a manager's point of view as an `open` one —
both need the same close-other workflow to resolve. `closed` sessions are
never returned (nothing left to discover once reconciled).

## 4. Close-other compatibility — no second close endpoint

No new close/force-close/force-delete route was added. Every `sessionId`
this route returns is a real primary key on `cash_sessions`, usable
unmodified by the three EXISTING routes:
`GET /cash-sessions/{id}/close-context`, `POST /cash-sessions/{id}/close`,
`POST /cash-sessions/{id}/close/finalize` — proven directly in this
session's own test run (§5, items E/F/G), not merely asserted. Those three
routes still require a terminal-bound (POS) identity
(`TreasuryController#requirePosIdentity`), so completing the workflow on a
discovered id uses the manager's PIN/POS token, while discovery itself uses
the manager's dashboard token — two tokens, one identity, mirroring how a
real manager checks the back-office console and then acts at the terminal.

## 5. Tests

New file: `test/cash-sessions-open-discovery.e2e-spec.ts` (7 tests, all
passing). Does not re-prove close-other's own business rules from scratch —
those stay owned by `cash-session-close.e2e-spec.ts`'s existing "own/other
authority" suite (re-run this session, still green, unmodified).

| Mission item | Test | Result |
|---|---|---|
| A. authorized manager sees branch open sessions | `'A/B: sees open sessions at their branch, with drawer + employee ownership fields'` | PASS |
| B. drawer + employee ownership fields present | same test — asserts `drawerId`/`drawerName`/`employeeId`/`employeeName` match the fixture | PASS |
| C. cannot see unauthorized branch | `'C: cannot see sessions at an unauthorized branch'` (manager's `close_other` grant scoped to branchA only; branchB request → 403) | PASS |
| D. cashier without `close_other` cannot enumerate | `'D: cannot enumerate other sessions'` (dashboard-authenticated plain cashier → 403) | PASS |
| E. closed sessions not returned | proven twice inline in the E/F/G test — once a `within`-tolerance session is closed, and again after the `above`-tolerance session is finalized, both drop off the list | PASS |
| F. returned id completes existing close-other workflow | same test — `close-context` (200) → `declare` (201, closes immediately, within tolerance) on a discovered id | PASS |
| G. close-other still performs count/variance/finalize rules | same test — an `above`-tolerance declare on a discovered id still freezes to `closing` with `approvalRequired: true` and the correct `varianceMinorUnits`, and requires a genuine `finalize` (manager PIN, `cash.variance.approve`, self-approval-as-requester still enforced) to close | PASS |
| (extra) unauthenticated request | `'rejects an unauthenticated request'` | PASS (401) |
| (extra) POS/PIN session on this dashboard-only route | `'rejects a POS/PIN session — this is a dashboard-only route'` | PASS (403) |
| (extra) unknown branch | `'unknown branch id -> 404'` | PASS (404) |

Regression check this session (all green, unmodified logic):
`cash-session-close.e2e-spec.ts` (32 tests), `cash-session.e2e-spec.ts`,
`cash-session-recovery.e2e-spec.ts`, `cash-session-cashier-role.e2e-spec.ts`,
`openapi.e2e-spec.ts` (49 tests) — 148 e2e tests total across the six files
run together, plus the full unit suite (`npx jest`, 1159 tests, 84 suites)
and `src/modules/authorization-coverage.spec.ts` +
`src/modules/module-boundaries.spec.ts` (55 tests) run separately.

## 6. A real defect caught and fixed during implementation

The first draft of `CashSessionsService.listOpenForBranch` queried
`tx.branch.findUnique(...)` directly to check branch existence. The
pre-existing architecture test
`cash-session-close.db-ownership.spec.ts` (SRS §5.2.3 database-ownership
scan, scoped to `cash-sessions/` and `cash-session-close/`) correctly failed
on this — Organisation owns the `Branch` table. Fixed by reusing the SAME
published `BRANCH_CURRENCY_QUERY` contract `CashSessionsService.open`
already uses for the identical check, inside the same transaction (SRS
§5.5.1). Re-ran the full unit suite after the fix: 1159/1159 passing, zero
architecture-scan failures.

## 7. OpenAPI

`npm run openapi:generate` run twice (once before, once after the lint
auto-fix pass) — both times the diff to `docs/api/openapi.json` /
`openapi.yaml` is exactly the one new route
(`GET /branches/{branchId}/cash-sessions/open`, its request/response
schema, and its `401`/`403`/`404` error responses). No unrelated drift.
`test/openapi.e2e-spec.ts`'s drift-detection suite (49 tests) passes against
the regenerated artifacts.

## 8. Verification run (this session, HEAD as recorded above)

- `npx tsc --noEmit` — clean.
- `npx eslint <changed files>` — clean after one `--fix` pass (formatting
  only; one real fix, the unused `employeePlainCashier` test variable,
  applied by hand).
- `npx jest` (unit) — 84 suites / 1159 tests passing.
- `npx jest src/modules/authorization-coverage.spec.ts
  src/modules/module-boundaries.spec.ts` — 2 suites / 55 tests passing.
- e2e (`test/jest-e2e.json`) — `cash-sessions-open-discovery.e2e-spec.ts`,
  `cash-session-close.e2e-spec.ts`, `cash-session.e2e-spec.ts`,
  `cash-session-recovery.e2e-spec.ts`, `cash-session-cashier-role.e2e-spec.ts`,
  `openapi.e2e-spec.ts` — 6 suites / 148 tests passing.
- `npm run build` (`nest build`) — clean, run twice (before and after the
  lint auto-fix pass).
- `npm run openapi:generate` — clean, diff limited to the new route.

## 9. Files changed

- `src/modules/treasury/cash-sessions/open-cash-sessions.controller.ts` —
  new, `OpenCashSessionsController`.
- `src/modules/treasury/cash-sessions/cash-sessions.service.ts` — added
  `listOpenForBranch(tenantId, branchId)`.
- `src/modules/treasury/treasury.views.ts` — added `toOpenCashSessionView`.
- `src/modules/treasury/treasury.module.ts` — registered the new
  controller; docblock updated.
- `src/modules/treasury/treasury.controller.ts` — docblock updated to
  cross-reference the new route (no route/behavior change).
- `test/cash-sessions-open-discovery.e2e-spec.ts` — new, 7 tests.
- `docs/api/openapi.json`, `docs/api/openapi.yaml` — regenerated.

---

## Answers to the mission's return block

```
EXISTING_MANAGER_READ_ROUTE:
  None. GET /cash-sessions/current (own session only) and
  GET /branches/:branchId/drawers (drawer rows, not session ownership,
  gated on settings.branch.manage) are the closest precedents; neither
  discloses another employee's session id, ownership, or status.

PERMISSION_USED:
  cash.session.close_other (existing, unmodified). Already granted to
  Shift Supervisor and Owner; deliberately withheld from Cashier. No new
  permission invented; Cashier not widened.

NEW_ROUTE:
  GET /branches/{branchId}/cash-sessions/open
  (project-convention equivalent of the mission's suggested
  GET /cash-sessions/open — moved to the /branches/... family because
  TreasuryController's class-level @AllowPosSession has no per-route
  opt-out, and this route must be non-POS.)

RESPONSE_FIELDS:
  sessionId, branchId, drawerId, drawerName, employeeId, employeeName,
  status (open|closing), openedAt, openingFloat (minor-unit string),
  currency.

BRANCH_SCOPE:
  branchId path param, resolved via @AuthorizationTarget(branchFromParam)
  — never client-trusted: invisible/cross-tenant branch -> 404; visible
  but outside the caller's authorized-branch grants -> 403. Re-validated
  again in CashSessionsService.listOpenForBranch via Organisation's
  published BRANCH_CURRENCY_QUERY contract (no direct Branch table access
  — SRS §5.2.3).

CASHIER_ACCESS:
  Refused (403) — proven by test item D. A Cashier holds no
  cash.session.close_other grant.

CLOSE_OTHER_REUSE:
  100% reused, unmodified. No second close/force-close endpoint added.
  Every discovered sessionId passes unmodified into the EXISTING
  GET .../close-context, POST .../close, POST .../close/finalize routes
  — proven live in this session's own test run (items E/F/G), including
  the full count/variance/finalize/self-approval rules still applying.

TESTS:
  test/cash-sessions-open-discovery.e2e-spec.ts — 7/7 passing (items
  A-G plus unauthenticated/POS-session/unknown-branch). Full regression
  set (148 e2e tests across 6 files, 1159 unit tests, 55 architecture
  tests) green — see §5/§8.

OPENAPI:
  Regenerated (npm run openapi:generate). Diff limited to the one new
  route; test/openapi.e2e-spec.ts drift suite passes.

TYPECHECK:
  npx tsc --noEmit — clean.

BUILD:
  npm run build — clean.

BACKEND_COMMIT:
  Not yet committed as of this report — see chat response for commit
  status (policy: do not commit unless explicitly instructed).

FRONTEND_HANDOFF:
  A manager console screen can call
  GET /branches/{branchId}/cash-sessions/open with the manager's
  DASHBOARD token to list stranded sessions, then hand the returned
  sessionId to the EXISTING close-other flow (close-context -> close ->
  close/finalize as needed) using a terminal-bound (PIN/POS) token for
  that manager, exactly as today. No frontend contract changes to the
  close-other routes themselves.

SAFE_TO_DEPLOY:
  Yes, on the evidence gathered this session: additive read-only route,
  reuses an existing granted permission, no change to any write path,
  full regression suite green, OpenAPI drift-free. Final authority for
  a demo/production deploy decision rests with the user/SRS governance
  process, not this report.
```
