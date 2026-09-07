# DEMO-POS-BRANCH-CONTEXT-HOTFIX — Cashier terminal must not call GET /org/branches

**Report type:** Implementation / verification report
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was done and verified in this session only.
**Date:** 2026-09-06
**HEAD (backend, this task's parent):** `dc746a9` (DEMO-POS-EMPLOYEE-SESSION-HOTFIX)
**HEAD (frontend, this task's parent):** `b8528be`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** Frontend touched `lib/console/services/http.ts`
only. **No backend change** — investigated and confirmed
`GET /org/branches`'s tenant-owner-only restriction is correct, ratified
behaviour; the defect was entirely in the frontend's own service layer.
Same pre-existing, unrelated `INDEX.md`/`PROD-DEMO-SMOKE` items left
untouched.
**Task identifier:** DEMO-POS-BRANCH-CONTEXT-HOTFIX (a branch-scoped
Cashier's terminal session calling the tenant-owner-only branch list and
crashing)

## Trace

**FAILING_CALLER:** Not `pos-live.tsx`/`chrome.tsx` (the actual live POS
screen tree) directly — both were already correct: `LivePos` derives its
branch from the bound terminal (`scope.branchId ?? bound.data?.branchId`),
never from `GET /org/branches`, and `chrome.tsx`'s real (`live`-mode)
`BoundIdentity` uses `services.organisation.branches.get(id)` (a
branch-scoped read, and already `.catch(() => null)`-guarded). The actual
caller is `lib/console/services/http.ts`'s **`perBranch`** helper — used by
`services.operations.stations`/`.tables`, and in turn by `useStations`
(`components/terminal/kds-live.tsx`'s KDS screen, reachable from the same
terminal/employee session the ticket describes) — and the separate
**`stationsRaw`** lookup table (used by the KDS ticket-context resolver,
`ticketContext`/`toTickets`, which runs on every station-queue read).

**WHY_POS_CALLED_ORG_BRANCHES:** Neither function actually needed the
FULL tenant branch roster. `perBranch`'s job is "fan a per-branch endpoint
out over whatever branches are in scope" — when no explicit `branchId` was
supplied (the exact case for the KDS screen's station-picker/lookup calls,
which pass a bare, unscoped `Scope`), it unconditionally called
`branchesRaw()` (`GET /org/branches`) to get "all branches" to fan out
over, with **no regard for who was asking**. That is correct for an Owner
(who has the permission and wants the full roster) and a straightforward
403 for anyone else — exactly what the reported evidence shows.
`stationsRaw` had the identical, independent copy of the same mistake.

**UNDEFINED_MAP_SOURCE:** Every level actually reached in the CURRENT code
already degrades safely — `useAsync`'s catch resets `data` to `null`,
`useStations` returns `stations.data ?? []`, and every downstream
`.map()` in `kds-live.tsx` operates on an already-array-typed value
(`stations`, or a `useMemo`-derived list with its own `?? []`/empty-array
fallback). The specific crash could not be pinned to one exact currently-
reachable line by static trace alone (some intermediate defensive code in
this session's own earlier tickets may have already narrowed the window),
but the MECHANISM matches exactly: `perBranch`/`stationsRaw` rejecting
with an unhandled 403 is the only place in this whole chain that was
**not** already wrapped in a `.catch()`, so it is the one plausible source
of an actually-uncaught rejection reaching a UI layer that assumes an
array. Fixed at the source regardless, per the ticket's own instruction to
hunt the actual gap rather than only patch a symptom.

**CORRECT_BRANCH_SOURCE:** `GET /org/access` — already 200 for this exact
Cashier per the reported evidence, and its `branches` field is the
caller's own live-scoped accessible set: every branch for a tenant-scoped
Owner (the SAME rows `GET /org/branches` would return — verified against
the generated OpenAPI schema, byte-identical field shapes), and just the
caller's own branch(es) for a branch/brand-scoped role. Needs no
permission beyond being authenticated — confirmed by direct read of
`OrganisationController#getAccessibleScope` (unchanged, not touched).

## BACKEND INVESTIGATION (no change made)

Confirmed, by direct read, that `GET /org/branches`'s
`@RequirePermission(ORGANISATION_PERMISSIONS.BRANCH_READ)` +
`tenantTarget(...)` is exactly the ratified, intentional design (a branch-
scoped grant has no tenant-target permission to satisfy it) — this is
NOT a bug, and per the ticket's explicit instruction, was left completely
untouched. The defect was entirely that a FRONTEND helper called this
tenant-owner-only route for a caller it was never meant to serve.

## FIX

`lib/console/services/http.ts`:

- Added `accessibleBranchesRaw` — a `cached()` wrapper around
  `api.organisation.getAccessibleScope().then((r) => r.branches)`,
  documented as the universal, permission-safe source for "the caller's
  own branches," alongside the pre-existing `branchesRaw` (kept, and still
  used, unchanged, by the genuinely Owner-only console pages/services —
  Tenants list, Brands list, the Branches admin page's own list/create —
  where the full tenant roster is both correct and already
  permission-gated at the PAGE level).
- `perBranch`'s no-explicit-`branchId` fallback now calls
  `accessibleBranchesRaw().catch(() => [])` instead of `branchesRaw()` —
  correct for an Owner (same rows) and now correct, not a 403, for a
  branch-scoped Cashier/Kitchen-Staff session (their own branch only).
- `stationsRaw` (the KDS ticket-context lookup table) gets the identical
  fix, independently, since it had its own separate direct call.
- Both changes are additive/substitutive only — no existing Owner-facing
  behavior changed (an Owner's `accessibleBranchesRaw()` result is the
  SAME set `branchesRaw()` already gave them), and the explicit `.catch(()
  => [])` hardens the "API failure must never produce `undefined.map()`"
  requirement at the exact point that previously had no safety net.

`pos-live.tsx`/`chrome.tsx` needed **no change** — both already correctly
derive the POS screen's own branch from the bound terminal, matching the
in-app text the ticket itself quoted ("The branch comes from the bound
terminal, not from the console's scope picker").

## Tests

Frontend `typecheck`: clean.
Frontend `build`: clean — every route, `/pos` and `/kds` (the
`(terminal)` group) included, prerenders.

No backend change, so no backend regression suite was re-run — confirmed
via `git status` that no backend source file changed. No frontend
component/unit test harness exists in this repo to target narrowly (the
project's test convention is backend e2e only); the fix was verified by
direct source trace of every caller of `branchesRaw()`/`perBranch` before
and after, confirming the two non-owner-reachable call sites are the ONLY
ones changed and the Owner-only call sites are untouched.

## SRS relevance

No requirement reinterpreted. `GET /org/branches`'s tenant-owner-only
restriction (FR-SEC-002/003/004, the branch-scoped RBAC amendment) is
unchanged and was never the defect — this is a client-side correctness
fix (FR-SEC-045: a client must ask the server for only what its own
session can actually get) that stops a lower-privileged session from ever
being routed to an endpoint it was never meant to reach.
