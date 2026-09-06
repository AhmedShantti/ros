# DEMO-OPS-HOTFIX-3 — Station persistence + cash drawer provisioning

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `73534cf` (DEMO-BRANCH-SETUP-HOTFIX)
**HEAD (frontend, this task's parent):** `588608a`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Backend added a new Drawer administration
controller/DTO/view and a POS-facing drawer-list route on
`TreasuryController`; touched `test/cash-session.e2e-spec.ts` (a
closed-route-surface assertion updated for the new route) and regenerated
OpenAPI. Frontend fixed the Stations page's branch-context bug, added a
KDS station-existence validation, added the Operations → Drawers page, and
fixed the POS Open-Shift screen's drawer selection. Same pre-existing,
unrelated `INDEX.md`/`PROD-DEMO-SMOKE` working-tree items left untouched.
**Task identifier:** DEMO-OPS-HOTFIX-3 (station disappearing after
create/reload; `POST /cash-sessions` 404 "Drawer not found")

## PART A — Station disappears after create/reload

### Investigation (answers to the 9 questions asked)

1. **Does station POST really return 2xx?** Yes — `StationsService.create`
   is a normal, real, `withAuthContext` transaction; verified again this
   session.
2. **What branchId is used on POST?** Whatever the Stations page's own
   `branchId` React state held at the moment "New station" was clicked.
3. **Does an immediate GET against that SAME branchId return it?** Yes —
   `stationsQuery.reload()` re-fetches with the SAME state variable in the
   same render cycle; confirmed by reading `useAsync`'s effect semantics
   (the effect that runs on `reload()` always closes over the CURRENT
   render's producer, so this is never stale).
4. **What branchId does the frontend use ~3 seconds later / after reload?**
   **This is the root cause.** `StationsScreen` (added in
   `DEMO-OPS-HOTFIX-2`) picked its default branch with
   `useState(branch?.id ?? availableBranches[0]?.id ?? "")` — a ONE-TIME
   initializer. `branch`/`availableBranches` come from
   `useLiveOrgContext`, which resolves ASYNCHRONOUSLY (`ready` starts
   `false`, `branches` starts `[]`) and is guaranteed to be re-fetched from
   scratch on every hard reload. If the Stations page mounts before that
   resolves — the common case right after navigating in fresh, and the
   GUARANTEED case on a hard reload — `branchId` locks onto `""` (or a
   branch no longer first in the list) FOREVER, because a `useState`
   initializer only ever runs once and nothing else in the component
   re-synced it. The list then queries with an empty/wrong branchId,
   returning nothing — visually indistinguishable from "the station
   vanished," but the station was never touched; the BRANCH SELECTION was
   the thing that silently reset.
5. Answered by (4).
6. **Does org-context rehydration switch/reset branch context?** It doesn't
   reset anything maliciously — it simply resolves LATER than this page's
   own default-branch selection, which had already locked in.
7. **Does `useStations()` replace optimistic data with an empty result?**
   No optimistic UI exists anywhere in this flow; not the cause.
8. **Is there a response-shape mapper dropping real stations?** No —
   `map.toStation` and `perBranch` were read again in full and are correct;
   confirmed via the ALREADY-passing `DEMO-OPS-HOTFIX-2` reproduction using
   these same functions.
9. **Does KDS's localStorage station binding get cleared when the station
   is absent from the reloaded list?** Checked directly: **no** — the prior
   code only gated on `!stationId`, never checked whether the persisted id
   was actually IN the current `stations` result, so a genuinely-gone
   station would silently render a broken/blank-named screen rather than
   falling back to the picker. Fixed as part of this task (see below).

**STATION_ROOT_CAUSE: D. SESSION_BRANCH_REHYDRATION** — proven by direct
source inspection (a classic "un-synced `useState` initializer racing an
async context" defect), not by guessing at the "~3 seconds" figure. The
STATION was never lost; the PAGE'S OWN BRANCH SELECTION was never
initialized correctly in the first place and never had a way to correct
itself.

### Fix

`app/(console)/operations/stations/page.tsx`: replaced the one-time
`useState` initializer with a `useEffect` that re-syncs `branchId` to
`branch?.id ?? availableBranches[0]?.id ?? ""` whenever the CURRENT
selection is not (or no longer) a real, visible branch — and otherwise
leaves an explicit user choice alone. This is reactive to
`branch`/`availableBranches` resolving at any point after mount, including
after a hard reload.

`components/terminal/kds-live.tsx`: added a validation effect — if a
`localStorage`-persisted `stationId` is set but the CURRENT, non-empty,
real `stations` list does not contain it, it is cleared (falls back to the
station picker) rather than silently rendering a broken bound screen.
Deliberately gated on a NON-EMPTY list (never while `stations` is merely
still loading, which `useStations` cannot distinguish from "branch really
has none") so a valid persisted station is never dropped just because the
fetch hasn't returned yet.

No backend change was needed for Part A — `StationsService`,
`organisation.controller.ts`'s station routes, and the OpenAPI-generated
frontend client were all already correct (confirmed again by direct
re-read).

## PART B — `POST /cash-sessions` 404 "Drawer not found"

### Investigation

`DrawersService` (`src/modules/treasury/drawers/drawers.service.ts`,
pre-existing) already had `create`/`listForBranch`/`requireForBranch` —
fully real, RLS-scoped, with branch/terminal validation — but **no public
HTTP route reached any of it**, by an explicit prior design note ("no
source says a terminal implies a drawer... the missing operator surface is
reported, not faked"). `CashSessionsService.open` already calls
`drawers.requireForBranch(tx, input.drawerId, branch.id, terminalId)`
(unchanged) — proving the 404 was always going to happen for ANY
`drawerId` that does not correspond to a real `Drawer` row.

**Found the frontend's own contributing bug while tracing this**:
`components/terminal/pos-live.tsx`'s `OpenDrawer` component submitted
`terminal?.id` AS `drawerId` — literal comment: "a till has one drawer, so
the drawer *is* the terminal, and the terminal's id is one the server
issued." A Drawer and a Terminal are different rows (even when paired
one-to-one), so this always 404'd — this is the frontend-side manifestation
of the SAME reported blocker, now fixed alongside the backend surface.

**DRAWER_DOMAIN_OWNER:** Treasury (`src/modules/treasury/drawers/`).
**DRAWER_EXISTING_SERVICE:** `DrawersService` — reused verbatim, zero
duplicated business logic; only `listForTerminal` (branch-from-terminal
resolution, mirroring `CashSessionsService.open`'s own pattern) is new.
**DRAWER_HTTP_ROUTES:**
- `POST /branches/:branchId/drawers`, `GET /branches/:branchId/drawers` —
  new `DrawersController`, mounted on the SAME bare `/branches/...` family
  `CashClosePolicyController` already established for branch-scoped
  Treasury configuration (not `/org/branches/...`, which is
  Organisation's own, separate family).
- `GET /cash-sessions/drawers` — new route on the EXISTING
  `TreasuryController`, POS-session-only (inherits the controller's
  `@AllowPosSession()`), resolving the branch from the caller's OWN
  terminal (`DrawersService.listForTerminal`) — never a caller-supplied
  branchId.

**DRAWER_REQUIRED_PERMISSION:**
- Admin routes (`DrawersController`): `TREASURY_PERMISSIONS.
  SETTINGS_BRANCH_MANAGE` (`settings.branch.manage`) — the SAME code
  `CashClosePolicyController` already uses for this exact kind of
  branch-scoped Treasury configuration. No permission invented; Cashier's
  canonical role does not have it.
- Cashier route (`GET /cash-sessions/drawers`): `cash.session.open` — the
  SAME permission a Cashier already needs to open a shift. Deliberately
  NOT `settings.branch.manage`, so this can never be mistaken for a
  drawer-administration grant.

### Fix

Backend: `DrawersController` (new), `CreateDrawerDto` (new),
`drawer.view.ts` (new, shared `toDrawerView`/`drawerSchema` for both
controllers), `DrawersService.listForBranch` now 404s on an unknown branch
(mirroring Stations' `assertBranch`) and gained `listForTerminal`;
`TreasuryController` gained `listSessionDrawers`; both registered in
`treasury.module.ts`. OpenAPI regenerated (additive — `POST`/`GET
/branches/{branchId}/drawers`, `GET /cash-sessions/drawers`); the
generator's create-drawer wrapper correctly carries `idempotent: true`
from the `@ApiHeader` on the POST route (no hand-rolled header). A
pre-existing closed-route-surface test
(`test/cash-session.e2e-spec.ts`) asserted no `drawer*` path existed under
`/cash-sessions` — updated to include the new, deliberately-scoped
`/cash-sessions/drawers` read route and to narrow its forbidden-path check
to `drawer-admin` (still correctly absent from this family).

Frontend: `services.treasury.listDrawers/createDrawer/listSessionDrawers`
(new, `http.ts`/`mock.ts`/`types.ts`), a `Drawer` console type, `map.
toDrawer`; new `app/(console)/operations/drawers/page.tsx` (list + create,
branch-scoped, same branch-context-resync pattern as the Stations fix);
`pos-live.tsx`'s `OpenDrawer` now fetches the REAL drawer list — shows it
read-only when exactly one exists (preserving the original "shown, not
asked for" UX), offers a real choice when more than one exists, and shows
an explicit "ask an Owner" message when none exist, instead of ever
submitting a placeholder id.

## Tests

New `test/drawers-provisioning.e2e-spec.ts` — **5/5 passed**: owner
creates a real drawer and it persists through a fresh GET (twice, the
second standing in for a reload); a Cashier lists their own branch's
drawers and opens a shift over one (**201**, the exact previously-reported
404 now resolved); a wrong-branch drawer is rejected (404) when opening a
shift; a Cashier (POS session) cannot administer drawers (401/403); and
cross-tenant drawer access is rejected (404).

Regression, single combined run — **9 suites, 161 tests, all passed**:
`cash-session` (47/47, incl. the updated route-surface assertion),
`cash-session-close` (35/35), `drawers-provisioning` (5/5),
`cash-session-cashier-role` (4/4), `employee-role-assignments` (5/5),
`workforce-employees-hotfix` (5/5), `registrations` (7/7),
`branches-signup-and-management` (4/4), `openapi.e2e-spec.ts` (49/49).
`module-boundaries.spec.ts`: 46/46, `KNOWN_DEVIATIONS` unchanged.
`kds-operator-lifecycle.e2e-spec.ts` (smallest KDS regression, backend KDS
code untouched): 12/12.

Backend `typecheck`/`build`: clean. Frontend `typecheck`/`build`: clean —
`/operations/stations` and the new `/operations/drawers` both prerender.

Full/heavy e2e suite deliberately not run, per the ticket's own
instruction.

## Known, pre-existing, out-of-scope gap (not fixed here)

`POST /cash-sessions/:id/close` (the physical close-declare, distinct from
reaching close-context) still requires a per-branch cash-close policy
(FR-FIN-006) with no public administration route — noted in the
`DEMO-OPS-HOTFIX-2` report and unchanged here; not reported as a blocker
in this ticket.

## SRS relevance

FR-KDS-001 (station configuration) and FR-FIN-001 (the drawer as a
physical cash container) are pre-existing, ratified requirements this
task did not reinterpret. Part A is a frontend state-management
correctness fix; Part B exposes an existing, already-correct backend
capability through a minimal, permission-consistent public surface, reused
verbatim rather than duplicated.
