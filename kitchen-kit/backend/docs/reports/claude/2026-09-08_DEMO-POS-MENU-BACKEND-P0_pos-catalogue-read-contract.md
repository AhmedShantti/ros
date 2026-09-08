# DEMO-POS-MENU-BACKEND-P0 — the real backend contract for a POS session's sellable menu

**Report type:** Implementation + verification report
**Task identifier:** DEMO-POS-MENU-BACKEND-P0
**Date:** 2026-09-08
**HEAD (base, before this task's changes):** `12593c841482f2a28d99881b8a79881d2190c400`
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary (start of task):** clean except two untracked `.DS_Store` files outside the repo tree (`../../.DS_Store`, `../.DS_Store`) — not touched by this task.
**Working tree summary (end of task):** see FILES_CHANGED below. Not committed at the time this report file is written; committed as a separate step per this task's instructions (see BACKEND_COMMIT).

## Authority statement

This report is non-authoritative evidence produced by direct implementation
and verification work in this session. The SRS and ratified governance
decisions remain authoritative. Every test result below was executed live in
this session against Postgres on `localhost:5566` via the repo's per-suite
database-isolation e2e harness — none is carried over from a prior report.

---

## 1. TRACE — CURRENT CATALOGUE ROUTE CONTRACT (before this task)

All routes below live on `CatalogueController` (`@Controller('catalogue')`,
guard chain `JwtAuthGuard → TenantContextGuard → PermissionGuard`, **no**
`@AllowPosSession` anywhere on the controller before this task).

| Route | Guards | `@AllowPosSession` | `@RequirePermission` | Authorization target | Scope | Admin CRUD vs. legitimate POS read |
|---|---|---|---|---|---|---|
| `GET /catalogue/items` | class chain | **absent** | `menu.item.read` | `tenantTarget(...)` | **Tenant-wide** (every item, every branch) | Admin read — full admin fields (kitchenNames, aggregatorNames, taxClassId, revenueAccountCode, barcodePlu) |
| `GET /catalogue/items/:id` | class chain | absent | `menu.item.read` | `tenantTarget(...)` | Tenant-wide | Admin read (same fields) |
| `GET /catalogue/items/:id/variants` | class chain | absent | `menu.item.read` | `tenantTarget(...)` | Tenant-wide | Admin read |
| `GET /catalogue/items/:id/placements` | class chain | absent | `menu.item.read` | `tenantTarget(...)` | Tenant-wide | Admin read |
| `GET /catalogue/availability-rules` | class chain | absent | `menu.availability.read` | `tenantTarget(...)` | **Tenant-wide** (all rules across all branches; only filter is `menuItemId`, not branch) | Admin read |
| `GET /catalogue/branches/:branchId/menus` | class chain | absent | `menu.item.read` | `branchFromParam('branchId')` — **client-supplied branch id** | Branch-scoped, but the branch is chosen by the caller, not derived from a POS session | Legitimate branch-scoped read, but returns only `Menu` rows (no items/variants/prices/availability) and accepts an arbitrary `branchId` |
| Price-list / price-resolution routes used by POS pricing (`GET /catalogue/price-lists`, `.../entries`) | class chain | absent | `menu.price.read` | tenant/resource target | Tenant-wide | Admin read; no HTTP route returns a *resolved* price at all — resolution is `PriceResolutionService`, a query service with no HTTP surface (its own docblock: "Sales will consume this directly") |

**Root cause of the observed 403:** none of these routes carry
`@AllowPosSession()`. `JwtAuthGuard` refuses any `typ: 'pos'` (PIN-issued)
session on a route that has not opted in (FR-SEC-021, "PIN authentication
SHALL NOT grant access to the web dashboard") — `src/modules/identity/auth/guards/jwt-auth.guard.ts`
throws `ForbiddenException` (403) before the permission/target check ever
runs. This exactly reproduces the reported evidence: a valid POS token
(`POST /orders → 201` succeeds) still gets 403 on `GET /catalogue/items` and
`GET /catalogue/availability-rules`.

This is **not** a missing-permission problem (see §2) — it is a missing
route-level `@AllowPosSession` opt-in, compounded by the fact that the
existing reads are the wrong *shape* for a POS session even if opted in (see
§4 CASE B below).

---

## 2. CASHIER PERMISSIONS — VERIFIED FROM THE REAL BACKEND

Inspected `src/modules/identity/authz/canonical-role-templates.ts`
`CASHIER_PERMISSION_CODES` directly (not trusted from any prior report or
the frontend):

```
CASHIER_MENU_PERMISSIONS:
  - menu.item.read           (CATALOGUE_PERMISSIONS.ITEM_READ)
  - menu.price.read          (CATALOGUE_PERMISSIONS.PRICE_READ)
  - menu.availability.read   (CATALOGUE_PERMISSIONS.AVAILABILITY_READ)

MISSING_PERMISSION_IF_ANY: none. Cashier already holds every read
permission a menu-resolution route would need. No canonical-role-template
change was required or made.
```

There is no separate "menu-resolution" permission code in the catalogue
permission catalog (`catalogue.permissions.ts` defines exactly six:
`ITEM_READ/MANAGE`, `PRICE_READ/CHANGE`, `AVAILABILITY_READ/TOGGLE`).

---

## 3. EXISTING POS-SAFE DOMAIN QUERY — FOUND AND REUSED, NOT DUPLICATED

Traced what Sales already uses to answer "what is sellable at this branch
right now" at order-line capture (`src/modules/sales/orders/order-lines.service.ts`,
`OrderLinesService.addLine`):

- **Price resolution:** `PriceResolutionService.resolveIn` / `.resolve`
  (`src/modules/catalogue/pricing/price-resolution.service.ts`) — the single
  FR-POS-040 tier engine (time-based → order-type → branch → brand → base).
  Already has a standalone-transaction entry point (`.resolve(tenantId, query)`)
  meant for callers with no transaction of their own.
- **Availability (86):** a narrow, deliberately scoped private method
  `OrderLinesService.assertAvailable` — evaluates only `is_manual_86`
  (branch-scoped OR tenant-wide rule, `autoReenableAt` respected), NOT the
  day/time-window columns (documented as out of scope in its own docblock).
- **Sellability of the item/variant themselves:** `OrderLinesService.loadSellable`
  — active item + active variant only.
- **Branch menu resolution:** `MenusService.resolveForBranch` — active menus
  assigned to a branch, priority order, ambiguity-flagged (FR-MNU-002/003).

**Decision:** reuse `PriceResolutionService.resolve` and `MenusService.resolveForBranch`
directly (both already public, already used elsewhere across module
boundaries). The one gap was availability: `OrderLinesService.assertAvailable`
is `private` and single-item. Rather than re-deriving that logic in a new
controller (explicitly forbidden by the task) or reaching into Sales'
private method from Catalogue (the wrong direction — Catalogue owns
availability, Sales consumes it; the existing `sales → catalogue` private-path
import of `PriceResolutionService` is itself documented in-repo as
**debt not to extend**, see `order-lines.service.ts` comment above its
`RecipeCostService` import), a new **public, batched** method was added to
`AvailabilityService` — the availability domain's own owning service —
mirroring `assertAvailable`'s exact narrow scope and documented as such:

```ts
// src/modules/catalogue/availability/availability.service.ts
async resolveBlocked(
  tenantId: string,
  branchId: string,
  menuItemIds: readonly string[],
  variantIds: readonly string[],
): Promise<{ blockedMenuItemIds: ReadonlySet<string>; blockedVariantIds: ReadonlySet<string> }>
```

No pricing or availability tier logic was reimplemented anywhere in the new
controller or service.

---

## 4. SMALLEST SAFE FIX — CASE CHOSEN: **CASE B**

`GET /catalogue/items` / `GET /catalogue/availability-rules` are tenant-wide
(not branch-scoped) and return full admin metadata (kitchen names,
aggregator names, tax class id, revenue account code, barcode). Simply
adding `@AllowPosSession()` to them (CASE A) would hand a single-branch POS
terminal the entire tenant's catalogue across every branch, plus
back-office-only fields it has no use for and should not see. That fails the
brief's explicit constraint ("Do not expose tenant-wide admin data to POS if
a narrower contract is needed").

`GET /catalogue/branches/:branchId/menus` (CASE C candidate) was also
rejected as the sole fix: it accepts an **arbitrary, client-supplied**
`branchId` (exactly what the brief prohibits — "derive branch from the
authenticated terminal/POS identity, not from an arbitrary tenant-wide
branch selector"), and it returns only bare `Menu` rows, not items, variants,
prices, availability or modifiers — a POS terminal would still need several
more tenant-wide admin reads to render anything.

**CASE B applied:** one new, narrow, POS-safe READ endpoint,
`GET /catalogue/pos-menu`, added to `CatalogueController` (the module that
already owns every piece of data it composes — no new module, no new
controller-ownership question to resolve).

### Route contract

```
POS_MENU_ROUTE:      GET /catalogue/pos-menu
POS_MENU_SCOPE:       posTerminalBranchTarget() — the caller's OWN terminal
                       branch, resolved live by TenantContextService from
                       identity.terminals on THIS request (ADR 0009 D-07).
                       Never a client-supplied id. This target ALSO denies
                       any non-POS (dashboard) caller outright — see
                       ScopeAuthorizationService.posNarrowingAllows and
                       AuthorizationTargetResolver's 'posTerminalBranch'
                       case, both pre-existing and unmodified.
POS_MENU_PERMISSION:  RequirePermission(menu.item.read, menu.price.read,
                       menu.availability.read)  — AND semantics (all three);
                       Cashier already holds all three (§2), so this is a
                       pure route-contract fix with ZERO permission-grant
                       change.
```

`@AllowPosSession()` is placed on this **one method only** — every other
route on `CatalogueController` (all admin CRUD) is untouched and remains
closed to PIN sessions by `JwtAuthGuard`'s default-deny, verified by e2e
(§7).

### Response shape

`PosMenuService.getMenu` (`src/modules/catalogue/pos-menu/pos-menu.service.ts`)
composes, in order:

1. `MenusService.resolveForBranch` — active menus assigned to the branch,
   priority order, ambiguity flag/warning surfaced verbatim.
2. Categories on those menus, and menu-item placements into them (active
   items only).
3. Active variants per item.
4. Modifier groups/modifiers linked to each item (full option data POS
   needs to render the same choice UI Sales validates against).
5. `AvailabilityService.resolveBlocked` — batched 86 check; an item-level
   86 blocks the item AND every one of its variants (the same `OR`
   semantics `assertAvailable` evaluates per line at capture time — this
   was caught and fixed mid-implementation by the e2e test in §7, see
   `pos-menu.service.ts` variant-mapping comment).
6. `PriceResolutionService.resolve`, once per variant, at the caller's
   branch and an optional `orderType` query parameter (opaque string,
   validated the same way `CreatePriceListDto.orderType` already is — no
   Sales dependency created, matching `Menu.orderTypes`' own documented
   precedent).

```
POS_MENU_RESPONSE_SHAPE:
{
  branchId, orderType,
  menus: [{ id, name, orderTypes, priority, isActive, ... }],
  categories: [{ id, menuId, parentCategoryId, name, sortOrder, colour, itemIds }],
  items: [{
    id, names, description, allergens, dietaryTags, sortOrder, colour,
    barcodePlu, isOpenPrice, isWeighed, isAvailable,
    variants: [{ id, name, barcode, sortOrder, isAvailable,
                 price: { amountMinorUnits, currency } | null, priceAmbiguous }],
    modifierGroups: [{ id, name, minSelections, maxSelections, isRequired,
                        allowRepeat, freeQuantityThreshold,
                        modifiers: [{ id, name, kind, priceDelta, isDefault, sortOrder }] }]
  }],
  ambiguousMenuPriority, warning?
}
```

Deliberately **absent**: `kitchenNames`, `aggregatorNames`, `taxClassId`,
`revenueAccountCode`, `isCombo`, `isActive`/`createdAt` (redundant — only
active rows are ever returned), inventory cost/stock data. `barcodePlu` and
variant `barcode` are kept — legitimate POS scan-to-add use, not
back-office metadata.

---

## 5. SECURITY MODEL — VERIFIED, NOT ASSUMED

- **Tenant admin / branch admin / catalogue mutations / role-permission
  management:** unreachable — none of those routes carry
  `@AllowPosSession`; unchanged by this task.
- **Arbitrary other branches:** unreachable — the new route takes **no**
  `branchId` parameter of any kind (path, query or body); the branch comes
  only from `TenantContext.branchId`, populated exclusively from the live
  terminal binding for `pos` sessions (`TenantContext` docblock, ADR 0009
  D-07). A defensive `ForbiddenException` guard in the handler covers the
  (unreachable in practice) case where `c.branchId` is undefined — kept
  typed rather than a non-null assertion, mirroring the existing
  `requireTerminal`/`requirePosIdentity` pattern in `OrdersController`.
- **Dashboard (non-POS) callers:** explicitly refused even holding the
  identical permission grant — `posTerminalBranchTarget()`'s resolver
  denies when `auth.context.branchId` is undefined, which is true for every
  non-`pos` session by construction. Proven by e2e (§7).

---

## 6. REASON CODE READ — DECISION: **NOT CHANGED**

Inspected `GET /inventory/reason-codes`
(`src/modules/inventory/inventory.controller.ts`): tenant-wide,
`@RequirePermission(INVENTORY_PERMISSIONS.VIEW)` (`inventory.view`), no
`@AllowPosSession`.

```
REASON_CODE_READ_DECISION: DEFERRED — the "same safe read-contract
pattern" does NOT cleanly apply, and closing it would require a choice this
task's own constraints forbid making unilaterally.
```

Reasoning:

- Unlike menu read, **Cashier holds no Inventory permission at all**
  (`CASHIER_PERMISSION_CODES` has zero `INVENTORY_PERMISSIONS.*` entries —
  only `Branch Manager` gets `inventory.view`/`inventory.adjust`). Simply
  adding `@AllowPosSession()` to `GET /inventory/reason-codes` would still
  403 a Cashier — the permission gate, not the POS-session gate, is the
  blocker here.
- Granting `inventory.view` to Cashier to close that gap would hand every
  POS/PIN session the ability to see stock levels the moment ANY future
  route on Inventory gains `@AllowPosSession` — a broader authorization
  change than "read reason codes," and explicitly what the brief prohibits
  ("Do not invent a broad permission").
- All ten Inventory permission codes are SRS-attested verbatim (`inventory.permissions.ts`
  docblock: "ALL TEN are attested verbatim by SRS §15.2"); there is no
  narrower "reason-code read" permission code already defined to reuse, and
  minting a new one is a permission-catalog change beyond this task's named
  scope (menu loading, with reason codes explicitly "secondary... close it
  if the same safe read-contract pattern applies").

Net effect: POS Refund/Void reason-code selection remains closed via this
route today. This is an existing, unmodified condition — not a regression
introduced by this task — and is called out here rather than silently
left unaddressed, per the reporting policy's per-requirement disclosure
expectation. A future task should decide, with explicit sign-off, between
(a) a narrow new Sales- or POS-scoped reason-code read permission, or (b) a
CASE-B-shaped `GET /catalogue/pos-menu`-style dedicated narrow endpoint
under Sales that exposes only reason codes relevant to POS operations
(void/refund/discount categories), gated by permissions Cashier already
holds (e.g. `pos.order.void_line_prefire`, `pos.refund.issue`).

---

## 7. TESTS — RUN LIVE THIS SESSION

New file: `test/pos-menu.e2e-spec.ts` (7 tests, all passing), built on the
same tenant/branch/terminal/PIN-session fixture pattern `test/sales.e2e-spec.ts`
already uses, with real catalogue fixtures (menu → branch assignment →
category → item → variant → branch-scoped price list/entry → modifier
group/modifier → an item-level 86 rule → a second branch's own item):

1. `a Cashier POS session reads its own branch menu -> 200 with real
   configured data` — asserts the exact configured price (`4500` minor
   units / `EGP`, resolved through the real `PriceResolutionService`), the
   linked modifier group/modifier, and the category → item id membership.
2. `a manually 86'd item is still returned, but isAvailable: false` —
   asserts BOTH the item and (after the mid-implementation fix in §4 item
   5) its variant report `isAvailable: false`.
3. `never returns another branch's items, even within the same tenant`.
4. `a dashboard (non-POS) session with the SAME permissions is refused ->
   403`.
5. `the POS session still cannot reach the tenant-wide admin catalogue
   reads -> 403` (`GET /catalogue/items`, `GET /catalogue/availability-rules`).
6. `the POS session cannot mutate the catalogue -> 403` (`POST
   /catalogue/items`, `POST /catalogue/availability-rules`).
7. `an unauthenticated caller is refused -> 401`.

### Targeted suites run this session (live Postgres, `localhost:5566`)

| Suite | Result |
|---|---|
| `test/pos-menu.e2e-spec.ts` (new) | **7/7 passed** |
| `test/sales.e2e-spec.ts` | 179/179 passed *(combined total for the 7-suite run below; see next row)* |
| `test/sales.e2e-spec.ts`, `sales-lines.e2e-spec.ts`, `sales-fire.e2e-spec.ts`, `pos-session-refresh-employee-identity.e2e-spec.ts`, `scoped-rbac.e2e-spec.ts`, `catalogue-rls.e2e-spec.ts` (run together) | **179/179 passed**, 7/7 suites |
| `test/openapi.e2e-spec.ts` | **49/49 passed** (after `npm run openapi:generate`) |
| `src/modules/module-boundaries.spec.ts` | **28/28 passed** (unchanged; `sales->catalogue` deviation list unchanged — no new cross-module import added) |
| `src/modules/authorization-coverage.spec.ts` | **27/27 passed** (new route declares an explicit `posTerminalBranch` target — no allowlist entry needed) |
| `src/modules/catalogue/**/*.spec.ts` (unit) + `canonical-role-templates.spec.ts` | **122/122 passed** |
| `test/catalogue.e2e-spec.ts` (full file) | 81/82 passed — **1 failure, confirmed PRE-EXISTING and unrelated**: `boundary compliance › no Fiscal / Sales / Procurement tables were created` fails because `workforce.*` tables (added by an unrelated, already-merged Workforce slice) are not in that test's hardcoded expected table list. Reproduced identically on a clean `git stash` of this task's changes (baseline HEAD `12593c8`), confirming it predates this task. Not touched, not silenced. |

`tsc --noEmit`: clean. `npm run build` (`nest build`): clean, twice (before
and after the item→variant 86-inheritance fix in §4).

---

## OPENAPI

Regenerated (`npm run openapi:generate`) after the route/DTO/schema
changes — `docs/api/openapi.json`/`.yaml` now include `GET
/catalogue/pos-menu` and its full response schema. `test/openapi.e2e-spec.ts`
(49 structural/drift checks) passes against the regenerated artifacts.

---

## FILES_CHANGED

```
 docs/api/openapi.json                                          | regenerated (additive)
 docs/api/openapi.yaml                                          | regenerated (additive)
 src/modules/catalogue/availability/availability.service.ts     | +52  (new AvailabilityService.resolveBlocked)
 src/modules/catalogue/catalogue.controller.ts                  | +174 (new GET /catalogue/pos-menu route + OpenAPI schemas)
 src/modules/catalogue/catalogue.dto.ts                         | +13  (new PosMenuQueryDto)
 src/modules/catalogue/catalogue.module.ts                      | +2   (register PosMenuService)
 src/modules/catalogue/pos-menu/pos-menu.service.ts              | new  (PosMenuService — composes existing catalogue services)
 test/pos-menu.e2e-spec.ts                                      | new  (7 e2e tests)
 docs/reports/claude/2026-09-08_DEMO-POS-MENU-BACKEND-P0_pos-catalogue-read-contract.md | new (this report)
 docs/reports/claude/INDEX.md                                   | appended (this entry)
```

No file outside `kitchen-kit/backend` was touched. No migration was added
(no schema change — the new endpoint reads existing tables only).

---

## TYPECHECK / BUILD

`npx tsc --noEmit -p tsconfig.json` — clean (ran twice, before and after
the §4 item-5 fix).
`npm run build` (`nest build`) — clean (ran twice, same points).
`npx eslint` on every changed file — clean (two pre-existing-style
formatting/lint issues in the new test file were fixed: an unused fixture
variable was put to use strengthening the 86-inheritance assertion, and
Prettier auto-fixed quote-escaping).

---

## BACKEND_COMMIT

Not yet created at the time this report file was written — committed as
the next step per this task's instruction ("Commit backend only. Do not
push."). This report and the INDEX.md entry are included in that commit.

---

## FRONTEND_CHANGE_REQUIRED_AFTER

Yes. The frontend must switch its POS menu-loading call from
`GET /catalogue/items` + `GET /catalogue/availability-rules` (which will
continue to 403 for a POS/PIN session, unchanged and correctly so) to the
new `GET /catalogue/pos-menu` — no `branchId` parameter to supply (it is
derived from the session), optional `?orderType=` query parameter. The
response shape is documented in §4 above and in the regenerated OpenAPI
document (`operationId` under `CatalogueController_getPosMenu` /
`GET /catalogue/pos-menu` in `docs/api/openapi.json`). This is a pure
additive contract change — nothing existing was removed or renamed, so no
other frontend caller is affected.

---

## SAFE_TO_DEPLOY

Yes, for the backend change in isolation:

- No existing route's guard, permission, or target changed.
- No permission was added to any canonical role template.
- The one new route is additive, narrow, branch-derived-only, and covered
  by both the mechanical `authorization-coverage.spec.ts` gate and live
  e2e proof that it cannot reach admin data, cannot be used by a
  non-POS session, cannot mutate anything, and cannot cross branches.
- The reason-code gap (§6) is explicitly left open, not silently
  papered over — POS Refund/Void reason-code selection is unchanged from
  its pre-task state and requires a separate, deliberate follow-up.
