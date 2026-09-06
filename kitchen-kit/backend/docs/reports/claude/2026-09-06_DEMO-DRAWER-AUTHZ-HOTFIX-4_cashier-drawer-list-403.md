# DEMO-DRAWER-AUTHZ-HOTFIX-4 — Cashier drawer list returns 403

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `4d7a387` (DEMO-OPS-HOTFIX-3)
**HEAD (frontend, this task's parent):** `4ce588e`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Backend touched only
`test/drawers-provisioning.e2e-spec.ts` (new proof tests) — **no backend
source file changed**, because the hypothesized defect does not exist in
the current code. Frontend touched `components/terminal/pos-live.tsx` and
both content files. Same pre-existing, unrelated `INDEX.md`/
`PROD-DEMO-SMOKE` items left untouched.
**Task identifier:** DEMO-DRAWER-AUTHZ-HOTFIX-4 (`GET /cash-sessions/drawers`
403 for a branch-scoped Cashier)

## Trace (the 7 items asked for)

1. **Controller method:** `TreasuryController#listSessionDrawers`
   (`src/modules/treasury/treasury.controller.ts`).
2. **`@RequirePermission`:** `TREASURY_PERMISSIONS.CASH_SESSION_OPEN`
   (`cash.session.open`) — the exact same code `POST /cash-sessions`
   requires.
3. **`@AuthorizationTarget`:** `sessionTerminalBranchTarget()` — **already
   present**, byte-identical to `POST /cash-sessions`'s own decorator (both
   added together in `DEMO-OPS-HOTFIX-3`, `4d7a387`).
4. **Controller-level guards:** `@UseGuards(JwtAuthGuard, TenantContextGuard,
   PermissionGuard)` + class-level `@AllowPosSession()` — same as every
   other route on this controller, including `POST /cash-sessions`.
5. **How `PermissionGuard` determines scope:** reads the handler's
   `@AuthorizationTarget`, resolves it via `AuthorizationTargetResolver`
   (for `sessionTerminalBranch`: a POS session's live `auth.context.branchId`,
   already re-verified by `TenantContextService` on this exact request —
   never a caller-supplied value), then calls
   `ScopeAuthorizationService.assertAuthorized(auth, required, resolution.target)`.
   Unchanged by this task; read again in full.
6. **Cashier's actual branch-scoped assignment:** a `MembershipRole` with
   `scopeType: 'branch'`, `scopeBranchId` equal to the employee's real
   branch — either auto-granted at employee creation
   (`grantAutoCashierRole`) or via the Employees-page RBAC UI
   (`assignRoleToEmployee`, which now also self-heals a stale role's
   permissions per `DEMO-OPS-HOTFIX-2`). Confirmed present and correctly
   scoped by direct query in the new tests below.
7. **`GET /auth/permissions` shape for a branch-scoped Cashier:** not
   directly exercised by this route at all — `PermissionGuard` never reads
   that endpoint's response; it resolves live grants from the database on
   every request (`TenantContextService.require`). Mentioned here only
   because the reported PRODUCTION network trace (`terminals 200,
   permissions 200, tenants 200, access 200, drawers 403, tenant 200`) is
   the signature of the CONSOLE session bootstrap
   (`useSession`/`useLiveOrgContext`, which `pos-live.tsx`'s `LivePos` also
   calls, alongside its own separate `api.terminals.list()` — this
   accounts for every one of those five other calls). That sequence
   succeeding is consistent with an **Owner's own dashboard token** being
   the ACTIVE bearer token at the moment the drawer-list call fired — a
   token with no `terminalId`/`employeeId` claim at all, for which this
   route's target correctly denies with `"Insufficient permission for this
   scope."` This is not a bug in the guard; it is the guard correctly
   refusing a caller who is not (or is no longer) a POS session — see the
   new decisive test below, which reproduces exactly this 403 and shows it
   is the SAME 403 `POST /cash-sessions` gives the identical caller.

## FAILING_ROUTE / PERMISSION / AUTHORIZATION_TARGET_BEFORE / ROOT_CAUSE

**FAILING_ROUTE:** `GET /cash-sessions/drawers`
**PERMISSION:** `cash.session.open` (correct, unchanged)
**AUTHORIZATION_TARGET_BEFORE:** `sessionTerminalBranchTarget()` — **this
was NOT missing.** It was added in the same commit that created this route
(`DEMO-OPS-HOTFIX-3`, `4d7a387`), verified again in this task by direct
file read before writing a single test.

**ROOT_CAUSE:** The hypothesized backend defect (missing/wrong
`@AuthorizationTarget`) is **disproven** by direct source inspection and
by a new test (`the Owner's own (non-POS, non-terminal-bound) token gets
the SAME 403 from GET /cash-sessions/drawers as it would from POST
/cash-sessions`) that calls both routes with an identical non-POS token
and asserts byte-identical 403 status and message. A second new test
proves the POSITIVE case: a genuinely branch-scoped Cashier PIN session
gets **200** with exactly its own branch's drawer, and a third proves a
foreign branch's drawer is never visible to it. **The backend route is,
and was already, correctly authorized.**

The reported production 403 is most consistent with a **frontend-side
identity/session issue**, not a backend one: `pos-live.tsx`'s `LivePos`
also calls `useSession()` (the console-wide session/org-context provider),
whose own bootstrap (`org/access`, `auth/permissions`, `auth/tenants`,
`auth/tenant`) plus its own separate `api.terminals.list()` call together
account for every OTHER call in the reported trace succeeding — which is
exactly what would happen if the ACTIVE bearer token belonged to an Owner
using the same browser/device, not to a completed PIN sign-on. Confirming
this specific frontend session-identity path was not attempted here (it
is a live-browser-state question, and the ticket's own explicit,
unconditional ask — never convert an auth failure into "no drawer
configured" — is the correct, scope-bounded fix regardless of which exact
browser sequence produced the 403).

## BACKEND_FIX

**None required.** No backend source file was changed. The three new
tests in `test/drawers-provisioning.e2e-spec.ts` exist to make this
finding durable evidence rather than a one-off read of the source.

## FRONTEND_ERROR_HANDLING_FIX

`components/terminal/pos-live.tsx`'s `OpenDrawer`: `useAsync`'s contract
resets `data` to `null` on ANY error, so the render's prior
`drawerRows = drawers.data ?? []` made a genuine empty list
indistinguishable from a failed request — every failure, including a 401
or 403, rendered `"No drawer is set up for this branch yet..."`. Fixed by
checking `drawers.error` FIRST: a `ServiceError` with `code ===
"UNAUTHENTICATED"` or `"FORBIDDEN"` now shows a real
"this session cannot open a drawer, sign on again" message
(`shift.drawerAuthError`, both locales); any other error shows its own
message; only a genuinely empty, ERROR-FREE result shows the
"no drawer configured" callout. The Open button remains correctly
disabled in every one of these states (`drawerId` never gets set).

## Tests

`test/drawers-provisioning.e2e-spec.ts` — **8/8 passed** (5 pre-existing +
3 new): the dashboard-token-gets-same-403-as-POST proof, the
branch-scoped-Cashier-gets-200 proof, and the foreign-branch-drawer-not-visible
proof.

Combined targeted run — **4 suites, 22 tests, all passed**:
`drawers-provisioning` (8/8), `cash-session-cashier-role` (4/4),
`employee-role-assignments` (5/5), `workforce-employees-hotfix` (5/5).

Backend `typecheck`/`build`: clean (no source changed). Frontend
`typecheck`/`build`: clean.

## SRS relevance

No requirement reinterpreted. This task is a verification-and-evidence
exercise proving an already-correct backend authorization boundary
(FR-SEC-021, the D-2/B1-3 scoped-RBAC amendment) was not the defect, plus
a presentation-layer correctness fix (FR-SEC-045: a client-side state must
never mask what the server actually said) so a genuine auth failure is
never misreported as a missing drawer.
