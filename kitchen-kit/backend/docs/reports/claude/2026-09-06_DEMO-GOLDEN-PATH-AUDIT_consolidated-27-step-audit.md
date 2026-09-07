# DEMO-GOLDEN-PATH-AUDIT — Consolidated 27-Step Audit

**Report type:** Audit (read-only, no implementation performed)
**Task identifier:** DEMO-GOLDEN-PATH-AUDIT (consolidated)
**Date:** 2026-09-06
**Backend HEAD:** `3e4f85c8` (unchanged by this task)
**Backend branch:** `full-srs/lane-d4-reporting-demo`
**Frontend HEAD (primary, audited):** `61651e1` — `demo/p0-live-wiring` (`/Users/mac/projects/ros-front/kitchen-kit`)
**Frontend HEAD (secondary checkout, cross-checked):** `d2bcefb` — `demo/kds-nav-recovery` (`/Users/mac/projects/ros-front/kds-nav`) — see divergence note below.
**Working tree summary (backend, this worktree):** No source files touched. `docs/reports/claude/INDEX.md` modified (append-only) to record this and two sub-agent reports; three new untracked report files added (`2026-09-06_GOLDEN-PATH-AUDIT_pos-branch-load-and-catalogue-sellable.md`, `2026-09-06_GOLDEN-PATH-AUDIT_pos-create-fire-payment-receipt-refund.md`, this file). One pre-existing untracked file from a prior session (`2026-09-05_PROD-DEMO-SMOKE_production-smoke-test-plan.md`) left untouched. Nothing committed.
**Frontend working tree:** Not modified by this audit. One agent noted a pre-existing, unrelated unstaged WIP diff in `lib/api/client.ts`/`lib/api/session.ts` on the primary checkout (appears to be an in-progress token-refresh-announce race fix from another session) — observed only, not evaluated or touched.

## Authority statement

This report is non-authoritative evidence produced by a static, read-only code
audit. The SRS and ratified governance decisions remain authoritative. Where
this report's findings conflict with any prior report's claims, this report's
findings reflect direct re-verification against current source at the HEADs
above as of 2026-09-06; prior reports are not assumed still accurate and were
only used as investigative leads.

## Method

Seven parallel read-only research passes were run, one per golden-path
domain cluster (auth/session, org/workforce, POS-load/catalogue,
treasury/cash, order/payment/refund, KDS, reporting/audit), each directly
reading backend controllers/guards/services/DTOs/seed data and frontend
routes/components/API clients on both repos above. No dev servers were
started, no database was touched, no full E2E was run, and no files were
modified as part of the investigation itself (two of the seven research
passes additionally wrote their own dated sub-reports under this directory
per this repo's standing reporting policy; those are indexed and referenced
below rather than duplicated here). Two apparent frontend-branch divergences
flagged in the task brief (an "unmerged" KDS nav/permission fix) were
investigated and found to be **false alarms** — the same diff exists on the
primary head under a different commit hash (rebase), confirmed via
`git merge-base --is-ancestor`. This is noted explicitly per step below so it
is not rediscovered as a "blocker" in a future pass.

---

## Consolidated Table (ordered by demo sequence)

| # | Step | Classification | Route/Component | Failing API Endpoint | Required Permission/Scope | Owner/Cashier/Kitchen should have it? | Setup data missing? | Smallest safe fix | Demo-critical? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Owner signup | GREEN | `app/(auth)/signup/page.tsx` → `lib/api/registration.ts:submitRegistration` | `POST /auth/registrations` (`registrations.controller.ts:60-103`) | None (public, throttled) | Owner: yes | No | — | Yes |
| 2 | Owner console login/session | GREEN | `app/(auth)/login/page.tsx` → `lib/api/auth.ts:signIn/selectTenant` | `POST /auth/login` (`auth.controller.ts:71-86`), `POST /auth/tenant` (`tenant.controller.ts:79-114`) | Valid credential + active membership | Owner: yes | No | — | Yes |
| 3 | Main branch exists | GREEN | Backend: `RegistrationsService.register` (`registrations.service.ts:141-435`) creates Branch+Brand+Location in the signup transaction and grants Owner `ALL_PERMISSION_CODES`. Frontend: `lib/console/providers.tsx:360-373` sources branches live from `GET /org/access` | `GET /org/access` (`organisation.controller.ts:283-317`) | None required (public-to-tenant by design) | Owner: yes, automatically | No | — | Yes |
| 4 | Create additional branch | GREEN | Backend `POST /org/branches` (`organisation.controller.ts:385-403`). Frontend `app/(console)/organisation/branches/page.tsx:492-506` | `POST /org/branches` | `settings.branch.manage` (tenant/brand-scoped) | Owner: yes | No | Already fixed (commit `588608a` corrected a prior wrong permission key) | Yes |
| 5 | Create employee | GREEN | Backend `POST /workforce/employees` (`employees.controller.ts:138-163`). Frontend `NewEmployeeDrawer` (`workforce/employees/page.tsx:594-606`) | `POST /workforce/employees` | `hr.employee.manage` (branch-scoped), Idempotency-Key required | Owner: yes | No | — | Yes |
| 6 | Assign Cashier role | GREEN | Backend `POST /workforce/employees/:employeeId/role-assignments` (`employees.controller.ts:327-353`). Frontend `AccessRoleSection` (`workforce/employees/page.tsx:409-517`) | `POST /workforce/employees/:employeeId/role-assignments` | `identity.role.assign`; Cashier canonical role seeded idempotently at signup (`canonical-role-templates.ts:58-68`) with `pos.order.create/fire/void_line_prefire`, `pos.payment.capture`, catalogue reads, `cash.session.open/close` | Owner: yes to assign; Cashier's own grant set is sane and even auto-granted at branch scope on employee creation as a bonus default | No | — | Yes |
| 7 | Set PIN | GREEN | Backend `POST /workforce/employees/:employeeId/pin` (`employees.controller.ts:279-296` → `pin.service.ts:205-276`). Frontend `SetPinSection` (`workforce/employees/page.tsx:524-571`) | `POST /workforce/employees/:employeeId/pin` | `hr.employee.manage`, Idempotency-Key required | Owner: yes | No — employee-create auto-provisions a linked User+Membership so the "no linked user" guard never trips | — | Yes (final setup step before PIN login is possible) |
| 8 | Register/bind terminal | GREEN | Backend register `POST /auth/terminals` (`terminal.controller.ts:87-117`), bind `POST /auth/terminal` (`terminal.controller.ts:190-215` → `terminal-session.service.ts:47-108`). Frontend `app/(auth)/register-device/page.tsx:LiveDeviceBinding` (line 68) → `lib/api/auth.ts:registerTerminal/bindTerminalFromThisDevice` | `POST /auth/terminals`, `POST /auth/terminal` | `identity.terminal.manage` (branch-scoped) | Owner/manager: yes | No | — | Yes |
| 9 | Employee PIN login | GREEN (conditional on setup) | Backend `POST /auth/pin` (`auth.controller.ts:94-115` → `auth.service.ts:124-193` → `pin.service.ts:286-410`). Frontend `CashierSignOn` (`components/terminal/pos-live.tsx:294-370`) → `lib/api/auth.ts:signInWithPin` | `POST /auth/pin` | None to authenticate; mints `typ:'pos'` token | Cashier/Kitchen: yes, intended surface | **Yes** — requires an Employee row with an active PIN credential and a branch matching the bound terminal (created via steps 5-7); this is expected setup, not a defect | — | Yes |
| 10 | POS loads with correct branch | GREEN | Frontend derives branch from the bound terminal via `GET /org/access`, never the tenant-owner-only `GET /org/branches` — re-verified the `DEMO-POS-BRANCH-CONTEXT-HOTFIX` fix is intact (`pos-live.tsx`, `chrome.tsx`) | `GET /org/access` | Terminal-scoped, not tenant-wide | Cashier: yes | No | — | Yes |
| 11 | Drawer exists / can be created | GREEN | Backend `DrawersController.createDrawer`/`listDrawers` (`drawers.controller.ts:66-115`). Frontend `app/(console)/operations/drawers/page.tsx:35-211`, genuinely wired (not mocked) | `POST`/`GET /branches/{branchId}/drawers` | `settings.branch.manage` | Owner: yes (has via `ALL_PERMISSION_CODES`); Cashier: correctly does not | **Yes** — no drawer auto-provisioned, none seeded; Owner must create ≥1 drawer per branch before demo | Operational runbook step only, no code fix needed | Yes |
| 12 | Open cash shift | GREEN, environment-conditional | Backend `POST /cash-sessions` (`treasury.controller.ts:379-438`), `cash.session.open`, Cashier has it. Frontend real path `components/terminal/pos-live.tsx:386-458` is used only when `DATA_MODE==="http"` (`lib/api/config.ts:35-40`); otherwise a fully client-side mock (`components/terminal/shift.tsx`, `lib/console/live/reducer.ts:901`) silently handles the flow with **no backend call at all** | `POST /cash-sessions` | `cash.session.open` | Cashier: yes | No — code path is correct when configured | Confirm `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_API_MODE=http` is set for the demo build/deploy; no code change if already set | Yes — verify before the demo, not a code defect |
| 13 | Catalogue/menu has something sellable | **BLOCKED_FRONTEND** | Backend fully capable and correctly permissioned (`menu.item.manage`/`menu.price.change`/`menu.availability.toggle`). Frontend `app/(console)/menu/{items,menus,modifiers}/page.tsx` all gate manage UI on `usePermission("menu.manage")` — **a permission key that does not exist**; the real key is `menu.item.manage`. `PermissionKey` is structurally `string` so TypeScript catches nothing | (UI never calls the create endpoint — gated out before the request) | `menu.item.manage` (real) vs `menu.manage` (invented, checked instead) | Owner: should and does hold the real permission, but the UI gate hides the buttons from everyone including Owner | **Yes** — a fresh self-service-signup tenant has zero catalogue data by design (`registrations.service.ts:113-114`, "DEFERRED for this slice"); only a standalone dev seed script (`src/scripts/seed-dev-data.ts`) provisions a full example, and it is not wired into signup | 3 one-line string corrections (`menu.manage` → `menu.item.manage` in the three page files), plus either wire the seed script's catalogue block into signup or run it once against the demo tenant | **Yes — demo-critical.** Without this, no sellable item can be created through the console at all. |
| 14 | Create order | GREEN | Real, backend + frontend wired | — | `pos.order.create` | Cashier: yes | No | — | Yes |
| 15 | Add item | GREEN | Real, backend + frontend wired | — | (part of order line creation) | Cashier: yes | No | — | Yes |
| 16 | Fire order | **BLOCKED_FRONTEND** | Live POS `NewOrderPane` defaults every new order to `dine_in` with **no table-selection UI** — Fire then 422s immediately on backend rule FR-POS-003 before any kitchen-routing question is even reached | `POST` fire-order endpoint (422 on FR-POS-003) | `pos.order.fire` (Cashier has it) — not a permission problem, a required-field problem | Cashier: yes, has permission | No — this is a missing UI control, not missing data | Add a table-picker (or a non-dine-in order-type default/selector) to `NewOrderPane` so FR-POS-003's required field is actually satisfiable from the UI | **Yes — demo-critical.** Compounded by step 19's routing gap: even once a table is set, firing an item with no matching routing rule rolls back the entire fire. |
| 17 | KDS station exists | GREEN | Backend `POST`/`GET /org/branches/:branchId/stations` (`organisation.controller.ts:675-694`). Frontend `app/(console)/operations/stations/page.tsx:36`, real, gated `settings.branch.manage` | — | `settings.branch.manage` | Owner: yes; Cashier/Kitchen: correctly no | **Yes** — no station auto-created per branch; Owner must explicitly create one | Operational runbook step only (already fixed per `DEMO-OPS-HOTFIX-2/3`, re-verified live) | Yes (prerequisite for 19/20) |
| 18 | KDS loads and survives reload | GREEN | `lib/api/auth.ts:198 effectivePermissionCodes()` and `lib/console/live-session.ts:157` already union `scopes[]` (brand/branch-scoped grants) into the permission set used on reload; `lib/console/nav.ts` and `lib/console/permissions.ts` already gate on the real `kds.operate` code, not an invented `kds.view`. **Divergence note:** the task brief flagged a fix on `demo/kds-nav-recovery` (`d2bcefb`) as unmerged into the primary head — verified this is a false alarm: `d2bcefb`'s diff is byte-identical to commit `ca23b73`, already an ancestor of primary HEAD `61651e1` (rebase, not divergence). No cherry-pick needed. | — | `kds.operate` | Kitchen Staff: yes, canonical role grants exactly this code | No | — | Yes (was previously the top demo risk from prior reports; now confirmed closed) |
| 19 | Ticket appears | **BLOCKED_PROVISIONING** | Backend `OrderLineFiredHandler.handle` (`order-line-fired.handler.ts:57-160`) runs routing resolution **inside the fire transaction**; if no line override, no matching modifier/menu-item/category rule, and no `branchKdsConfig.fallbackStationId`, it throws `RoutingNoDestinationError` and **rolls back the entire fire** — no ticket, no fired order at all. Category-level routing rules ARE configurable via the real, wired Branches → Station Routing panel (`organisation.controller.ts:883-906`, `StationRoutingPanel` in `branches/page.tsx:650-749`). There is, however, **no route or UI anywhere** for the tier-5 branch fallback station (`branch_kds_config.fallback_station_id` has zero controller references) | `POST /org/branches/:branchId/station-routing-rules` (exists, reachable) — the gap is the absent fallback-station route, not this one | `settings.branch.manage` (Owner has it) | Owner: yes, has the permission needed to configure routing | **Yes, concretely** — unless the Owner pre-creates a routing rule covering every category/item that will be fired (or a fallback station existed, which it can't via UI), firing rolls back with no ticket | Pre-demo runbook step: use the existing Station Routing UI to add a rule per category before firing anything (zero code change). Durable product fix (out of demo scope): add an admin route/UI for `branchKdsConfig.fallbackStationId` | **Yes — single riskiest item found.** Failure mode is worse than "no ticket": the entire order-fire silently rolls back. |
| 20 | Start/bump | GREEN | Backend `KitchenController` (`kitchen.controller.ts:205-489`), `kds.operate` + `KdsStationGuard`. Frontend `components/terminal/kds-live.tsx`, real calls throughout | — | `kds.operate` | Kitchen Staff: yes | No (contingent on 17+19 being provisioned) | — | No (once upstream steps are provisioned) |
| 21 | Payment | GREEN (production path); dev-seed caveat | Backend payment capture, `pos.payment.capture`. Cashier canonical **production** role template (`canonical-role-templates.ts`) grants it + `cash.session.open` | — | `pos.payment.capture` | Cashier: yes, on the production signup-provisioning path | No, on production path | Caveat only: the separate local-dev `src/scripts/seed-dev-data.ts` Cashier role grants **neither** payment nor cash-session permissions — do not use it to reset/seed the demo tenant | Yes (as a step); no code fix needed if the demo tenant is provisioned via real signup, not the dev seed script |
| 22 | Receipt | **MISSING_PRODUCT_FEATURE** | Backend receipt-retrieval endpoint is complete. Live POS (`pos-live.tsx`) fetches the receipt internally only to feed the refund payment-picker — it is **never rendered or printed** for the cashier/customer at all | (backend endpoint exists and works; no frontend caller for display/print) | `pos.order.view` or equivalent read scope (already held) | Cashier: yes, should be able to show/print a receipt | No | Add a receipt display/print view in the POS payment-complete flow, wired to the already-working backend endpoint | Yes — explicit golden-path step with literally no user-facing view today |
| 23 | Refund | **BLOCKED_AUTH_SCOPE** | Frontend `RefundDrawer` is fully built and real-backend-wired. Backend permission `pos.refund.issue` is **absent from every canonical staff role template** (Cashier/Branch Manager/Shift Supervisor/Kitchen Staff) — it exists only on the full-catalogue Owner role from signup | Refund endpoint (403 for any staff-tier actor) | `pos.refund.issue` | Should exist on at least Branch Manager (and arguably Cashier with a limit, per typical POS governance) — currently only Owner | No — this is a governance/role-template gap, not missing data | Add `pos.refund.issue` to the Manager (and/or Cashier) canonical role template — a governance decision on approval tier, then a one-line grant in `canonical-role-templates.ts` | **Yes — demo-critical.** No staff-tier actor can currently issue a refund at all. |
| 24 | Cash close readiness | **BLOCKED_FRONTEND** (root cause spans both layers) | Backend `CashSessionCloseService.declareClose` (`cash-session-close.service.ts:243-305`) unconditionally 409s absent a `CashClosePolicy` for the branch as of session-open time — by design. Policy creation (`POST /branches/{branchId}/cash-close-policy`) requires `settings.branch.manage` and deliberately has **no `@AllowPosSession()`** opt-in. The **only** frontend UI for creating this policy, `CashClosePolicyCard`, is mounted exclusively inside the terminal's post-PIN-signon screen — i.e. only reachable from a `typ:'pos'` token that `JwtAuthGuard` will always reject for this route. **No console/dashboard page exposes policy creation at all.** | `POST /branches/{branchId}/cash-close-policy` (correctly rejects POS tokens; unreachable from any other UI) | `settings.branch.manage` (Owner has it, but has no UI surface to use it from) | Owner: should and does hold the permission; simply has no page to act on it | **Yes** — no policy is seeded, and there is no way to create one short of a raw API call | Add a real console/dashboard page (e.g. under Finance or Settings, gated `settings.branch.manage`) that calls the already-implemented `services.treasury.setCashClosePolicy` — this is a genuinely small, additive fix since the service call already exists | **Yes — without this, cash-session close 409s unconditionally and no shift can ever be closed.** |
| 25 | Reporting | GREEN | Real sales/day-close views: `app/(console)/finance/day-close/page.tsx`, `finance/payments/page.tsx`, `finance/tax/page.tsx`, all backed by `GET /reports/branches/:branchId/daily-trading/:businessDay` and `.../overview` (`reporting.controller.ts`). A separate, cosmetic `/reports` catalogue page (`app/(console)/reports/page.tsx`) is an unwired stub (`notImplemented`) but is not the page a demo needs to use | `services.platform.reports()` on the unused `/reports` stub only | `report.view.sales` AND `report.view.financial` | Owner: yes (seeded); Manager: yes; Cashier: correctly no | No — figures are legitimately zero until upstream orders/payments occur, which is a dependency, not a defect | None required for the demo; optionally wire the `/reports` stub to the same `services.finance.*` calls later | No (Finance pages already satisfy this step) |
| 26 | Audit | GREEN | `app/(console)/audit/page.tsx` → `useAuditFeed` → real `GET /governance/audit/entries` search, fully wired | — | `audit.view` (search); `audit.view`+`report.export` for export | Owner: yes (seeded); Cashier: correctly no | No — feed is legitimately empty until upstream actions occur | None required; optional: add an export button for `GET /governance/audit/entries/export`, which has no frontend caller today | No |
| 27 | Return from POS/KDS to Console without session corruption | GREEN | `components/terminal/chrome.tsx:151-157` → client navigation → `app/(console)/layout.tsx` remount; surface-scoped storage keys (see Token/Session Audit) prevent the corruption this step is checking for | — | — | — | No | — | Yes (confirmed fixed by the session-isolation hotfix series) |

---

## Blockers — Detail

### 13. Catalogue sellability — BLOCKED_FRONTEND (demo-critical)
- Exact files: `app/(console)/menu/items/page.tsx`, `app/(console)/menu/menus/page.tsx`, `app/(console)/menu/modifiers/page.tsx` — all call `usePermission("menu.manage")`.
- Real backend permission code: `menu.item.manage` (plus `menu.price.change`, `menu.availability.toggle` for related actions).
- Owner holds the real code (`ALL_PERMISSION_CODES` at signup) but the UI checks a code that can never be granted, so the gate is permanently closed for everyone.
- Compounding provisioning gap: fresh signup tenants get zero catalogue rows by design; only `src/scripts/seed-dev-data.ts` (a dev-only script, not part of signup) produces a sellable item end to end.
- Smallest safe fix: correct the permission string in the three files; separately decide whether to wire minimal catalogue seeding into signup or run the seed script once against the demo tenant.

### 16. Fire order — BLOCKED_FRONTEND (demo-critical)
- `NewOrderPane` hardcodes `dine_in` as the order type with no table-selection control.
- Backend rule FR-POS-003 requires a table for `dine_in` orders; Fire returns 422 before reaching routing logic.
- Smallest safe fix: add a table picker, or default new orders to a type that doesn't require a table (e.g. takeaway) with an explicit switch to dine-in + table when needed.
- Interacts with #19: even once this is fixed, firing still depends on routing being provisioned.

### 19. Ticket appears — BLOCKED_PROVISIONING (demo-critical, highest-severity failure mode found)
- `RoutingResolverService.resolve` runs inside the same DB transaction as order-line fire; a miss (no override, no rule match, no fallback station) throws and rolls back the *entire* fire, not just the ticket.
- Category-level routing rules can be configured today via the real Branches → Station Routing panel — this is a runbook/config gap, not a code defect, for the demo itself.
- No route/UI exists anywhere for `branchKdsConfig.fallbackStationId` (durable gap, out of demo scope to fix in code).
- Smallest safe fix for the demo: before firing anything, create a routing rule per category that will be sold, via the existing UI. Zero code changes required to pass the demo; a fallback-station admin surface is a legitimate but non-blocking backlog item.

### 22. Receipt — MISSING_PRODUCT_FEATURE (demo-critical)
- Backend retrieval endpoint works; the frontend fetches it only as an internal input to the refund flow, never displays or prints it to a cashier/customer.
- Smallest safe fix: add a receipt view/print action in the POS payment-complete flow.

### 23. Refund — BLOCKED_AUTH_SCOPE (demo-critical)
- `pos.refund.issue` exists only on the signup Owner role; no Cashier/Manager/Shift-Supervisor/Kitchen-Staff template carries it.
- UI (`RefundDrawer`) is fully built and wired — this is purely a role-template gap.
- Smallest safe fix: grant `pos.refund.issue` to at least the Branch Manager template (governance call on whether Cashier should also get it, possibly with a value cap — not resolved by this audit).

### 24. Cash close readiness — BLOCKED_FRONTEND (root cause spans backend design + frontend gap; demo-critical)
- Backend correctly requires a `CashClosePolicy` before allowing close (by design) and correctly refuses to accept that policy-creation call from a POS-scoped token (by design, `@AllowPosSession` intentionally absent).
- The only UI for creating the policy is mounted where it can never succeed (post-PIN-signon POS screen). No console/dashboard page exposes this admin action at all.
- Smallest safe fix: add a console page (Finance or Settings, `settings.branch.manage`-gated) calling the already-implemented `services.treasury.setCashClosePolicy`.

---

## Token / Session Separation Audit

**Architecture, confirmed not assumed:** a single `AccessTokenService` + `JwtAuthGuard` (`src/modules/identity/auth/guards/jwt-auth.guard.ts:22-76`) issues and verifies every token across all three surfaces. Console, POS/PIN, and Terminal/KDS sessions share one JWT shape (`AccessTokenPayload`), differentiated only by which optional claims are present (`tid`/`mid`, `trm`, `emp`, `typ:'pos'`). This is a deliberate, documented design (FR-SEC-021), not an accident.

| Finding | File:line | Rating |
|---|---|---|
| Console token issuance | `POST /auth/login` → `auth.service.ts:55-112`; scoped via `POST /auth/tenant` → `tenant.controller.ts:105-114` | GREEN |
| POS/PIN token issuance | `POST /auth/pin` → `auth.service.ts:124-193`; mints `typ:'pos'`, `emp`, `trm`, scope snapshot | GREEN |
| Terminal/KDS bind (no PIN) | `POST /auth/terminal` → `terminal-session.service.ts:47-108`; keeps full dashboard-class access (no `typ:'pos'`) — intentional, a manager can bind a KDS screen while remaining console-class | GREEN |
| Console storage keys | `lib/api/session.ts:60-65` — `ros.api.accessToken`/`refreshToken`/`expiresAt`/`tenantId` | GREEN |
| Terminal storage keys | `lib/api/session.ts:67-72` — `ros.terminal.accessToken`/`refreshToken`/`expiresAt`/`tenantId` | GREEN |
| Surface selection | `lib/api/session.ts:41-58` (`activeSurface`), set by each route group's own layout (`app/(terminal)/layout.tsx`, `app/(console)/layout.tsx`, `app/(auth)/layout.tsx`) | GREEN |
| Previously-corrupting collision | Pre-hotfix, console and PIN logins wrote the SAME `ros.api.*` keys, so a Cashier PIN login silently clobbered an Owner's console session. Fixed by the surface split above, verified live in current code (commit `61651e1`) | Was BLOCKED_SESSION_STATE → now GREEN |
| Console sign-out guard | `components/console/shell.tsx:302-313` gates on `ros.console.auth`, a third, independent key set only by real `/login`/`/signup`, never touched by PIN sign-in | GREEN |
| Device-level shared facts (by design) | `terminalId`, `deviceTenantId`, `cashSessionId`, `posEmployee` are deliberately NOT surface-split — they describe the physical till, not an authenticated identity | GREEN as designed |
| **Residual risk: terminal-ID replay on refresh is not surface-scoped** | `lib/api/client.ts:132-195` (esp. `:170-182`): `refreshSession()` calls `POST /auth/terminal` using the shared, non-surface-scoped `getTerminalId()` on every refresh, for either surface. On a device that has ever bound a terminal, a later, unrelated console login on the same browser can silently gain a `trm` (and possibly `emp`) claim on refresh. No current route branches on mere `trm` presence for a non-POS session, so nothing visibly breaks today, but it is a real violation of the surface-isolation invariant the hotfix otherwise establishes. | **BLOCKED_SESSION_STATE — low severity, not demo-blocking.** Smallest fix: gate the `POST /auth/terminal` replay on `getActiveSurface() === "terminal"`, or make `terminalId` itself surface-scoped. |
| Employee identity restored on refresh | `auth.service.ts:236-260` re-derives `emp` from the employee record on every refresh when `terminalId` survives; correctly does not restore `typ:'pos'` | GREEN — matches and confirms the DEMO-POS-EMPLOYEE-SESSION-HOTFIX report's claim, re-verified live |

**Divergence note (resolved, not a finding):** the task brief's premise that a KDS nav/permission fix (`d2bcefb` on `demo/kds-nav-recovery`) was unmerged into the primary frontend head is **incorrect as of current state** — `git merge-base --is-ancestor` confirms the equivalent commit (`ca23b73`, same diff, different hash from a rebase) is already an ancestor of `demo/p0-live-wiring`'s HEAD `61651e1`. No cherry-pick or merge action is needed for step 18.

---

## Related sub-reports (produced during this audit, indexed separately)

- `2026-09-06_GOLDEN-PATH-AUDIT_pos-branch-load-and-catalogue-sellable.md` — steps 10, 13 detail
- `2026-09-06_GOLDEN-PATH-AUDIT_pos-create-fire-payment-receipt-refund.md` — steps 14, 15, 16, 21, 22, 23 detail

These were produced by two of the seven research passes, which (correctly, per this repo's standing CLAUDE.md policy inherited into their own context) wrote dated evidence files rather than only returning inline findings. This consolidated report is the single authoritative synthesis requested by the task; the two files above are retained as supporting evidence, not superseded or duplicated content.

---

## Summary

```
TOTAL_STEPS: 27
GREEN_COUNT: 21
BLOCKER_COUNT: 6
DEMO_CRITICAL_BLOCKERS: 6 (steps 13, 16, 19, 22, 23, 24)
NONCRITICAL_BLOCKERS: 0 in-scope steps; 2 cross-cutting caveats noted (not counted as step blockers):
  - Low-severity terminal-ID replay on token refresh not surface-scoped (Token/Session Audit)
  - Local-dev seed-dev-data.ts Cashier role lacks payment/cash-session permissions — do not use it to (re)seed the demo tenant; use real signup provisioning instead
RECOMMENDED_FIX_ORDER:
  1. Step 13 — fix invented "menu.manage" permission key to real "menu.item.manage" (3 files) so Owner can create sellable items at all
  2. Step 19 — pre-demo runbook: configure category station-routing-rules via existing UI (no code change required to pass the demo)
  3. Step 16 — add table-selection / order-type default to NewOrderPane so Fire's FR-POS-003 check is satisfiable
  4. Step 24 — add a console/dashboard page for CashClosePolicy creation, wired to the already-implemented service call
  5. Step 23 — grant pos.refund.issue to Manager (and/or Cashier, pending governance decision) canonical role template
  6. Step 22 — wire the working receipt endpoint into a POS payment-complete display/print view
ESTIMATED_NUMBER_OF_CODE_CHANGES: 5 required for full demo-critical closure (steps 13, 16, 22, 23, 24) + 0 required for step 19 (runbook/config only) + 1 optional hardening fix (terminal-ID refresh scoping, non-blocking) + 1 optional durable backlog item (fallback-station admin route, non-blocking)
SAFE_TO_CONTINUE_PATCHING_ONE_BY_ONE: YES — but only now that the full dependency map above exists; follow RECOMMENDED_FIX_ORDER rather than discovery order, since steps 16 and 19 both gate every downstream step and were previously being hit as surprises during live walkthroughs rather than found up front.
```
