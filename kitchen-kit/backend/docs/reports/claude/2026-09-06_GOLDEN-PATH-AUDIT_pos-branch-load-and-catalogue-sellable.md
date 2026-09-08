# GOLDEN-PATH-AUDIT — Steps 10 & 13: POS branch load, catalogue sellability

**Report type:** Audit / verification report (read-only, static code audit)
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this document
records what was verified in this session only.
**Date:** 2026-09-06
**HEAD (backend):** `3e4f85c8` (`full-srs/lane-d4-reporting-demo`)
**HEAD (frontend):** `61651e1` (`demo/p0-live-wiring`, `ros-front/kitchen-kit`)
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary:** No files modified by this audit. Pre-existing
untracked/modified files noted at session start
(`docs/reports/claude/INDEX.md` modified, `2026-09-05_PROD-DEMO-SMOKE_*.md`
untracked) were left untouched.
**Task identifier:** GOLDEN-PATH-AUDIT (steps 10 and 13 of the
demo-readiness golden path)

## Scope

Read-only research only. No files changed, no servers started, no E2E run.
Verified prior claims in
`docs/reports/claude/2026-09-06_DEMO-POS-BRANCH-CONTEXT-HOTFIX_pos-must-not-call-org-branches.md`
against current code on both repos (both HEADs above are strictly at or
after that report's parent HEADs; the two intervening backend commits
`8fad55d`/`3e4f85c8` are docs-only, confirmed via `git show --stat`).

## Step 10 — POS loads with correct branch

**Verified GREEN.** The previously-reported defect (frontend helpers
`perBranch`/`stationsRaw` falling back to the tenant-owner-only
`GET /org/branches` for a branch-scoped Cashier/Kitchen-Staff session) is
fixed and still fixed at current HEAD:

- `lib/console/services/http.ts:320-321` — `accessibleBranchesRaw` wraps
  `api.organisation.getAccessibleScope().then((r) => r.branches)`.
- `lib/console/services/http.ts:2455` (`perBranch`) and `:2625`
  (`stationsRaw`) both call `accessibleBranchesRaw().catch(() => [])`, not
  `branchesRaw()` (`GET /org/branches`). `branchesRaw` (`http.ts:304`)
  remains, unchanged, for the genuinely Owner-only pages (Tenants, Brands,
  Branches admin).
- `lib/console/live-session.ts:92` — the console-wide branch/brand switcher
  itself reads `api.organisation.getAccessibleScope()`, not
  `GET /org/branches`, confirmed by its own docblock (`live-session.ts:21-25`).
- `components/terminal/pos-live.tsx:149` —
  `const branchId = scope.branchId ?? bound.data?.branchId ?? null;` — POS
  never reads a tenant-wide list; it derives from the bound terminal/scope.
- `components/terminal/chrome.tsx:218-219` — the live `BoundIdentity` block
  calls `services.organisation.branches.get(scope.branchId)` (a
  branch-scoped read), `.catch(() => null)`-guarded.
- `lib/console/providers.tsx:341,489-493` — `effectiveBranchId` feeds
  `scope.branchId`, sourced from `org.branches` (i.e. `GET /org/access`)
  when `scopeLocked` (terminal/bound session), never from the tenant-owner
  branch list.

Backend: `GET /org/access` →
`src/modules/organisation/organisation.controller.ts:298-317`
(`OrganisationController#getAccessibleScope`) — no `@RequirePermission`
(deliberate, documented at `:281-297`: "every authenticated member of the
tenant may discover their OWN accessible scope"), returns
`brands`/`branches` resolved per-caller via `auth.grants`
(`BranchesService#listAccessible`, `BrandsService#listAccessible`) — a
branch-scoped Cashier/Kitchen-Staff gets only their own branch(es); an Owner
gets the same rows `GET /org/branches` would return. `GET /org/branches`
itself (`organisation.controller.ts:405-419`) is unchanged: correctly
requires `organisation.branch.read` at tenant target — intentionally
Owner-tier, per the prior hotfix report's own investigation (not re-derived
here, only re-confirmed the controller code is unchanged).

No backend or frontend change needed for step 10; already fixed in
frontend commit `fd0cbd1` ("fix: use caller's own accessible branches
instead of tenant-owner list") and unaffected by the two later commits
(`4ce588e`..`61651e1`), which touch unrelated station-sync/drawer/session-
isolation concerns (confirmed via `git show <sha> --stat` — no overlap with
`http.ts`'s branch-resolution functions or `pos-live.tsx`'s branch line
except a 4-line touch in `61651e1` unrelated to branch derivation, per its
own commit message: token-storage-slot isolation only).

## Step 13 — Catalogue has something sellable

**Two independent, compounding problems found — classified BLOCKED_FRONTEND
(the immediate demo blocker), with a real BLOCKED_PROVISIONING gap
underneath it.**

### Backend: fully capable, correctly permissioned

`src/modules/catalogue/catalogue.controller.ts` exposes full CRUD:
`POST /catalogue/menus`, `.../menus/:id/branches` (branch assignment),
`POST /catalogue/items`, `.../items/:id/variants`, `.../items/:id/placements`,
`POST /catalogue/price-lists`, `.../price-lists/:id/entries`,
`POST .../price-lists/:id` activate, `POST /catalogue/availability-rules`.
Permission codes (`src/modules/catalogue/catalogue.permissions.ts:20-33`):
`menu.item.read`/`menu.item.manage`, `menu.price.read`/`menu.price.change`,
`menu.availability.read`/`menu.availability.toggle`. Every write route
correctly requires the `.manage`/`.change`/`.toggle` code
(e.g. `createMenu` → `ITEM_MANAGE` at `catalogue.controller.ts:303`;
`assignBranch` → `ITEM_MANAGE` at `:387`; `addVariant` → `ITEM_MANAGE` at
`:701`; `createPriceList` → `PRICE_CHANGE` at `:904`).

Owner role: `src/modules/identity/registrations/registrations.service.ts:231`
grants `ALL_PERMISSION_CODES` to the tenant's `Owner` role at signup —
includes every catalogue code. **Owner has full catalogue-manage rights by
default.** Cashier/Kitchen Staff canonical templates
(`src/modules/identity/authz/canonical-role-templates.ts:58-68,118`) grant
only `ITEM_READ`/`PRICE_READ`/`AVAILABILITY_READ` (Cashier) or nothing
catalogue-related (Kitchen Staff, `kds.operate` only) — correct; neither
role should create catalogue data.

Pricing model: a variant's actual sellable price comes from
`PriceEntry`/`PriceList` resolved by
`src/modules/catalogue/pricing/price-resolution.service.ts` (tenant/brand/
branch-scoped, active-window-aware) — **not** from any `basePrice` field on
the variant row itself (`CreateVariantDto` at `catalogue.dto.ts:119` and
`menu-items.service.ts`/`catalogue.views.ts` carry no `basePrice` field at
all). An item is "sellable" per the tenant's own C-11 definition
(`GET /catalogue/completeness`, `catalogue.controller.ts:1082-1127`) only
once it has an active variant, priced in an active price list.

### Frontend: real pages, wired to real backend, but broken by a permission-key typo

`app/(console)/menu/{menus,items,modifiers,pricing,categories}/page.tsx`
are real backend-wired pages (`services.catalogue.*`), **not** mocks —
confirmed no `lib/console/mock/catalogue.ts` import in any of them
(`app/(console)/menu/items/page.tsx:66-71` docblocks explicitly that
categories were moved off the mock fixture). The mock file
(`lib/console/mock/catalogue.ts`) exists but is unused by these routes.

**Bug found:** three of these pages gate their entire "manage" UI behind
`usePermission("menu.manage")` — a permission key that **does not exist**
in the permission catalogue (`lib/console/permissions.ts` defines
`menu.item.manage`, not `menu.manage` — confirmed via
`grep 'def("menu\.' lib/console/permissions.ts`, only four `menu.*` keys
exist: `menu.view`, `menu.item.manage`, `menu.price.change`,
`menu.availability.toggle`). `PermissionKey` is structurally `string` (the
`def()` helper's `key` parameter is untyped `string`, so
`(typeof PERMISSION_CATALOGUE)[number]["key"]` widens to `string` — verified
`npx tsc --noEmit` produces zero errors on the three call sites, i.e.
TypeScript gives no protection against the typo).

Exact locations:
- `app/(console)/menu/items/page.tsx:348` —
  `const canManage = usePermission("menu.manage");`
- `app/(console)/menu/menus/page.tsx:55` — same literal
- `app/(console)/menu/modifiers/page.tsx:226` — same literal

Because `providers.tsx:464-472`'s `granted` set is built from the server's
own normalized permission codes (which will contain `menu.item.manage`,
never the literal string `menu.manage`), `canManage` evaluates **false for
every role, including Owner** whenever `granted` is populated (the live
path). Gated behind this permanently-false flag:
- `menus/page.tsx:150` — the entire "New Menu" create button (hidden, not
  just disabled) — **an Owner cannot create a menu from the console UI.**
- `menus/page.tsx:372-389` — the "assign branch to menu" control (the
  exact action step 13 needs to make a menu reachable at a branch) —
  hidden.
- `items/page.tsx:462-466` — "Add Variant" button on an item — hidden, so
  **no variant can be added to an item from the console UI**, which blocks
  the item from ever having a priced, sellable variant via this path.
- `items/page.tsx:488-496` — variant activate/deactivate toggle — hidden.
- `items/page.tsx:621` — `ModifierGroupLinker` returns `null` outright.
- `modifiers/page.tsx:260` — (not inspected in full; same gate, likely
  create-modifier control).

Not affected: `items/page.tsx:47-53`'s page-level `Gate
permissions={["menu.view"]}` (correct key, page still loads);
`items/page.tsx:58` `canToggle = usePermission("menu.availability.toggle")`
(correct key, 86/restore works); the top-level "New Item" button
(`items/page.tsx:196-199`, ungated) and category placement in
`NewItemDrawer` (ungated) — so a bare, unplaced-on-a-branch, variant-less
item CAN be created, but cannot be finished into something sellable via
the UI. `app/(console)/menu/pricing/page.tsx` has no such gate (grep for
`Permission`/`canManage`/`canChange` returns nothing) — price-list creation
itself is not blocked by this bug, but is moot without a variant to price.

### Setup data missing

`src/modules/identity/registrations/registrations.service.ts:113-114`
(comment, verbatim): *"Starter menu/catalogue provisioning is DEFERRED for
this slice... a signed-up tenant has a working branch but no menu yet."* A
freshly self-registered Owner tenant (the real production signup path,
`feat: add owner self-service registration`) has **zero** catalogue rows —
no menu, category, item, variant, price list. The only place a full,
correctly-sequenced sellable item is provisioned end-to-end is
`src/scripts/seed-dev-data.ts:332-362` (menu → assignBranch → category →
item → place → variant → price list → price entry → activate) — a
standalone dev/demo script with no `package.json` script entry and no call
from the signup path; it is not run automatically for a new tenant.

## Table

| Step | Classification | Route/Component | Failing API Endpoint | Required Permission/Scope | Should Owner/Cashier/Kitchen have it? | Setup data missing? | Smallest safe fix | Demo-critical? |
|---|---|---|---|---|---|---|---|---|
| 10 | GREEN | FE: `components/terminal/pos-live.tsx:149`, `chrome.tsx:218-219`, `lib/console/providers.tsx:341,489-493`, `lib/console/live-session.ts:92`, `lib/console/services/http.ts:320-321,2455,2625`. BE: `src/modules/organisation/organisation.controller.ts:298-317` (`getAccessibleScope`) | None (previously `GET /org/branches`, now not called by non-owner paths) | `GET /org/access`: none beyond auth. `GET /org/branches`: `organisation.branch.read`, tenant target | Owner: yes (has `BRANCH_READ`, tenant-wide, uses `/org/branches` on Owner-only admin pages). Cashier/Kitchen: should NOT need tenant-wide `BRANCH_READ` — and don't; they resolve via `/org/access`, already correctly scoped | No | None — already fixed in FE commit `fd0cbd1`; re-verified unbroken at current HEAD `61651e1` | Yes |
| 13 | BLOCKED_FRONTEND | FE: `app/(console)/menu/items/page.tsx:348`, `menus/page.tsx:55`, `modifiers/page.tsx:226` (all `usePermission("menu.manage")`, should be `"menu.item.manage"`). BE: `src/modules/catalogue/catalogue.controller.ts` (menus/items/variants/price-lists routes, all present and correct) | None returns an error — the UI simply hides the controls; backend routes work if called directly (e.g. via seed script or API) | Backend: `menu.item.manage` (create menu/item/variant, assign branch), `menu.price.change` (price lists/entries). Frontend gate checks the non-existent key `menu.manage` | Owner: yes, and backend already grants it (`ALL_PERMISSION_CODES` at signup, `registrations.service.ts:231`) — but the FE typo hides the controls from Owner too. Cashier/Kitchen: correctly should NOT have manage (canonical templates give them read-only/none) | Yes — fresh Owner self-signup tenant has zero catalogue rows (`registrations.service.ts:113-114`, "DEFERRED"); only `src/scripts/seed-dev-data.ts:332-362` provisions a full sellable item, and it is a standalone dev script, not invoked by signup | (1) Change the three `usePermission("menu.manage")` call sites to `usePermission("menu.item.manage")`. (2) Either wire `seed-dev-data.ts`'s catalogue block (or an equivalent minimal menu+item+variant+price-list+branch-assignment) into the demo tenant's provisioning path, or manually run it against the demo tenant before the demo | Yes |

## SRS relevance

No requirement reinterpreted. Step 10's `GET /org/access` /
`GET /org/branches` split is FR-SEC-045 (client asks only for what its own
session can get) — unchanged, already ratified per the cited prior report.
Step 13's backend permission model (`menu.item.manage` etc.) matches SRS
§15.2 verbatim per `catalogue.permissions.ts:1-19`'s own docblock — the
defect found here is a frontend presentation-layer bug (FR-SEC-045's
"hiding a control is presentation only" cuts the other way here: the
control is *wrongly* hidden from someone who does have the permission) and
a provisioning gap explicitly flagged as deferred by the codebase's own
in-repo comment, not a hidden or reinterpreted requirement.
