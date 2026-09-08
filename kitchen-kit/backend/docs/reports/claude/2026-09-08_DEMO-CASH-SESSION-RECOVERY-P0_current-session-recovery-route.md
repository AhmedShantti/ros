# DEMO-CASH-SESSION-RECOVERY-P0 — Open Cash Session Recovery After Reload/Deploy

**Report type:** Investigation + implementation (backend contract trace, reproduction, new read route, targeted tests).

**Authority statement:** This report is non-authoritative evidence. The SRS
(`ROS_SRS_v1.0.pdf`) and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. Where
this report states a design decision (the recovery-route permission choice,
in particular), it is a documented engineering judgment applying existing
ratified precedent (`D-20`, the `GET /cash-sessions/drawers` precedent), not
a new ratification.

**Date:** 2026-09-08

**HEAD at start:** `0c0abf0` (`feat: add GET /catalogue/pos-menu — real POS-safe branch menu read`)

**Branch:** `full-srs/lane-d4-reporting-demo`

**Working tree summary at start:** `docs/reports/claude/INDEX.md` modified
(unrelated prior edit, untouched here beyond this report's own append);
untracked `docs/reports/claude/2026-09-08_DEMO-RELEASE-BRANCH-RECOVERY-P0_render-build-break-diagnosis.md`
(prior, unrelated report — untouched). No other changes present before this
task began.

**Task identifier:** `DEMO-CASH-SESSION-RECOVERY-P0`

---

## 1. Current cash session model (traced from source)

**Controller:** `src/modules/treasury/treasury.controller.ts`
(`TreasuryController`, `@Controller('cash-sessions')`).

| Route | Permission | Purpose |
|---|---|---|
| `GET /cash-sessions/drawers` | `cash.session.open` | Caller's own terminal-bound branch's drawers (DEMO-OPS-HOTFIX-3, pre-existing) |
| **`GET /cash-sessions/current`** | `cash.session.open` | **NEW (this task)** — caller's own open session, if exactly one |
| `POST /cash-sessions` | `cash.session.open` | Open a shift + cash session (`OPEN_ROUTE`) |
| `POST /cash-sessions/{id}/pay-in` | `cash.payin` | FR-POS-091 |
| `POST /cash-sessions/{id}/pay-out` | `cash.payout` | FR-POS-091 |
| `POST /cash-sessions/{id}/safe-drop` | `cash.safedrop` | FR-POS-091 |
| `GET /cash-sessions/{id}/close-context` | `cash.session.close` OR `cash.session.close_other` | FR-POS-094/095 |
| `POST /cash-sessions/{id}/close` | `cash.session.close` OR `cash.session.close_other` | FR-POS-094/096/097 (declare count) — the own/other split (`OWN_CLOSE_ROUTE` / `CLOSE_OTHER_ROUTE_EXISTING`) |
| `POST /cash-sessions/{id}/close/finalize` | `cash.session.close` OR `cash.session.close_other` | FR-FIN-006 (manager decision on above-tolerance close) |

**DTOs** (`treasury.dto.ts`): `OpenCashSessionDto` (client ULIDs `shiftId`,
`cashSessionId`, `drawerId`, `openingFloat` as an exact minor-unit string;
tenant/branch/employee/terminal/currency are never client-supplied — derived
from the trusted POS session). `CashMovementDto` for pay-in/out/safe-drop.

**`OPEN_SESSION_LIST_ROUTE`: did not exist before this task.** `GET
/cash-sessions/{id}` was, and remains, deliberately absent — proven by the
pre-existing e2e assertion `'exposes the session to internal callers only,
never over HTTP'` (`test/cash-session.e2e-spec.ts:400`), which asserts a 404
on a real id. `CashSessionsService.findOne` (by-id) stays internal-only; see
§3 for why the new `current` route is not a reopening of that decision.

**Statuses** (`CashSessionStatus` enum, `prisma/schema.prisma:2956`): `open`,
`closing`, `closed`. `closing` is the P1G-1 above-tolerance frozen state
between `declareClose` and `finalizeClose`; it plays no part in this task
(recovery only concerns `open`).

**Uniqueness constraints** (verified against
`prisma/migrations/20260820160000_shift_drawer_cash_session_open/migration.sql`
and `CashSessionsService.open`):

- **Drawer:** `uq_one_open_session_per_drawer` — a PARTIAL UNIQUE INDEX on
  `drawer_id WHERE status = 'open'`. Exactly ONE open session per drawer at a
  time (FR-FIN-001). This is the ONLY database-enforced open-session
  uniqueness.
- **Employee:** **no uniqueness constraint exists.** FR-FIN-002 requires a
  session be bound to exactly one employee (enforced by `employee_id NOT
  NULL` + the four-column shift FK), not that an employee hold at most one
  open session. Nothing in the schema stops one employee legitimately
  holding two open sessions on two different drawers at the same branch —
  see §3 for how the new route handles that.
- **Branch:** derived, not separately constrained — `cash_sessions.branch_id`
  is required equal to the drawer's own branch via a composite FK
  (`drawer_id, branch_id`).

---

## 2. Reproducing the recovery failure

Traced (not merely asserted) via `test/cash-session-recovery.e2e-spec.ts`
before writing the fix, then again after, both green:

- **A. Does the backend already expose enough to recover it?** No. Before
  this task, no route returned "the caller's own current open session."
- **B. Does the backend reject a second open because the employee already
  owns one?** **Not directly** — there is no employee-level constraint (see
  §1). What actually blocks the cashier in production is `FR-FIN-001`'s
  **per-drawer** uniqueness: losing the local `cashSessionId` and retrying
  `POST /cash-sessions` on the **same physical drawer** (the realistic case —
  the cashier is standing at the same till) hits `409 Conflict` ("That
  drawer already has an open cash session..."). From the cashier's point of
  view this reads exactly as "I already have one open and I'm stuck,"
  matching the production symptom, even though the enforced invariant is
  drawer-scoped, not employee-scoped. (If the frontend instead let the
  cashier pick a *different* drawer, `POST /cash-sessions` would actually
  **succeed** and silently create a second, orphaned session under the same
  employee — the mission's "DO NOT solve this by creating another drawer"
  constraint is precisely against relying on that path.)
- **C. Is there an endpoint that returns that exact existing session?**
  No, before this task. `test/cash-session-recovery.e2e-spec.ts`'s first
  test (`'A: a SECOND PIN session ... resolves the SAME cash session id'`)
  proves the new endpoint now does.

**Root cause:** a **backend contract gap**, not a bug in the existing open/
close logic — `FR-FIN-001` and `FR-FIN-002` are enforced exactly as
specified. The gap is the **absence of a recovery read**: the client had no
source of truth for "does this authenticated employee already hold an open
session here," so a lost local `cashSessionId` was unrecoverable by any
legitimate path.

---

## 3. The recovery contract — `GET /cash-sessions/current`

### Design decision and its relationship to D-20

`treasury.controller.ts`'s own docblock (pre-existing, `~line 98`) documents
that `GET /cash-sessions/:id` and any movement-read route are deliberately
absent because §15.2 supplies no CashSession read permission code, its
authoritative Appendix C is absent from the SRS, and ratified decision
**D-20** (`docs/governance/GOVERNANCE_DECISION_REGISTER.md:8251`, RATIFIED
2026-08-18 — "MINIMAL / NO NEW GOVERNANCE READ SURFACE IN PHASE 1") answered
the analogous Governance/Approval situation the same way: **defer the
permission code, do not invent one.**

This task does **not** reopen, contradict, or amend D-20 (which is scoped to
Governance/Approval-request reads and audit reads — `GAP-9`). It also does
not invent a new permission or reinterpret `cash.session.open` as a general
CashSession read authority — the thing the controller's docblock explicitly
warns against ("would hand every session-opening cashier a read capability
no source grants").

Instead, the new route follows the **existing, narrower precedent already
established in this same controller**: `GET /cash-sessions/drawers`
(DEMO-OPS-HOTFIX-3) is gated on `cash.session.open` — not because that
permission is being reinterpreted as a generic read grant, but because it is
"a read of what a Cashier may already act on" (the controller's own words).
`GET /cash-sessions/current` is the same shape of narrow read, and is
arguably tighter:

- It is scoped to **exactly** the `(terminalId, employeeId)` pair that
  `POST /cash-sessions` already trusts from the same POS session.
- It discloses **at most one row**, and only the same fields
  (`toCashSessionView`) that employee's own prior `POST /cash-sessions` call
  already returned to them once.
- It is the **read half of the exact write** `cash.session.open` already
  authorises: "may I resume the shift I already hold," not "show me any
  session."
- It never discloses another employee's session, another branch's session,
  or a closed/historical session.

`CashSessionsService.findOne` (by-id, unscoped) remains internal-only,
unchanged, exactly as D-20's reasoning requires.

### Contract

```
GET /cash-sessions/current
@AllowPosSession()                          (POS-session-only, class-level)
@AuthorizationTarget(sessionTerminalBranchTarget())
@RequirePermission(cash.session.open)

200 OK
{ "cashSession": <CashSessionView> | null }
```

- **Branch** is derived from the CALLER'S OWN terminal
  (`sessionTerminalBranchTarget()` at the guard level;
  `CashSessionsService.findCurrentForEmployee` re-derives it from
  `terminalId` for the query itself, the same pattern
  `DrawersService.listForTerminal` already uses) — never client-supplied.
- **Employee** comes from the authenticated PIN session
  (`principal.employeeId`), never the request.
- **Exactly one** open session for `(branchId, employeeId)` →
  `cashSession` is that session.
- **Zero** open sessions → `cashSession: null` (normal Open Shift UI).
- **More than one** open session (the FR-FIN-002-legal-but-unusual case of
  one employee holding two drawers at once) → `cashSession: null`, on
  purpose: guessing which one to resume would be worse than falling back to
  the explicit drawer picker (`GET /cash-sessions/drawers`). This is
  documented in `CashSessionsService.findCurrentForEmployee`'s docblock.

### Files changed

- `src/modules/treasury/cash-sessions/cash-sessions.service.ts` — added
  `findCurrentForEmployee(tenantId, terminalId, employeeId)`.
- `src/modules/treasury/treasury.controller.ts` — added
  `GET /cash-sessions/current` (`getCurrentSession`), its response schema,
  and updated the controller's own route-surface / "deliberately absent"
  docblock to describe the new route accurately.
- `docs/api/openapi.json`, `docs/api/openapi.yaml` — regenerated
  (`npm run openapi:generate`) so the static OpenAPI document stops drifting
  from the live route surface (`test/openapi.e2e-spec.ts`'s drift-detection
  suite would otherwise fail — it did, was diagnosed, and is now green; see
  §5).

---

## 4. Manager close-other — already implemented, no gap

Traced `cash-session-close.service.ts`'s `assertCloseAuthority` (private
method backing `declareClose`/`finalizeClose`, and `getCloseContext`'s own
identical check): it resolves `isOwner = session.employeeId ===
actor.employeeId` and requires `cash.session.close` when true,
`cash.session.close_other` when false — checked against the RESOLVED,
branch-scoped authority (not just "guard admitted at least one of the two
codes"), inside the same transaction as the close write.

**`CLOSE_OTHER_ROUTE_EXISTING`: yes — the same three routes as
`OWN_CLOSE_ROUTE`** (`GET .../close-context`, `POST .../close`,
`POST .../close/finalize`), differentiated by the own/other permission check
above, not a separate endpoint. This already satisfies every constraint the
mission specifies for manager close-other:

- Requires `cash.session.close_other` (not `cash.session.close`) — proven.
- Branch-scoped — `assertCloseAuthority` checks the authority at the
  session's own `branchId`, not tenant-wide.
- Goes through the real close/count/variance workflow — `declareClose`
  always runs FR-POS-094/096/097's count + tolerance logic; there is no
  separate "force close."
- Cannot silently mark a session closed without reconciliation — same
  `declareClose`/`finalizeClose` code path as an owner's own close.
- Audited — same audit entries as an owner close (proven by existing
  `cash-session-close.e2e-spec.ts` audit assertions, unmodified here).
- Closed-session immutability preserved — no UPDATE/DELETE grant exists at
  all on `treasury.cash_sessions` beyond what `CashSessionCloseService`
  performs (proven by `cash-session.e2e-spec.ts`'s RLS/grants test, also
  unmodified).

**No destructive "force delete session" endpoint exists or was added.**

**`CLOSE_OTHER_BACKEND_GAP`: none found.** This task adds no code for
manager close-other — it was already correctly implemented and already
covered by `test/cash-session-close.e2e-spec.ts`'s `'own/other authority
(§15.2 cash.session.close vs .close_other)'` suite (own-closes-own,
non-owner-without-either-code → 403, non-owner-with-close_other → 201).

---

## 5. Tests

New file: `test/cash-session-recovery.e2e-spec.ts` (6 tests, all passing).
Modified: `test/cash-session.e2e-spec.ts` (route-surface enumeration test
updated to include the new route — 1 line changed, no new test needed there
since the internal-read-stays-absent assertion targets a different path).

| Mission item | Test | Result |
|---|---|---|
| A. same employee, new PIN session, same session id | `'A: a SECOND PIN session for the same employee resolves the SAME cash session id'` | PASS |
| B. different employee cannot recover | `'B: cannot recover another employee's open session'` | PASS |
| C. wrong branch cannot recover (+ positive control at the correct branch) | `'C: cannot recover a session open at a DIFFERENT branch, even for the same (permitted) employee'` | PASS |
| D. second open stays blocked while own session is open | `'D: the second open remains correctly blocked while the recoverable session stays open (FR-FIN-001)'` | PASS |
| E. authorized close-other via the real workflow | pre-existing `'a non-owner WITH close_other closes another employee's session'` (`cash-session-close.e2e-spec.ts:857`) | PASS (unmodified, re-verified this session) |
| F. unauthorized cashier cannot close-other | pre-existing `'a non-owner holding NEITHER close code cannot close another employee's session -> 403'` (`cash-session-close.e2e-spec.ts:843`) | PASS (unmodified, re-verified this session) |
| No-session-yet → null | `'returns null before any session is opened — normal Open Shift path'` | PASS |
| Unauthenticated → 401 | `'rejects an unauthenticated request'` | PASS |

**Test runs executed this session** (all against a real Postgres instance
via the project's e2e harness, `NODE_OPTIONS=--experimental-vm-modules npx
jest --config ./test/jest-e2e.json ...`):

- `cash-session-recovery` — **6/6 passed**.
- `cash-` + `day-close` + `drawers` + `openapi` (13 suites, includes
  `cash-session.e2e-spec.ts`, `cash-session-close.e2e-spec.ts`,
  `cash-session-cashier-role.e2e-spec.ts`,
  `cash-movements*.e2e-spec.ts`, `day-close.e2e-spec.ts`,
  `drawers-provisioning.e2e-spec.ts`, `openapi.e2e-spec.ts`) —
  **303/303 passed**, zero regressions.
- `npx tsc --noEmit` — clean.

`openapi.e2e-spec.ts`'s drift-detection test initially **failed** after
adding the route (`GET /cash-sessions/current` missing from the checked-in
`docs/api/openapi.json`/`.yaml`, which are generated artifacts, not
hand-maintained) — diagnosed as expected drift, fixed by running
`npm run openapi:generate`, re-verified green (49/49).

No full E2E suite was run beyond the Treasury-adjacent scope above, per the
mission's "no full E2E suite" instruction.

---

## 6. Frontend contract handoff

**On POS bootstrap / immediately after a successful PIN login:**

```
GET /cash-sessions/current
Authorization: Bearer <pos-session-token>
```

- `{ "cashSession": { "id": "...", "drawerId": "...", "shiftId": "...", "status": "open", ... } }`
  → restore `cashSessionId` (and `shiftId`/`drawerId`) from this response,
  show the shift as OPEN, resume normal POS operation. Do **not** call
  `POST /cash-sessions` for this employee/terminal.
- `{ "cashSession": null }` → show the normal Open Shift UI
  (`GET /cash-sessions/drawers` → pick a drawer → `POST /cash-sessions`),
  exactly as today.

This closes the production gap: the frontend no longer needs to persist
`cashSessionId` reliably across a reload/deploy/browser reset to keep the
cashier working — it can always re-derive it from the authenticated PIN
session.

**Console (`/operations/drawers` and manager close-other):**

- **Drawers screen ownership display:** the existing `GET
  /cash-sessions/drawers` route (Cashier-facing, `cash.session.open`) is
  POS-session-scoped and intentionally does not enumerate sessions — it
  returns drawers, not sessions/ownership. **No general "list all open
  sessions across the branch" route exists or was added** — that would be
  exactly the unscoped read D-20's reasoning withholds, and was out of this
  task's mission (which asked only for the caller's OWN session recovery
  and confirmation of the existing close-other authority). If a manager
  needs to see "which employee holds which open session" as a console
  feature, that is a **new, separate, tenant/branch-manager-scoped read**
  requiring its own permission analysis — **not built here, and not a
  by-product of this task.**
- **Close-other:** use the **existing** `GET/POST
  /cash-sessions/{sessionId}/close-context` → `POST
  /cash-sessions/{sessionId}/close` → `POST
  /cash-sessions/{sessionId}/close/finalize` (if above tolerance) sequence,
  exactly as an owner-close, holding `cash.session.close_other` instead of
  `cash.session.close`. The manager needs the target `sessionId` — since no
  session-listing route exists (see above), the console currently has no
  legitimate way to DISCOVER a stranded `sessionId` to close it via, beyond
  a value already known out-of-band (e.g. from the affected cashier, or an
  operator with database access). **This is the one real remaining gap** —
  not in the close-other AUTHORIZATION (which is complete), but in
  DISCOVERING which session to target from the console. Closing it needs a
  manager-scoped session-list/read route, which is new authorization
  surface and was explicitly out of scope for this mission ("Trace ...
  first," "narrowest POS-safe read contract" for the POS side only).
- **Separate Cash Sessions screen vs. drawer entity screen:** given the
  above, a dedicated Cash Sessions screen (rather than folding
  ownership/close-other into the Drawers entity screen) is the better fit
  **once** that manager-scoped read is built — it is a distinct read
  authority from `settings.branch.manage` (drawer administration) and from
  `cash.session.open` (the Cashier's own-shift reads this task added), so
  conflating it onto the Drawers screen would blur three different
  permission boundaries into one UI surface.

**Not touched:** no frontend files were edited (per mission instruction).

---

## RETURN

```
OPEN_ROUTE: POST /cash-sessions
OWN_CLOSE_ROUTE: POST /cash-sessions/{sessionId}/close (+ /close/finalize), permission cash.session.close (owner)
CURRENT_SESSION_ROUTE_EXISTING: none — did not exist before this task
OPEN_SESSION_LIST_ROUTE: none exists (by design — see §6; console discovery gap noted)
CLOSE_OTHER_ROUTE_EXISTING: yes — SAME routes as OWN_CLOSE_ROUTE (close-context/close/close-finalize), differentiated by cash.session.close_other via CashSessionCloseService.assertCloseAuthority

EMPLOYEE_OPEN_SESSION_CONSTRAINT: NONE at the database/service level. FR-FIN-002 requires exactly one employee PER session, not one open session PER employee — an employee can legitimately hold open sessions on 2+ drawers at once.
DRAWER_OPEN_SESSION_CONSTRAINT: uq_one_open_session_per_drawer — PostgreSQL partial UNIQUE INDEX on drawer_id WHERE status='open' (FR-FIN-001). This is what actually produces the production "already has an open session" symptom when the frontend retries POST /cash-sessions on the SAME drawer.

RECOVERY_ROOT_CAUSE: backend contract gap — no route let the POS ask "does this authenticated employee already hold an open session at this branch," so a client-side loss of the locally-cached cashSessionId (reload/deploy/browser reset) was unrecoverable; the only client-visible symptom was FR-FIN-001's correct 409 on a same-drawer retry.
BACKEND_GAP: absence of a scoped current-session read. Confirmed no existing route/permission covered it; CashSessionsService.findOne (by-id) is deliberately internal-only (D-20-aligned) and was never a candidate.
RECOVERY_CONTRACT: GET /cash-sessions/current, @AllowPosSession, gated on cash.session.open (same permission as the open write, mirroring the existing GET /cash-sessions/drawers precedent — not a new/invented permission, not a reinterpretation of cash.session.open as a general CashSession read). Branch from the caller's own terminal (sessionTerminalBranchTarget), employee from the authenticated PIN session. Returns { cashSession: CashSessionView | null } — the one open session for (branchId, employeeId), or null if none or more than one (ambiguous-safe).

CLOSE_OTHER_PERMISSION: cash.session.close_other
CLOSE_OTHER_BACKEND_GAP: none — already fully implemented (own/other split inside CashSessionCloseService.assertCloseAuthority, branch-scoped, audited, reconciliation-workflow-only, no destructive shortcut). No code added for this in this task.
CLOSE_OTHER_CONTRACT: unchanged — existing GET .../close-context, POST .../close, POST .../close/finalize, permission resolved per-request as close (owner) or close_other (non-owner) against the session's own branch.

TESTS: test/cash-session-recovery.e2e-spec.ts (new, 6/6 passing) covers mission items A/B/C/D + null-before-open + unauthenticated-401. Mission items E/F already covered by pre-existing test/cash-session-close.e2e-spec.ts "own/other authority" suite (re-verified passing, unmodified). Full relevant regression sweep this session: 303/303 e2e tests across 13 suites (cash-*, day-close, drawers-provisioning, openapi) + tsc --noEmit clean. No full E2E suite run (per mission instruction).
BACKEND_FILES_CHANGED:
  src/modules/treasury/cash-sessions/cash-sessions.service.ts (+method findCurrentForEmployee)
  src/modules/treasury/treasury.controller.ts (+route GET /cash-sessions/current, +schema, docblock updates)
  test/cash-session.e2e-spec.ts (route-surface assertion updated)
  test/cash-session-recovery.e2e-spec.ts (new)
  docs/api/openapi.json, docs/api/openapi.yaml (regenerated, generated artifacts — not hand-edited)
BACKEND_COMMIT: none — not committed (CLAUDE.md: do not commit unless explicitly instructed)
FRONTEND_HANDOFF: see §6 above. POS: call GET /cash-sessions/current right after PIN login; non-null → resume, null → normal Open Shift. Console: close-other authorization is already complete and needs no new backend work to USE via the existing close routes, but the console currently has no route to DISCOVER a stranded sessionId (no session-list read exists — deliberately not built here, flagged as the one real remaining gap, out of this mission's scope).
SAFE_TO_DEPLOY: Yes, backend-side. New route is additive (no existing route/behavior changed), permission reuses an existing code (no seed/migration needed), no schema/migration change, full regression sweep (303 e2e tests) and tsc clean. Frontend must still be updated to call the new route for this fix to reach production users — that half is explicitly not done here.
```
