# B1-3 — Route-Wide Scoped Authorization Enforcement

| Field | Value |
|---|---|
| **Task / Slice** | `B1-3` — ROUTE-WIDE SCOPED AUTHORIZATION ENFORCEMENT (P2-SEC, lane B) |
| **Report type** | IMPLEMENTATION + SECURITY REVIEW + TESTS |
| **Authority** | **This report is NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative — specifically `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC` (RATIFIED 2026-09-02). `docs/adr/0009-scoped-rbac.md` records architecture, not authority. Where this report and the register differ, **the register wins.** This report ratifies nothing and approves nothing. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `428c90439b598be227d8a4f2545a0cb2cc166b2f` (`feat(security): implement scoped role assignments`) |
| **Branch** | `full-srs/lane-b-security-platform` |
| **Working tree at start** | Clean |
| **Task identifier** | `P2-SEC / B1-3` |
| **Push / deploy / merge** | **NONE.** No push, no merge, no rebase, no deploy, no destructive git operation. |

---

## 1. Status

**COMPLETE for the enforcement, coverage-gate, matrix, mask-retirement and
security-review scope of the brief**, with **one security-review FINDING raised
and NOT silently fixed** (§14, F-1: the measured worst-allowed token is
**15,037 bytes**, not the "~6 KB" B1-2 estimated).

`FR-SEC-004` and `FR-API-012` are proposed **COMPLETE**; `FR-SEC-028` remains
**PARTIAL**; `FR-PLT-013` remains **PARTIAL and is NOT claimed** — this branch
contains no CI pipeline and none was invented. See §16.

---

## 2. Starting State, Verified Before Any Edit

Worktree `/Users/mac/projects/ros-worktrees/lane-b`, branch
`full-srs/lane-b-security-platform`, HEAD
`428c90439b598be227d8a4f2545a0cb2cc166b2f`, subject
`feat(security): implement scoped role assignments`, working tree clean.

**Environment note.** The worktree had no generated Prisma client; `prisma
generate` was run. `.env` was re-pointed at a **new disposable Lane-B database**
(`ros_lane_b_b13_zero`) and is gitignored — it does not appear in the diff. See
§21 for database safety.

---

## 3. What Was Read First

- `docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-governance-gate.md`
- `docs/reports/claude/full-srs-4day/2026-09-02_B1-1_branch-rbac-ratification.md`
- `docs/reports/claude/full-srs-4day/2026-09-02_B1-2_branch-scoped-rbac-foundation.md`
- `docs/adr/0008-organisation-foundation.md`, `docs/adr/0009-scoped-rbac.md`
- Every controller in `src/`, and the Prisma schema for every model an operation
  can address (`Order`, `CashSession`, `Ticket`, `Station`, `BranchTable`,
  `Terminal`, `Location`, `Warehouse`, `CentralKitchen`, `PriceList`,
  `AvailabilityRule`, `Recipe`, `CountSession`, `CountLine`, `DayClose`,
  `CashClosePolicy`).

`:branchId` routes were **not** assumed to be the surface. They are 21 of 141
protected operations — **15 %**. The other 85 % is where the work was.

---

## 4. The B1-2 Security Model Is Preserved

Nothing in §3 of the brief was weakened. Specifically, and each verified by a
test that still passes:

| Invariant | Preserved how |
|---|---|
| C-1 assignment model | `ScopeAuthorizationService` is the only grant evaluator; `EmployeeBranch`/`homeBranchId` appear nowhere in it. Matrix test *"EmployeeBranch alone grants NOTHING"*. |
| TENANT/BRAND/BRANCH lattice | `identity/authz/scope.ts` **unchanged** (zero diff). |
| `BRANCH_GROUP` deferred | Not implemented. No enum value, no scope type. |
| Target resolved server-side | Every target comes from a route parameter resolved tenant-safely, a body field resolved tenant-safely, live terminal state, or the resource row. §6. |
| Claims non-authoritative | `scp`/`pbr` are still never read to grant, still never copied onto the principal. |
| T-4-LIVE live resolution | `TenantContextService` unchanged; every request still re-resolves. |
| Authorization epoch | Unchanged. Matrix case 10 proves a stale token dies on the next request. |
| Symbolic bounded permitted-branch set | Unchanged. Measured in §14 F-1. |
| Transitional targetless guard = TENANT target | Still present in `PermissionGuard`, now **allowlisted rather than ambient** (§7). |
| POS `EmployeeBranch` AND-only narrowing | `posNarrowingAllows` unchanged. Matrix cases 12–13. |
| Tenant RLS stays tenant-only | **No RLS policy was touched.** No branch predicate, no `app.branch_id`. |
| No new permission code | **Zero.** `git diff` touches no `*.permissions.ts` catalogue entry and no `permissions.constants.ts`. |

---

## 5. The Enforcement Design

### 5.1 One declaration, one enforcement point

A protected route now declares **what** it needs (`@RequirePermission`) and
**where** it acts (`@AuthorizationTarget`). Both are read by
**`PermissionGuard`**, which calls `ScopeAuthorizationService` — the B1-2
primitive, unchanged — with `permission AND target scope`.

**A second guard was deliberately NOT added.** A `ScopeTargetGuard` would have to
be listed in every controller's `@UseGuards(...)`, and a route that declared a
target but forgot the guard would silently fall back to the weaker tenant-only
check — a hole that looks exactly like correct code at the call site. Folding the
decision into the guard that is *already on every protected route* removes that
failure mode entirely: there is nothing extra to remember, and nothing to forget.

### 5.2 The declaration lives in `identity/contract/`

`AuthorizationTarget`, the spec builders, `ScopeTargetResolver` and the
`SCOPE_AUTHORIZATION` port are published from `src/modules/identity/contract/`.
Every HTTP module must use them, so they are genuinely a published contract —
and putting them there is what kept `module-boundaries.spec.ts`'s
**`KNOWN_DEVIATIONS` from growing by one entry per module.** It did not grow at
all (§18).

### 5.3 The target kinds

| Kind | Target derived from | Count |
|---|---|---|
| `tenant` | Declared, with a written reason. A genuinely tenant-owned resource. | 66 |
| `brand` | A brand id on the request, resolved tenant-safely. | 3 |
| `branch` | A branch id on the request, resolved tenant-safely. | 21 |
| `branchOrTenant` | A branch id when supplied; TENANT when the filter is omitted. | 3 |
| `sessionTerminalBranch` | The bound terminal's branch, read live and required `active`. | 2 |
| `declaredScope` | The scope the request asks to CREATE at (`price_lists.scope_type`, `recipes.scope`). | 2 |
| `resource` | **The addressed row's own owning scope.** | 42 |
| `resourceOrTenant` | The row's scope when named; TENANT when the filter is omitted. | 2 |
| *(no permission requirement)* | Auth-only; reviewed allowlist. | 15 |
| **Total** | | **156** |

`posTerminalBranch` exists in the contract and is used by none of the current
routes — `sessionTerminalBranch` subsumes it correctly for every POS route the
repository has, because the routes that require a terminal (`POST /orders`,
`POST /cash-sessions`) accept a terminal-bound session that is not a PIN-issued
`pos` session, and `TenantContext.branchId` is populated for `pos` only.

---

## 6. Explicit Target Enforcement — how each shape is made safe

**A. Route has `:branchId`.** The id is checked to be UUID-shaped, then resolved
inside the caller's RLS context through Organisation's published
`BRANCH_BRAND_QUERY`. Visible ⇒ a `BRANCH` target carrying its parent brand (so
the primitive never makes a second round trip). Invisible ⇒ **defer** (§7.3).

**B. Body contains `branchId`.** Identical treatment. The body value selects a
resource; it never asserts one. Every body-sourced target route was checked to
have a **mandatory, UUID-validated** field (`CreateBranchDto.brandId`,
`AssignBranchDto.branchId`, `RegisterTerminalDto.branchId`, the four Inventory
location fields), so omission cannot bypass: an **absent** declared target is
`deny`, not a fallback.

**C. Route references an order / cash session / ticket / count session / count
line / station / table / terminal / warehouse / location / price list /
availability rule / recipe id.** The row is loaded tenant-safely and its **real**
owning scope is used. Nine resolvers, each published by the module that OWNS the
resource and obtained by token, so no route reaches into another module's private
directory:

| Token | Owning module | Derives |
|---|---|---|
| `SALES_ORDER_TARGET_RESOLVER` | sales | `orders.branch_id` (partition-safe, keyed by `(id, business_day)`) |
| `TREASURY_CASH_SESSION_TARGET_RESOLVER` | treasury | `cash_sessions.branch_id` |
| `KDS_TICKET_TARGET_RESOLVER` | kitchen | `tickets.branch_id` |
| `ORG_STATION_TARGET_RESOLVER` | organisation | `stations.branch_id` |
| `ORG_TABLE_TARGET_RESOLVER` | organisation | `branch_tables.branch_id` |
| `ORG_WAREHOUSE_TARGET_RESOLVER` | organisation | branch-owned ⇒ BRANCH; standalone ⇒ TENANT |
| `ORG_LOCATION_TARGET_RESOLVER` | organisation | branch ⇒ BRANCH; branch warehouse ⇒ BRANCH; standalone warehouse / central kitchen ⇒ TENANT |
| `INVENTORY_COUNT_SESSION_TARGET_RESOLVER` | inventory | session → location → Organisation |
| `INVENTORY_COUNT_LINE_TARGET_RESOLVER` | inventory | line → session → location → Organisation |
| `CATALOGUE_PRICE_LIST_TARGET_RESOLVER` | catalogue | `price_lists.scope_type` + `scope_id` |
| `CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER` | catalogue | `branch_id`; NULL = every branch ⇒ TENANT |
| `PRODUCTION_RECIPE_TARGET_RESOLVER` | production | `recipes.scope` + `brand_id`/`branch_id` |
| `IDENTITY_TERMINAL_TARGET_RESOLVER` | identity | `terminals.branch_id` |

**No resolver may widen.** Where an owning branch exists but cannot be read, the
answer is `null` (refused), never a TENANT target. A `brand`/`branch` price list
or recipe with a NULL scope id — impossible under the CHECK constraints — is
treated as **unscopeable**, not tenant-wide.

**Inventory's resolvers delegate the final location→scope step to Organisation's
published resolver** rather than re-deciding it. Two copies of "what is a
location?" would eventually disagree, and the copy that disagreed in the
permissive direction would be the hole.

**D. Brand resource** ⇒ `BRAND` target (`GET`/`PATCH /org/brands/:brandId`).

**E. True tenant-wide operation** ⇒ `TENANT` target, **declared with a reason**,
because an explicit tenant target and an undeclared one differ in exactly the way
that matters: the explicit one is reviewable.

**No duplicate `branchId` input was added anywhere** to make authorization
easier. Every resource-derived target reads a column that already existed.

---

## 7. No Existence Oracle — and the one deliberate rule that makes it hold

### 7.1 What the primitive does

Unchanged from B1-2: `ScopeAuthorizationService` resolves the target against
Organisation and refuses anything invisible in the acting tenant, with **no
distinction between "another tenant's" and "does not exist"**. That behaviour is
still directly tested (B1-2 group H, still green).

### 7.2 What the guard does, and the defect this caught

The first implementation sent branch/brand ids straight to the primitive. That
answered **403** for a cross-tenant branch — where the repository has always
answered a tenant-safe **404**. Thirteen existing tests failed, and they were
right to: `assertBranchInScope`, ADR 0008, and every route's own
`@ApiNotFoundResponse` all document one answer for "not visible", byte-identical
for foreign and absent.

**Answering 403 there would not have leaked anything on its own — but it would
have put a SECOND answer into the system for the same question, and the
difference between two layers' answers is exactly what an enumeration attack
reads.** So the guard now resolves visibility itself and, when the target is not
visible, **defers**: the route's own tenant-safe lookup answers, as it always
has. One question, one answer.

Proven in the matrix: a TENANT-wide actor of tenant A gets **byte-identical 404s**
for tenant B's branch and for a branch that never existed — on `/org/branches`,
on `/reports/...`, on `/org/brands`, and for an **order** row.

### 7.3 The `defer` rule, stated in full

The guard defers in exactly three situations, and no others:

1. the raw id is not the right **shape** to be an id (so the route's
   `ValidationPipe` returns the `400` it always returned — deciding `403` here
   would have converted every malformed-input 400 in the repository into a 403);
2. the target resource is **not visible** in the acting tenant (§7.2);
3. a `declaredScope` request names `brand`/`branch` with **no id**, which every
   such route rejects with its own `400` and which cannot create a row.

Each reason is recorded on the request (`authorizationTargetDeferred`) so a test
can assert the deferral happened *for the stated reason* rather than inferring it.

**Consequence, recorded rather than glossed over (finding F-2, §14):** a route
that does *not* 404 on an invisible target executes without a scope decision.
`GET /catalogue/branches/:branchId/menus` with an unknown branch returns
`200 []`. It discloses nothing — the underlying query is tenant-scoped, and the
answer for a foreign branch is identical to the answer for a non-existent one —
and it is **not a regression**: pre-B1-3 the tenant-permission check passed and
the same empty list was returned.

---

## 8. Authorization Coverage Gate

`src/modules/authorization-coverage.spec.ts` — **runs in the unit suite, no
database, no Nest container.**

It enumerates every route **from the filesystem** (`**/*.controller.ts`,
discovered by walking `src/`) and reads the same decorator metadata Nest reads at
runtime. A new controller, or a new route on an existing one, is covered the
moment it exists.

Assertions:

1. discovery is real (>120 routes across ≥15 files) — a tripwire against every
   other assertion passing vacuously;
2. route ids are unique;
3. **every permission-bearing route declares an explicit target**, unless
   allowlisted;
4. **every route with no permission requirement is on the reviewed auth-only
   allowlist**;
5. **no allowlist entry is stale** (so the list can shrink and cannot rot);
6. every allowlist entry states a reason of real length;
7. every declared target is structurally valid — a `tenant`/`authOnly`
   classification with a stub reason fails, which is what stops "tenant because
   it was easier";
8. the totals are printed as report evidence.

**Result: PASS.** 156 routes, 141 declared, **0 undeclared permission-bearing
routes**.

### The allowlists

| List | Size | Contents |
|---|---|---|
| `REVIEWED_TENANT_TARGET_ROUTES` | **0** | Deliberately empty. Every genuinely tenant-only route was converted to an explicit `tenantTarget(...)` instead. The mechanism is kept so the next slice adding one must write down why. |
| `REVIEWED_UNPROTECTED_ROUTES` | **15** | Routes with no `@RequirePermission` at all. |

The 15, by rationale category:

- **unauthenticated entry points (4)** — `POST /auth/login`, `POST /auth/pin`,
  `POST /auth/password/forgot`, `POST /auth/password/reset`. The credential *is*
  the authority.
- **the caller's own identity/session (7)** — `GET /auth/me`,
  `POST /auth/logout`, `POST /auth/refresh`, `GET /auth/permissions`,
  `POST /auth/password/change`, `GET /auth/tenant`, `GET /auth/terminal`.
  `GET /auth/permissions` is the sharpest: reading one's own effective authority
  cannot be gated on holding authority.
- **pre-tenant-context membership selection (2)** — `GET /auth/tenants`,
  `POST /auth/tenant`. There is no tenant context yet to scope against; the
  membership itself is the authority.
- **terminal binding (1)** — `POST /auth/terminal`. The terminal credential is
  the authority; `TenantContextService` then derives the operating branch live.
- **liveness (1)** — `GET /health`.

**No giant permanent wildcard.** Every entry names one route and one reason, and
assertion 5 deletes the possibility of a stale one surviving.

### What the gate does NOT prove

It proves **declaration**, not the correctness of a classification. That a route
says `tenantTarget(...)` is checked here; that TENANT is the *right* target for it
is review judgement — recorded in §9's inventory and exercised by the matrix.

**It is not CI.** This branch contains no GitHub pipeline; none was invented and
none is claimed. Integration can wire the passing suite in. **`FR-PLT-013` is NOT
claimed** (§16).

---

## 9. The Authorization Surface Inventory

**156 HTTP operations.** Classified by the **actual resource target**, never by
permission-code family (SRS Appendix C is absent; clause 20 forbids inventing a
classification).

| Classification | Count |
|---|---|
| TENANT | 66 |
| BRAND | 3 |
| BRANCH (route/body id, or live terminal branch) | 26 |
| RESOURCE-DERIVED (BRAND **or** BRANCH **or** TENANT, from the row) | 44 |
| DECLARED-SCOPE on create (tenant/brand/branch, chosen by the request) | 2 |
| NO BUSINESS TARGET / AUTH-ONLY | 15 |
| **Total** | **156** |

Per module: catalogue 38, organisation 31, identity 27, inventory 22,
production 12, treasury 10, sales 8, kitchen 6, reporting 1, health 1.

### Full inventory

| Module | Method + route | Permission | Target class | How the target is derived |
|---|---|---|---|---|
| catalogue | DELETE /catalogue/items/:itemId/placements/:categoryId | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | DELETE /catalogue/menus/:menuId/branches/:branchId | `menu.item.manage` | BRANCH | BRANCH from param `branchId` |
| catalogue | GET /catalogue/availability-rules | `menu.availability.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/branches/:branchId/menus | `menu.item.read` | BRANCH | BRANCH from param `branchId` |
| catalogue | GET /catalogue/completeness | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/items | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/items/:itemId | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/items/:itemId/placements | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/items/:itemId/variants | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/menus | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/menus/:menuId | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/menus/:menuId/branches | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/menus/:menuId/categories | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/modifier-groups | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/modifier-groups/:groupId/modifiers | `menu.item.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/price-lists | `menu.price.read` | TENANT | declared TENANT |
| catalogue | GET /catalogue/price-lists/:priceListId | `menu.price.read` | RESOURCE | resource → Symbol(CATALOGUE_PRICE_LIST_TARGET_RESOLVER) |
| catalogue | GET /catalogue/price-lists/:priceListId/entries | `menu.price.read` | RESOURCE | resource → Symbol(CATALOGUE_PRICE_LIST_TARGET_RESOLVER) |
| catalogue | PATCH /catalogue/categories/:categoryId | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | PATCH /catalogue/items/:itemId | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | PATCH /catalogue/menus/:menuId | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | PATCH /catalogue/modifier-groups/:groupId | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/availability-rules | `menu.availability.toggle` | BRANCHORTENANT | BRANCH from body `branchId`, else TENANT |
| catalogue | POST /catalogue/availability-rules/:ruleId/86 | `menu.availability.toggle` | RESOURCE | resource → Symbol(CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER) |
| catalogue | POST /catalogue/items | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/items/:itemId/modifier-groups | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/items/:itemId/placements | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/items/:itemId/status | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/items/:itemId/variants | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/menus | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/menus/:menuId/branches | `menu.item.manage` | BRANCH | BRANCH from body `branchId` |
| catalogue | POST /catalogue/menus/:menuId/categories | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/menus/:menuId/status | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/modifier-groups | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/modifier-groups/:groupId/modifiers | `menu.item.manage` | TENANT | declared TENANT |
| catalogue | POST /catalogue/price-lists | `menu.price.change` | DECLAREDSCOPE | declaredScope |
| catalogue | POST /catalogue/price-lists/:priceListId/entries | `menu.price.change` | RESOURCE | resource → Symbol(CATALOGUE_PRICE_LIST_TARGET_RESOLVER) |
| catalogue | POST /catalogue/variants/:variantId/status | `menu.item.manage` | TENANT | declared TENANT |
| health.controller.ts | GET /health | — | NONE (auth-only) | — |
| identity | DELETE /auth/memberships/:membershipId/roles/:roleId | `identity.role.assign` | TENANT | declared TENANT |
| identity | DELETE /auth/role-assignments/:assignmentId | `identity.role.assign` | TENANT | declared TENANT |
| identity | GET /auth/me | — | NONE (auth-only) | — |
| identity | GET /auth/memberships/:membershipId/roles | `identity.role.read` | TENANT | declared TENANT |
| identity | GET /auth/permissions | — | NONE (auth-only) | — |
| identity | GET /auth/roles | `identity.role.read` | TENANT | declared TENANT |
| identity | GET /auth/tenant | — | NONE (auth-only) | — |
| identity | GET /auth/tenants | — | NONE (auth-only) | — |
| identity | GET /auth/terminal | — | NONE (auth-only) | — |
| identity | GET /auth/terminals | `identity.terminal.read` | TENANT | declared TENANT |
| identity | PATCH /auth/role-assignments/:assignmentId | `identity.role.assign` | TENANT | declared TENANT |
| identity | POST /auth/login | — | NONE (auth-only) | — |
| identity | POST /auth/logout | — | NONE (auth-only) | — |
| identity | POST /auth/memberships/:membershipId/roles | `identity.role.assign` | TENANT | declared TENANT |
| identity | POST /auth/password/change | — | NONE (auth-only) | — |
| identity | POST /auth/password/forgot | — | NONE (auth-only) | — |
| identity | POST /auth/password/reset | — | NONE (auth-only) | — |
| identity | POST /auth/pin | — | NONE (auth-only) | — |
| identity | POST /auth/refresh | — | NONE (auth-only) | — |
| identity | POST /auth/role-assignments/:assignmentId/review | `identity.role.assign` | TENANT | declared TENANT |
| identity | POST /auth/roles | `identity.role.create` | TENANT | declared TENANT |
| identity | POST /auth/roles/:roleId/permissions | `identity.role.update` | TENANT | declared TENANT |
| identity | POST /auth/tenant | — | NONE (auth-only) | — |
| identity | POST /auth/terminal | — | NONE (auth-only) | — |
| identity | POST /auth/terminals | `identity.terminal.manage` | BRANCH | BRANCH from body `branchId` |
| identity | POST /auth/terminals/:terminalId/fingerprints | `identity.terminal.manage` | RESOURCE | resource → Symbol(IDENTITY_TERMINAL_TARGET_RESOLVER) |
| identity | POST /auth/terminals/:terminalId/status | `identity.terminal.manage` | RESOURCE | resource → Symbol(IDENTITY_TERMINAL_TARGET_RESOLVER) |
| inventory | GET /inventory/counts/:sessionId/lines | `inventory.count.perform` | RESOURCE | resource → Symbol(INVENTORY_COUNT_SESSION_TARGET_RESOLVER) |
| inventory | GET /inventory/expiring | `inventory.view` | TENANT | declared TENANT |
| inventory | GET /inventory/items | `inventory.view` | TENANT | declared TENANT |
| inventory | GET /inventory/items/:itemId | `inventory.view` | TENANT | declared TENANT |
| inventory | GET /inventory/items/:itemId/movements | `inventory.cost.view` | RESOURCEORTENANT | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER), else TENANT |
| inventory | GET /inventory/levels | `inventory.view` | RESOURCEORTENANT | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER), else TENANT |
| inventory | GET /inventory/low-stock | `inventory.view` | TENANT | declared TENANT |
| inventory | GET /inventory/negative-stock | `inventory.view` | TENANT | declared TENANT |
| inventory | GET /inventory/reason-codes | `inventory.view` | TENANT | declared TENANT |
| inventory | GET /inventory/reconciliation | `inventory.view` | TENANT | declared TENANT |
| inventory | GET /inventory/waste | `inventory.view` | TENANT | declared TENANT |
| inventory | POST /inventory/count-lines/:lineId | `inventory.count.perform` | RESOURCE | resource → Symbol(INVENTORY_COUNT_LINE_TARGET_RESOLVER) |
| inventory | POST /inventory/counts | `inventory.count.perform` | RESOURCE | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER) |
| inventory | POST /inventory/counts/:sessionId/post | `inventory.count.post` | RESOURCE | resource → Symbol(INVENTORY_COUNT_SESSION_TARGET_RESOLVER) |
| inventory | POST /inventory/items | `inventory.adjust` | TENANT | declared TENANT |
| inventory | POST /inventory/items/:itemId/base-unit | `inventory.adjust` | TENANT | declared TENANT |
| inventory | POST /inventory/items/:itemId/reorder-config | `inventory.adjust` | RESOURCE | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER) |
| inventory | POST /inventory/movements | `inventory.adjust` | RESOURCE | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER) |
| inventory | POST /inventory/reason-codes | `inventory.adjust` | TENANT | declared TENANT |
| inventory | POST /inventory/transfers | `inventory.transfer.create` | RESOURCE | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER) |
| inventory | POST /inventory/transfers/receive | `inventory.transfer.receive` | RESOURCE | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER) |
| inventory | POST /inventory/waste | `inventory.waste.record` | RESOURCE | resource → Symbol(ORG_LOCATION_TARGET_RESOLVER) |
| kitchen | GET /kds/stations/:stationId/queue | `kds.operate` | RESOURCE | resource → Symbol(ORG_STATION_TARGET_RESOLVER) |
| kitchen | POST /kds/stations/:stationId/tickets/view | `kds.operate` | RESOURCE | resource → Symbol(ORG_STATION_TARGET_RESOLVER) |
| kitchen | POST /kds/tickets/:ticketId/bump-all | `kds.operate` | RESOURCE | resource → Symbol(KDS_TICKET_TARGET_RESOLVER) |
| kitchen | POST /kds/tickets/:ticketId/lines/:lineId/bump | `kds.operate` | RESOURCE | resource → Symbol(KDS_TICKET_TARGET_RESOLVER) |
| kitchen | POST /kds/tickets/:ticketId/lines/:lineId/start | `kds.operate` | RESOURCE | resource → Symbol(KDS_TICKET_TARGET_RESOLVER) |
| kitchen | POST /kds/tickets/:ticketId/recall | `kds.operate` | RESOURCE | resource → Symbol(KDS_TICKET_TARGET_RESOLVER) |
| organisation | GET /org/branches | `settings.branch.read` | TENANT | declared TENANT |
| organisation | GET /org/branches/:branchId | `settings.branch.read` | BRANCH | BRANCH from param `branchId` |
| organisation | GET /org/branches/:branchId/operating-hours | `settings.branch.read` | BRANCH | BRANCH from param `branchId` |
| organisation | GET /org/branches/:branchId/print-routing | `settings.branch.read` | BRANCH | BRANCH from param `branchId` |
| organisation | GET /org/branches/:branchId/station-routing-rules | `settings.branch.read` | BRANCH | BRANCH from param `branchId` |
| organisation | GET /org/branches/:branchId/stations | `settings.branch.read` | BRANCH | BRANCH from param `branchId` |
| organisation | GET /org/branches/:branchId/tables | `settings.branch.read` | BRANCH | BRANCH from param `branchId` |
| organisation | GET /org/brands | `settings.tenant.read` | TENANT | declared TENANT |
| organisation | GET /org/brands/:brandId | `settings.tenant.read` | BRAND | BRAND from param `brandId` |
| organisation | GET /org/central-kitchens | `settings.tenant.read` | TENANT | declared TENANT |
| organisation | GET /org/central-kitchens/:centralKitchenId | `settings.tenant.read` | TENANT | declared TENANT |
| organisation | GET /org/stations/:stationId | `settings.branch.read` | RESOURCE | resource → Symbol(ORG_STATION_TARGET_RESOLVER) |
| organisation | GET /org/warehouses | `settings.tenant.read` | TENANT | declared TENANT |
| organisation | GET /org/warehouses/:warehouseId | `settings.tenant.read` | RESOURCE | resource → Symbol(ORG_WAREHOUSE_TARGET_RESOLVER) |
| organisation | PATCH /org/branches/:branchId | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| organisation | PATCH /org/brands/:brandId | `settings.tenant.manage` | BRAND | BRAND from param `brandId` |
| organisation | PATCH /org/central-kitchens/:centralKitchenId | `settings.tenant.manage` | TENANT | declared TENANT |
| organisation | PATCH /org/stations/:stationId | `settings.branch.manage` | RESOURCE | resource → Symbol(ORG_STATION_TARGET_RESOLVER) |
| organisation | PATCH /org/tables/:tableId | `settings.branch.manage` | RESOURCE | resource → Symbol(ORG_TABLE_TARGET_RESOLVER) |
| organisation | PATCH /org/warehouses/:warehouseId | `settings.tenant.manage` | RESOURCE | resource → Symbol(ORG_WAREHOUSE_TARGET_RESOLVER) |
| organisation | POST /org/branches | `settings.branch.manage` | BRAND | BRAND from body `brandId` |
| organisation | POST /org/branches/:branchId/brand | `settings.tenant.manage` | TENANT | declared TENANT |
| organisation | POST /org/branches/:branchId/operating-hours | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| organisation | POST /org/branches/:branchId/print-routing | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| organisation | POST /org/branches/:branchId/station-routing-rules | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| organisation | POST /org/branches/:branchId/stations | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| organisation | POST /org/branches/:branchId/status | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| organisation | POST /org/branches/:branchId/tables | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| organisation | POST /org/brands | `settings.tenant.manage` | TENANT | declared TENANT |
| organisation | POST /org/central-kitchens | `settings.tenant.manage` | TENANT | declared TENANT |
| organisation | POST /org/warehouses | `settings.tenant.manage` | TENANT | declared TENANT |
| production | GET /modifiers/:modifierId/recipe-effects | `recipe.view` | TENANT | declared TENANT |
| production | GET /recipes | `recipe.view` | TENANT | declared TENANT |
| production | GET /recipes/:recipeId/versions | `recipe.view` | RESOURCE | resource → Symbol(PRODUCTION_RECIPE_TARGET_RESOLVER) |
| production | GET /recipes/requiring-completion | `recipe.view` | BRANCHORTENANT | BRANCH from query `branchId`, else TENANT |
| production | GET /substitute-groups | `recipe.view` | TENANT | declared TENANT |
| production | POST /recipes | `recipe.edit` | DECLAREDSCOPE | declaredScope |
| production | POST /recipes/:recipeId/versions | `recipe.edit` | RESOURCE | resource → Symbol(PRODUCTION_RECIPE_TARGET_RESOLVER) |
| production | POST /recipes/:recipeId/versions/:version/publish | `recipe.publish` | RESOURCE | resource → Symbol(PRODUCTION_RECIPE_TARGET_RESOLVER) |
| production | POST /substitute-groups | `recipe.edit` | TENANT | declared TENANT |
| production | POST /substitute-groups/:groupId/members | `recipe.edit` | TENANT | declared TENANT |
| production | PUT /modifiers/:modifierId/recipe-effects | `recipe.edit` | TENANT | declared TENANT |
| production | PUT /recipes/:recipeId/versions/:version/lines | `recipe.edit` | RESOURCE | resource → Symbol(PRODUCTION_RECIPE_TARGET_RESOLVER) |
| reporting | GET /reports/branches/:branchId/daily-trading/:businessDay | `report.view.sales`, `report.view.financial` | BRANCH | BRANCH from param `branchId` |
| sales | DELETE /orders/:businessDay/:id/lines/:lineId | `pos.order.void_line_prefire` | RESOURCE | resource → Symbol(SALES_ORDER_TARGET_RESOLVER) |
| sales | GET /orders | `pos.order.create` | BRANCHORTENANT | BRANCH from query `branchId`, else TENANT |
| sales | GET /orders/:businessDay/:id | `pos.order.create` | RESOURCE | resource → Symbol(SALES_ORDER_TARGET_RESOLVER) |
| sales | GET /orders/:businessDay/:id/receipt | `pos.order.create` | RESOURCE | resource → Symbol(SALES_ORDER_TARGET_RESOLVER) |
| sales | POST /orders | `pos.order.create` | SESSIONTERMINALBRANCH | session terminal branch (live) |
| sales | POST /orders/:businessDay/:id/fire | `pos.order.fire` | RESOURCE | resource → Symbol(SALES_ORDER_TARGET_RESOLVER) |
| sales | POST /orders/:businessDay/:id/lines | `pos.order.create` | RESOURCE | resource → Symbol(SALES_ORDER_TARGET_RESOLVER) |
| sales | POST /orders/:businessDay/:id/payments | `pos.payment.capture` | RESOURCE | resource → Symbol(SALES_ORDER_TARGET_RESOLVER) |
| treasury | GET /branches/:branchId/day-closes/:businessDay | `report.view.financial` | BRANCH | BRANCH from param `branchId` |
| treasury | GET /cash-sessions/:sessionId/close-context | `cash.session.close`, `cash.session.close_other` (ANY) | RESOURCE | resource → Symbol(TREASURY_CASH_SESSION_TARGET_RESOLVER) |
| treasury | POST /branches/:branchId/cash-close-policy | `settings.branch.manage` | BRANCH | BRANCH from param `branchId` |
| treasury | POST /branches/:branchId/day-closes/:businessDay | `cash.day.close` | BRANCH | BRANCH from param `branchId` |
| treasury | POST /cash-sessions | `cash.session.open` | SESSIONTERMINALBRANCH | session terminal branch (live) |
| treasury | POST /cash-sessions/:sessionId/close | `cash.session.close`, `cash.session.close_other` (ANY) | RESOURCE | resource → Symbol(TREASURY_CASH_SESSION_TARGET_RESOLVER) |
| treasury | POST /cash-sessions/:sessionId/close/finalize | `cash.session.close`, `cash.session.close_other` (ANY) | RESOURCE | resource → Symbol(TREASURY_CASH_SESSION_TARGET_RESOLVER) |
| treasury | POST /cash-sessions/:sessionId/pay-in | `cash.payin` | RESOURCE | resource → Symbol(TREASURY_CASH_SESSION_TARGET_RESOLVER) |
| treasury | POST /cash-sessions/:sessionId/pay-out | `cash.payout` | RESOURCE | resource → Symbol(TREASURY_CASH_SESSION_TARGET_RESOLVER) |
| treasury | POST /cash-sessions/:sessionId/safe-drop | `cash.safedrop` | RESOURCE | resource → Symbol(TREASURY_CASH_SESSION_TARGET_RESOLVER) |

### Classification decisions worth stating explicitly

Three calls could reasonably have gone the other way, and each **widens or
withholds authority**, so each is recorded rather than left to the diff:

1. **`POST /org/branches` is BRAND-targeted (from the body's `brandId`), not
   TENANT.** Creating a branch under brand X is an act on brand X, and the
   lattice says a BRAND-X admin may do it. This **widens** relative to B1-2,
   where only a tenant-scoped actor could. It is the lattice applied honestly;
   if governance wants branch creation to stay tenant-only, this is the one line
   to change.
2. **`POST /org/branches/:branchId/brand` stays TENANT.** Re-parenting *moves* a
   branch between brands. A BRAND-scoped actor must not be able to move a branch
   into or out of its own brand, so the target is the only scope that
   legitimately spans both.
3. **All RBAC administration stays TENANT** (`POST /auth/memberships/:id/roles`
   and siblings). Making assignment branch-targetable would let a branch-scoped
   actor mint branch-scoped grants — self-elevation by construction.

Two more, for the record: **menu/catalogue master data is TENANT** (those tables
carry no branch column; applicability to a branch is the *separate*
menu-branch assignment, which is branch-targeted in its own right), and **stock
item master data is TENANT** (one SKU is shared by every location that stocks
it, while every movement against it is location-derived).

---

## 10. Cross-Branch Security Matrix

`test/scoped-authorization-matrix.e2e-spec.ts` — real HTTP, real PostgreSQL,
through the RLS-constrained `ros_app` role. **23 tests, all passing.**

Fixture: **one tenant** — brand X (branches X1, X2), brand Y (branch Y1) — plus a
second tenant with branch B1. Using one tenant for the scope cases is deliberate:
every refusal below is a genuine **same-tenant scope refusal**, not tenant
isolation doing the work.

Every case drives **real business modules** (Organisation, Reporting,
Treasury/DayClose, Sales, Catalogue), not Identity's test controller.

| # | Brief case | Route(s) exercised | Result |
|---|---|---|---|
| 1 | TENANT → Branch A **and** Branch B allowed | `GET /org/branches/:id`, `GET /reports/branches/:id/...` | **PASS** |
| 2 | BRAND X → branches of brand X allowed | `GET /org/branches/:id`, reporting | **PASS** |
| 3 | BRAND X → brand Y's branch denied | branch + report + `GET /org/brands/:id` | **PASS** (403) |
| 4 | BRANCH A → Branch A allowed | branch + report | **PASS** |
| 5 | BRANCH A → **sibling** Branch B denied | branch + report | **PASS** (403) |
| 6 | BRANCH → TENANT target denied | `GET /org/brands`, `/org/warehouses`, `/org/branches` | **PASS** (403), while its own branch still 200s |
| 7 | BRAND → TENANT target denied | `GET /org/brands`, `/org/branches` | **PASS** (403), while `GET /org/brands/:X` 200s |
| 8 | P at Branch A + Q at Branch B never combine | `GET`/`PATCH /org/branches/:id` | **PASS** — read-at-X1 + manage-at-X2: reading X2 **403**, managing X1 **403**, managing X2 **200** |
| 9 | Expired scoped assignment denies | branch read, expired on the DB clock | **PASS** |
| 10 | Stale token after re-scope denies | re-scope X1→X2 via the real admin API | **PASS** — the same unchanged token is refused on the next request |
| 11 | User with no Employee follows scoped RBAC | branch reads at Y1/X1 + tenant target | **PASS** |
| 12 | POS `EmployeeBranch` narrowing is AND-only | `GET /orders/:day/:id` | **PASS** — removing the HR row denies the next request although the role is still tenant-wide |
| 13 | Tenant-wide role on POS cannot cross terminal branch | `GET /orders/:day/:id` | **PASS** — X1 terminal reads X1's order, is refused X2's |
| 14 | Cross-tenant target denied with no oracle | branches, brands, reports, orders | **PASS** — byte-identical 404s for foreign vs non-existent, on four surfaces |

Case 8 is the sharpest form of `FR-SEC-004`'s non-leakage clause: if the union
were computed across scopes rather than *within each assignment's own scope*, the
actor would appear to hold read+manage and **both** refusals above would have
been 200s.

Plus, beyond the 14:

- **`EmployeeBranch` alone grants NOTHING** — branch Y1's POS employee is
  permitted at Y1 by `EmployeeBranch` and holds no role assignment: **403**.
  This is the test that fails first if the permitted-branch relation ever drifts
  into being a second, informal authorization source (ADR 0009 D-01's stated
  decay mode).
- **DayClose: a branch-scoped closer is refused at a sibling branch** (403).
- **Cash-close policy: a branch-scoped actor is refused at a sibling branch** (403).

---

## 11. Implicit / Resource-Derived Targets (§9 — the hard acceptance gate)

Operations where **the branch is not in the route** are 44 of 141 — the largest
single class. Representative flows proven end-to-end in the matrix:

| Flow | Proof |
|---|---|
| **Sales / Order** | Two orders, one per branch, addressed only by `(businessDay, id)`. A BRANCH-X1 actor reads X1's order (200) and is refused X2's (403). Nothing in either request names a branch. |
| **Sales collection read** | `GET /orders` unfiltered is a **TENANT** question and is refused for a single-branch actor — **not silently narrowed** to their own branch. `?branchId=X1` 200, `?branchId=X2` 403. |
| **Organisation / Station** | Stations carry **no `tenant_id`** — their tenant boundary is the parent branch. A station id alone says nothing until the row is read. X1's station 200, X2's station 403. |
| **Treasury / cash close policy** | `POST /branches/:branchId/cash-close-policy` at a sibling branch: 403. |
| **Treasury / day close** | Sibling branch: 403. The in-transaction re-check is scoped too (§12). |
| **Cross-tenant order** | Foreign order and non-existent order → **byte-identical 404**. |

Inventory, KDS and Catalogue resource-derived targets are wired identically
(§6 table) and are exercised by their own existing suites, which pass unchanged.

**Silently changing what a request means is itself a defect.** `branchOrTenant`
and `resourceOrTenant` therefore treat an omitted filter as a genuinely
tenant-wide request and refuse a narrow actor, rather than quietly restricting
the result set — a caller must never believe it saw everything when it did not.

---

## 12. In-Service Secondary Authorization — the conversions that would otherwise
have been cosmetic

Two services made a **second** authorization decision from
`RequestAuthorization.permissions`. After B1-2 that set is **TENANT-scoped only**,
so a legitimately branch-scoped actor would have passed the route guard and then
been refused inside the service — the routes would have been converted in name
only.

| Site | Before | After |
|---|---|---|
| `CashSessionCloseService.assertCloseAuthority` (own/other split, §15.2) | `permissions.has(code)` | `SCOPE_AUTHORIZATION.isAuthorized(auth, code, BRANCH(session.branch_id), tx)` |
| `DayCloseService.attempt` (`cash.day.close`) | `permissions.has(code)` | same primitive, at `BRANCH(branchId)`, **inside the write transaction** |

Both now run **inside the caller's transaction**, so the authority decision and
the write it protects share one snapshot: authority cannot be revoked between the
check and the close. The primitive reached is the *same* one the guard uses —
there is one lattice and one place non-leakage is decided.

`CashSessionCloseService` and `DayCloseService` take `RequestAuthorization`
instead of a permission set; three e2e concurrency harnesses that call these
services directly were updated to supply what the guard would have resolved
(a TENANT-scoped grant — reproducing the HTTP path, not widening it).

---

## 13. M-4+ / Internal-MVP Single-Active-Branch Mask

### What the mask actually was

The mask asserted **two different things at once**: that the tenant is
single-branch (an Internal-MVP release limit) **and** that the branch being acted
on is operative (a business rule). Conflating them is precisely why the release
limit could not be lifted without also lifting the business rule.

### Retirement, on the ratified conditions

Both sites — `DailyTradingReportService.build` and `DayCloseService.attempt` —
now do, in order, **inside their existing transaction**:

1. **Limb C first — the M-4+ gate.** `SCOPE_REVIEW_QUERY.hasUnreviewedInheritedAssignments(tx)`
   ⇒ **403, fail closed**, with a message naming the exact remedy
   (`GET /auth/permissions` reports `scopeReviewRequired`;
   `POST /auth/role-assignments/{id}/review` records the outcome).
2. **The surviving half of the mask** — `BRANCH_REPORTING_SCOPE_QUERY.isOperativeBranch(tx, {tenantId, branchId})`
   ⇒ 403 if the branch is not active. Asked **per branch**, so the tenant's
   branch *count* is no longer an authorization input (`FR-BRN-001`: unlimited
   branches).
3. Authorization itself was already decided by the route's **BRANCH target**
   (limb B), and limb A is B1-2.

**The mask is NOT globally deleted.** A tenant with unreviewed inherited grants
gains nothing: those grants are TENANT-scoped by construction, so they cover
every branch, and lifting the mask for such a tenant would hand it reach nobody
reviewed. That is the whole point of doing this in this order.

| Surface | Status |
|---|---|
| **Reporting** (`GET /reports/branches/:branchId/daily-trading/:businessDay`) | **RETIRED**, gated on M-4+ review + operative branch |
| **Day Close** (`POST /branches/:branchId/day-closes/:businessDay`) | **RETIRED**, gated on M-4+ review + operative branch |

**Contract addition, additive only:** `BranchReportingScopeQuery.isOperativeBranch`.
`operativeBranches` is retained and unchanged.

**No migration. No schema change.** B1-2's `origin`/`reviewed_at` review state
already suffices exactly as the brief anticipated, and `SCOPE_REVIEW_QUERY`
already published it.

### Tests

- `reporting-authorization.e2e-spec.ts`: the test that asserted *"two active
  branches → 403 for BOTH"* now asserts the opposite, **with the reversal and its
  authority written into the test**. A new test proves the M-4+ gate: an
  unreviewed migration-inherited grant → **403 mentioning `scopeReviewRequired`**;
  reviewing it **without changing the scope** (M-4+ outcome A) → **200**.
- `reporting-snapshot.e2e-spec.ts`: the TOCTOU proof moved with the assertion.
  It previously raced *activating a second branch*; that no longer changes any
  answer, so it now races **deactivating the branch being reported on** — the
  write that would actually flip the surviving assertion. The same-transaction
  proof now spies `isOperativeBranch`.
- The matrix asserts the tenant has **≥3 active branches** and that reporting
  works on each. The mask's retirement is what makes the whole matrix meaningful:
  a multi-branch tenant is the only shape in which cross-branch leakage can even
  be expressed.

---

## 14. Security Review (ADR 0008 D-02 / ADR 0009)

**Verdict: PASS with one finding (F-1, operational) and two recorded
consequences (F-2, F-3).** No authorization bypass was found.

| # | Reviewed | Verdict | Evidence / reasoning |
|---|---|---|---|
| 1 | **Cross-scope permission leakage** | **PASS** | One assignment must satisfy permission AND scope. Matrix 8: read-at-X1 + manage-at-X2 cannot manage X1 or read X2. |
| 2 | **Upward scope leakage** | **PASS** | `coversTarget` denies `brand→tenant` and `branch→{tenant,brand}`. Matrix 6–7 over three real TENANT routes. The 66 TENANT targets are the surface this protects, and each is declared with a reason so the classification is reviewable. |
| 3 | **Sibling branch leakage** | **PASS** | Matrix 5, plus DayClose and cash-close-policy at sibling branches. |
| 4 | **Cross-tenant target oracle** | **PASS** | §7. Byte-identical 404 for foreign vs absent on branches, brands, reports and orders. The guard defers to the route's single established answer instead of introducing a second one. |
| 5 | **Stale JWT authority** | **PASS** | Matrix 10: a re-scoped assignment kills the token on the very next request; a fresh token authorises the new branch and not the old. |
| 6 | **Missing authorization epoch** | **PASS** | Unchanged from B1-2; a tenant-bound token with no `epo` is still refused (unit + e2e). |
| 7 | **Token overflow / truncation** | **PASS** | Real 129-unit membership through the real mint path ⇒ `POST /auth/tenant` **403**. At exactly 128 a token is issued. **Nothing is truncated**; no token understating authority is ever issued. |
| 8 | **POS terminal branch escape** | **PASS** | Matrix 13: a TENANT-wide role on an X1 terminal is refused X2's order. |
| 9 | **`EmployeeBranch` becoming a grant** | **PASS** | Matrix 12 (removal denies although the role is tenant-wide) **and** the no-assignment case (permitted at Y1, holds nothing ⇒ 403). `EmployeeBranch` appears nowhere in grant computation. |
| 10 | **Body-supplied target spoofing** | **PASS** | A body id **selects** a resource; it never asserts a scope. Every body-sourced target field is mandatory and UUID-validated, an **absent** declared target is `deny` (never a widening fallback), and an array value (`?branchId=a&branchId=b`) is rejected — ambiguity must not resolve in the caller's favour. |
| 11 | **Resource-derived target confusion** | **PASS** | Each resolver reads exactly one owning column, under RLS, in the caller's context. None may widen: unresolvable ⇒ refused, never TENANT. Inventory delegates location→scope to Organisation rather than duplicating it. |
| 12 | **Ambiguity of legacy remove-by-role** | **PASS (unchanged)** | `DELETE /auth/memberships/:id/roles/:roleId` still 409s fail-closed when the role is held at several scopes, removing nothing. B1-3 did not touch it; it is TENANT-targeted like all RBAC administration. |
| 13 | **Temporary elevation expiry** | **PASS** | Matrix 9: a window moved wholly into the past stops authorising, on the DB clock, with no sweep. |
| 14 | **M-4+ unreviewed inherited grants** | **PASS** | §13. Both retired masks fail closed for an unreviewed tenant, with an actionable message; review without a scope change clears it. |
| 15 | **Branch-set scale** | **PASS** | The representation is still symbolic: a TENANT-wide actor is **one unit** whatever the branch count. Branch count drives neither token size nor, after §13, any authorization decision. |
| 16 | **Token actual serialized size** | **FINDING F-1** | Measured, below. |

### FINDING F-1 — the "~6 KB" estimate is wrong by ~2.6×

B1-2 reasoned: *"At roughly 45 bytes per rendered entry this caps the two claims
near 6 KB — inside the ~8 KB header budget of common reverse proxies."* The brief
forbids claiming safety from that estimate. Measured instead
(`test/scoped-authorization-matrix.e2e-spec.ts`, printed by the suite):

| Measurement | Value |
|---|---|
| Snapshot units (worst allowed) | **128** |
| **Serialized JWT** | **15,037 bytes** |
| **`Authorization` header line** | **15,061 bytes** |
| Empty-snapshot baseline JWT | 533 bytes |
| **Bytes per unit** | **113.3** |
| Units that fit an 8,190-byte header | **67** |
| Silent truncation | **NO** — overflow refuses the token |

**Why the estimate was low.** It counted a rendered entry once. In fact an
explicit branch id is carried **twice** — as a `branch:<uuid>` scope-set entry
*and* as a raw uuid in `pbr.branches` — and the JWT payload is then base64url
encoded, expanding it by 4/3.

**Severity: OPERATIONAL, not an authorization defect.** Overflow still fails
closed, nothing is truncated, and no authority is misdescribed. But a
worst-allowed token does **not** fit the *default* per-header limit of nginx
(`large_client_header_buffers` 8k) or Apache (`LimitRequestFieldSize` 8190). Such
a deployment would answer 431/400 and the holder would simply be unable to use
the system.

**Not silently fixed.** `MAX_SNAPSHOT_UNITS = 128` is named in **ADR 0009 D-08**;
changing it changes which tokens may be issued and is a governance decision, not
an implementation detail. The finding is instead **asserted in the test suite in
both directions** — the test fails if the worst token ever starts fitting 8,190
bytes, so the finding gets closed deliberately rather than by accident.

**Options for governance, with the numbers to decide on:**

- **(a)** lower the budget to **≤ 67 units**, which makes the worst-allowed token
  fit the strictest common default. Cost: an actor may hold fewer distinct narrow
  scopes before being refused a token;
- **(b)** keep 128 and record a **deployment requirement of ≥ 16 KB** per-header
  allowance (measured headroom: 15,061 < 16,384);
- **(c)** stop carrying branch ids twice — `pbr` is derivable from `scp`, which
  would roughly halve the per-unit cost. This changes the `FR-API-012` clause-1
  token shape and therefore needs its own review.

### FINDING F-2 — the `defer` consequence (informational, no regression)

A route that does not 404 on an invisible target executes without a scope
decision and returns its ordinary empty/negative answer
(`GET /catalogue/branches/:unknown/menus` → `200 []`). It discloses nothing (the
query is tenant-scoped; foreign and non-existent are identical) and is **not a
regression** — pre-B1-3 the tenant-permission check passed and the same empty
list was returned. Recorded because the reasoning, not the outcome, is what a
future reviewer needs.

### FINDING F-3 — a deliberate widening (recorded, not hidden)

`POST /org/branches` is now **BRAND**-targeted from the body's `brandId`, so a
BRAND-X administrator holding `settings.branch.manage` can create a branch under
brand X. Pre-B1-3 only a tenant-scoped actor could. This is the ratified lattice
applied honestly (`BRAND X` covers brand X), but it **is** an authority widening
and governance should see it as one. `POST /org/branches/:branchId/brand`
(re-parenting) was deliberately kept TENANT for the mirror-image reason.

---

## 15. Revoked-Terminal Message — the §12 open item

**Decision: OPTION A. Recorded as a design decision; NO behaviour changed; NO
code written.**

*Context.* Integration observed that B1-2's `TenantContextGuard` rejects a
revoked POS terminal before Sync's own `SyncTerminalGuard` runs, so Sync's
specific reassurance wording about unsynced committed transactions not being
discarded becomes unreachable. The security behaviour is correct: revoked
terminal ⇒ 403.

*Verification in this lane.* **There is no Sync module on this branch.**
`src/modules/` contains no sync surface and no `SyncTerminalGuard`. So there is
nothing here to change, and any change would be speculative against code this
lane cannot see.

*The decision, and why.* **The generic POS 403 remains authoritative. The
lossless-backlog guarantee belongs to the sync client and the recovery protocol
and its documentation — not to an authorization error body.**

1. An authorization error is returned to a caller whose authority has just been
   revoked. Making it carry *operational reassurance* couples the anti-enumeration
   surface to a product promise, and every future promise then becomes a
   candidate for the same coupling.
2. The uniform 403 is load-bearing: B1-2 deliberately returns **one** message for
   terminal-inactive, employee-not-permitted and scope-refused, so a terminal
   cannot probe which condition it failed. Option B (a structured, non-enumerating
   reason category) is *possible* to do safely, but it is a **published contract
   change**, and adding a discriminator to the exact response that exists to be
   indiscriminate deserves its own review rather than a side-effect of B1-3.
3. A client that has committed transactions locally must not depend on a server
   error body to know they are safe. It must know that from its own protocol —
   which is where the guarantee has to live to be worth anything, since the
   revoked-terminal case is precisely the case where the server may say nothing
   at all.

*What this decision does NOT claim.* **Lossless revoked-terminal recovery is NOT
implemented and is not claimed.** It remains Lane D hard-gate work. No
Sync-specific bypass was added, and anti-enumeration was not weakened.

*If governance prefers Option B*, it needs its own decision record: the
discriminator's exact vocabulary, a proof that the vocabulary cannot distinguish
"terminal revoked" from "employee removed" from "wrong scope", and the OpenAPI
contract for it.

---

## 16. Requirement Disposition — no overclaims

| Requirement | Status | Why |
|---|---|---|
| **`FR-SEC-004`** [M] | **COMPLETE** (proposed) | Every applicable business operation is scoped: 141/141 permission-bearing routes declare an explicit target, 0 undeclared, proven by a gate that discovers routes from the filesystem. Non-leakage is proven across scopes over real routes (matrix 1–8, 11–14), including the "P at Branch A + Q at Branch B" case in both directions. The generated coverage gate prevents silent omission. **The three completion conditions in brief §14 are met.** |
| **`FR-API-012`** [M] | **COMPLETE** (proposed) | Clause 1 (token carries subject, tenant, scope set, permitted branch set) is unchanged and still implemented — and now **measured** (§14 F-1). Clause 2 ("every request SHALL be authorised against both the permission and the scope") is true for every applicable request: the single enforcement point evaluates permission AND target for all 141, and the 15 exceptions are authentication/identity operations with no narrower business target, individually reviewed and asserted non-stale. |
| **`FR-SEC-028`** [M] | **PARTIAL (unchanged)** | Registration, revocation and immediate invalidation are implemented; **local-device data wipe is NOT**. B1-3 did not touch it and does not claim it. |
| **`FR-PLT-013`** | **PARTIAL (unchanged) — NOT CLAIMED** | An executable coverage gate exists and passes **in this branch**. There is **no CI pipeline here**, so no CI integration is claimed. Integration may wire the passing suite in; that is when this moves. |
| `FR-SEC-002` / `003` / `005` | COMPLETE (unchanged) | Not re-claimed by this slice; still green. |
| `FR-PLT-012` | COMPLETE (unchanged) | Fail-closed tenant context preserved; **no RLS policy touched**. |
| `FR-BRN-005` | PARTIAL (unchanged) | `BRANCH_GROUP` remains deferred, blocked on the entity. |
| `FR-SEC-010` / `012` | NOT IMPLEMENTED (unchanged) | Appendix C absent; **no permission code created**. |

**Governance approval is not implementation credit.** The `FR-SEC-004` /
`FR-API-012` transitions above are this report's *proposal* on the evidence
below; the register remains authoritative.

---

## 17. Remaining Gaps

1. **F-1 needs a governance decision** — lower `MAX_SNAPSHOT_UNITS`, accept a
   ≥16 KB header deployment requirement, or change the claim encoding (§14).
2. **F-3 is a widening** — `POST /org/branches` being BRAND-targetable should be
   confirmed, not merely observed (§9).
3. **The revoked-terminal message (Option B)** remains available to governance,
   with the conditions it would have to satisfy written down (§15).
4. **`FR-PLT-013`** needs the CI wiring Integration owns.
5. **`BRANCH_GROUP`** remains the mandatory follow-up once the entity exists.
6. **`FR-SEC-028`** local-device wipe is untouched, by instruction.
7. **The coverage gate proves declaration, not classification correctness** —
   §9's inventory is the review artefact for the latter, and it should be read.

---

## 18. Module Boundaries, Schema, Migration, OpenAPI

| | |
|---|---|
| **`KNOWN_DEVIATIONS`** | **DID NOT GROW.** Every new cross-module edge goes through a published `contract/`. `module-boundaries.spec.ts` passes. |
| **New `contract/` surfaces** | `identity/contract/authorization-target.ts` (the decorator, spec builders, `ScopeTargetResolver`, `SCOPE_AUTHORIZATION` port, `IDENTITY_TERMINAL_TARGET_RESOLVER`); resolver tokens published by organisation, sales, treasury, kitchen, inventory, catalogue, production. `inventory/contract/index.ts` and every other barrel was **appended to, never rewritten**. |
| **SCHEMA CHANGE** | **NO.** `prisma/schema.prisma` is untouched. |
| **MIGRATION** | **NO.** None was needed — B1-2's `origin`/`reviewed_at` review state already suffices, exactly as brief §16 anticipated. B1-2's migration was not modified. |
| **PERMISSION CODES** | **NONE created, extended or reclassified.** |
| **OPENAPI** | Regenerated with `npm run openapi:generate`; **never hand-edited**. The diff is **10 lines, descriptions only** — no operation added or removed, no request or response **shape** changed. The changes correct text that documented the now-retired mask ("exactly one active branch") and state the scoped condition instead. |

### One shared architecture test was improved, not weakened

`module-boundaries.spec.ts`'s `containsPersistenceImplementation` scanned **raw
source**, so any docblock containing the words `class` followed by another word
tripped it — which penalised contract files for explaining themselves. It now
strips comments first. This **cannot hide a violation** (a `class` inside a
comment is not a class), and two new assertions prove exactly that: prose naming
`@Injectable()`, `class` and `create(` stays clean, while `export class Sneaky {}`
below a comment is still caught.

---

## 19. Files Changed

**New (16)**

| Path | Purpose |
|---|---|
| `src/modules/identity/contract/authorization-target.ts` | The published declaration surface: `@AuthorizationTarget`, spec builders, `ScopeTargetResolver`, `SCOPE_AUTHORIZATION`. |
| `src/modules/identity/authz/authorization-target.resolver.ts` | Request + spec ⇒ concrete `TargetScope`, with the visibility/defer rules. |
| `src/modules/identity/terminals/scope-target.resolver.ts` | Terminal ⇒ branch. |
| `src/modules/organisation/contract/scope-target.resolvers.ts` + `branches/scope-target.resolvers.ts` | Station / table / warehouse / location. |
| `src/modules/sales/contract/scope-target.resolvers.ts` + `orders/scope-target.resolver.ts` | Order ⇒ branch. |
| `src/modules/treasury/contract/scope-target.resolvers.ts` + `cash-sessions/scope-target.resolver.ts` | Cash session ⇒ branch. |
| `src/modules/kitchen/contract/scope-target.resolvers.ts` + `tickets/scope-target.resolver.ts` | Ticket ⇒ branch. |
| `src/modules/inventory/contract/scope-target.resolvers.ts` + `counts/scope-target.resolvers.ts` | Count session / count line ⇒ location ⇒ Organisation. |
| `src/modules/catalogue/contract/scope-target.resolvers.ts` + `price-lists/scope-target.resolvers.ts` | Price list / availability rule. |
| `src/modules/production/contract/scope-target.resolvers.ts` + `recipes/scope-target.resolver.ts` | Recipe. |
| `src/modules/authorization-coverage.spec.ts` | The coverage gate. |
| `test/scoped-authorization-matrix.e2e-spec.ts` | The cross-branch / POS / resource-derived / token-size matrix. |

**Modified — production (20)**: `identity/authz/guards/permission.guard.ts` (the
single enforcement point) · `identity/identity.module.ts` ·
`identity/contract/index.ts` · the 10 controllers · the 8 modules that bind a
resolver · `organisation/contract/branch-reporting-scope.query.ts` +
`branches/branch-reporting-scope.query.service.ts` (`isOperativeBranch`) ·
`reporting/daily-trading-report.service.ts` (mask retirement) ·
`treasury/day-close/day-close.{service,controller}.ts` ·
`treasury/cash-session-close/cash-session-close.service.ts` ·
`treasury/treasury.controller.ts`.

**Modified — generated**: `docs/api/openapi.json`, `docs/api/openapi.yaml`.

**Modified — tests (8)**: `permission.guard.spec.ts` (rewritten for the two-key
metadata and the declared-target path) · `module-boundaries.spec.ts` (detector +
two new assertions) · `day-close.service.spec.ts` · `day-close-fixtures.ts`
(`dayCloseAuthorization` helper) · `day-close-cutover-race`,
`day-close-znumber-concurrency`, `cash-movements-close-and-payment-concurrency`
(direct-service calls now pass the resolved authorization) ·
`reporting-authorization.e2e-spec.ts` and `reporting-snapshot.e2e-spec.ts` (mask
retirement, with the reversal written into the tests).

**NOT changed**: the scope lattice, the snapshot service, the tenant-context
service, any RLS policy, any migration, the Prisma schema, the permission
catalogue.

---

## 20. Tests — results actually executed in this session

| Suite | Result |
|---|---|
| **Typecheck** (`npx tsc --noEmit`) | **1 error — the known pre-existing baseline** in `identity/auth/access-token.service.spec.ts(28,7)`, byte-identical to HEAD and untouched. **Zero new errors.** No `any`, no `@ts-ignore`, no config change. |
| **Unit** (`npx jest`) | **852 passed / 852, 62 suites, 0 failed** |
| **Module boundaries** | **included above and passing**; `KNOWN_DEVIATIONS` did not grow |
| **Authorization coverage gate** | **PASS** — 156 routes, 141 declared, 0 undeclared |
| **Scoped RBAC (B1-2 suites)** | `scoped-rbac` + `scoped-rbac-migration` — passing unchanged |
| **Cross-branch matrix (new)** | **23 passed / 23** |
| **Organisation / RBAC / audit / terminal / catalogue / inventory / production** | **213 passed / 213, 5 suites** (after the §7.2 fix) |
| **Sales / receipt / order-completion** | **263 passed / 263, 15 suites** |
| **OpenAPI** | Regenerated; contract suite passing |
| **FULL e2e** (`npm run test:e2e -- --runInBand`) | **1223 passed / 1223, 67 suites, 0 failed, exit 0** |

### Both full runs are recorded, including the one that failed

| Run | Result | Disposition |
|---|---|---|
| 1 | 1222 / 1223, 1 failed, 180 s | `cash-session.e2e-spec` *"refuses a reused SHIFT id carrying different content"* returned **401**, not 403. A 401 comes from `JwtAuthGuard` — nothing in B1-3 can produce one; every path this slice touches answers 200/403/404. Investigated rather than assumed: the suite passes **82/82 in isolation** and **105/105 run together with the new matrix suite**, and the 180 s run is nowhere near the 15 m access-token TTL, so the TTL hypothesis was rejected too. |
| **2 (final)** | **1223 / 1223, 67 / 67 suites, exit 0, 177 s** | Re-run unchanged; the failure did not reproduce. |

**No prior run's numbers are re-reported as the final result**, and the run-1
failure is recorded as an unreproduced full-run flake rather than explained away
or quietly dropped. It is not attributable to this slice's code on the evidence
above, but it is also not *proven* absent — a reviewer should know it happened.

### Suites deliberately NOT claimed

This branch does **not** contain the corrected integrated G1-2 harness, and no
claim is made that it does. There is **no CI pipeline here**; the coverage gate
is executable locally and nothing more is asserted about it.

---

## 21. Database Safety

| | |
|---|---|
| **Persistent `ros` touched** | **NO** |
| Databases used | **`ros_lane_b_b13_zero`** only — created for this task, disposable |
| Guard | A guard script mediated every create/drop and was **proven to refuse before being used for real**: `ros` → exit 90, `postgres` → 90, `template1` → 90, `ros_lane_g` → 91, an unrecognised name → 91 |
| Migrations | `prisma migrate deploy` applied all 37 from empty — *"All migrations have been successfully applied."* **No migration was added or modified.** |
| Destructive SQL | No `DROP`/`ALTER` was issued against `ros`, `postgres`, `template0` or `template1`. Only the database created by this task exists to be dropped. |
| `.env` | Points at the disposable database; gitignored; absent from the diff. |

---

## 22. Integration Collision Risks

| Risk | Detail |
|---|---|
| **`PermissionGuard` constructor changed** | It now takes `AuthorizationTargetResolver` and `ScopeAuthorizationService` (4 args, was 2). Any lane constructing it directly — only `permission.guard.spec.ts` does — must pass them. |
| **Every controller changed** | All 10 gained `@AuthorizationTarget` lines and one import block. A lane touching the same routes should expect line-level conflicts; they resolve by keeping BOTH the other lane's change and the target declaration. **A merge that drops a target declaration will fail the coverage gate**, which is the intended safety net. |
| **A NEW route from any lane fails the gate until it declares a target** | By design. The fix is one decorator, not an allowlist entry. |
| **`CashSessionCloseService` / `DayCloseService` signatures** | They take `RequestAuthorization`, not `ReadonlySet<string>`. Any lane calling them directly must pass the resolved authorization (`test/day-close-fixtures.ts` publishes `dayCloseAuthorization` for exactly this). |
| **`BranchReportingScopeQuery` gained `isOperativeBranch`** | Additive; any test double implementing the interface must add it (one existed: `reporting-snapshot.e2e-spec.ts`, updated). |
| **Retired masks are a behaviour change** | Reporting and Day Close now serve multi-branch tenants. Any lane asserting the old *"more than one active branch → 403"* will fail, correctly. |
| **`module-boundaries.spec.ts` detector** | Comment-stripping is a shared-test change. A lane editing the same function will conflict; keep the strip. |
| **`docs/api/openapi.*`** | Regenerated. Resolve by regenerating, never by hand-editing. |
| **`access-token.service.spec.ts` TS2322** | Still untouched and byte-identical to HEAD, exactly as B1-2 left it. |
| **`inventory/contract/index.ts`** | Appended to. It already existed (`sale-depletion.*`); a rewrite would break Sales. Verified append-only for every barrel. |

---

## 23. Commit

- **Subject:** `feat(security): enforce scoped authorization across routes`
- One commit. The diff is one coherent change — a declaration surface, a single
  enforcement point, the declarations themselves, the resolvers they name, and
  the tests that prove them — and splitting the tests away from the enforcement
  would produce a first commit whose central claim is unverified.
- Files staged **explicitly**. No `git add .`, no `git add -A`.

---

## 24. Push / Deploy Status

| | |
|---|---|
| **Pushed** | **NO** |
| **Merged / rebased / cherry-picked** | **NO** |
| **Deployed** | **NO** |
| **Destructive git operations** | **NONE** |
| **Persistent `ros` database touched** | **NO** |
| **Ready for integration review** | **YES**, with F-1 flagged for a governance decision (§14) and F-3 flagged as a deliberate widening (§9). |
