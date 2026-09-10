# FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1 — Procurement Supplier Foundation

**Report type:** Implementation report (evidence, not governance).
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority.
No new governance decision is made here. Every representational choice not
literally specified by the SRS follows the closest existing repository
convention, identified below, never invented to "finish the task."
**Date:** 2026-09-10
**HEAD at task start:** `96ab003062b36c7ee887dc6062f1b27fbd89c9b7` (tip of
`full-srs/lane-d4-reporting-demo` — the P2E report's hash-recording commit).
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree at task start:** clean except pre-existing untracked report
files from earlier sessions (not part of this task's diff — listed in the
git status snapshot below).
**Task identifier:** `FULL-SRS-PRC-SUPPLIER-FOUNDATION-P1`

---

## 0. Baseline

```
$ git rev-parse HEAD
96ab003062b36c7ee887dc6062f1b27fbd89c9b7

$ git log -12 --oneline
96ab003 docs(reports): record commit hash in P2E report
aece939 feat(sales): real service-charge computation from the pinned policy (P2E)
c0a14df docs(reports): record commit hash in P2D-CORRECTION report
e304f8e test(sales): strengthen ServiceChargePolicy precedence + anti-backdating evidence (P2D-CORRECTION)
aaa41ed docs(reports): record commit hash in FULL-SRS-PLT-SERVICE-CHARGE-POLICY-P2D report
8715474 feat(sales): ServiceChargePolicy configuration substrate (P2D-R1)
19e5746 docs(reports): record commit hash in FULL-SRS-PLT-CASH-ROUNDING-PROVIDER-EXCLUSIVE-P2C1-IMPL report
b5f67d5 fix(platform-settings,localisation): payments.cash_rounding_policy is Country-Pack provider-exclusive (P2C1-R1)
9a7da00 docs(governance): ratify P2C1-R1 and P2D-R1 (cash-rounding provider-exclusivity + ServiceChargePolicy config semantics)
5dc916c docs(reports): record commit hash in FULL-SRS-PLT-COUNTRY-PACK-LOCK-P2B report
7cd43e5 feat(localisation,platform-settings): Country Pack settingsLocks — closes FR-PLT-026
7c604d6 docs(governance): ratify P2A-R1 financial-settings decision (Country Pack lock + FR-PLT-028 storage)
```

`git status` at task start showed only pre-existing untracked report files
from earlier same-session tasks (PLT settings workstream reports/CSV) — no
uncommitted code, no in-progress migration. No Procurement module, schema,
Prisma model, permission, or route existed anywhere in the repository
(verified by exhaustive grep for `procurement`, `supplier`, `Supplier` across
`src/`, `prisma/schema.prisma`).

### Repository inspection performed before writing code

- **Module structure**: feature-folder style, no `domain/application/
  infrastructure` split. Every cross-module-consumed module publishes a
  `contract/` directory (barrel `index.ts` re-exporting interface/`Symbol`/
  type-only files), enforced by `src/modules/module-boundaries.spec.ts`.
- **Inventory**: `StockItem` (`prisma/schema.prisma`, `inventory` schema),
  `Uom` (global, un-tenanted reference data) + `UomConversion` +
  `PackagingUnit` (per-item purchase unit with `conversionFactorToBase
  Decimal(20,6)`). `PackagingUnit.supplierId` and `StockBatch.supplierId` are
  ALREADY bare, unconstrained `UUID?` columns with an explicit comment
  ("Procurement is out of scope") — the exact seam this slice fills.
  Inventory published **no** stock-item/UOM query contract before this
  slice; one was added (§4 below).
- **Money**: `BigInt` minor units (e.g. `StockItem.standardCost`,
  `CashMovement.amountMinor`), wire-serialized as a decimal string
  (`common/openapi/schema-helpers.ts`'s `moneyStringSchema`). Currency:
  `src/common/money/currency.ts`'s `currencyOf()` (ISO-4217 exponent table).
- **Quantity**: `Prisma.Decimal`, `@db.Decimal(18,6)`/`(20,6)`, wire format a
  decimal string (`decimalStringSchema`), DTO regex
  `/^-?\d{1,12}(\.\d{1,6})?$/`.
- **Tenant scoping / RLS**: `tenant_id NOT NULL`, `ENABLE`/`FORCE ROW LEVEL
  SECURITY`, `USING (tenant_id = NULLIF(current_setting('app.tenant_id',
  true), '')::uuid)`. Tenant-leading composite FKs via `@@unique([tenantId,
  id])` on the parent. `PrismaService.withAuthContext` is the one mechanism
  that sets the transaction-local RLS GUCs.
- **Cross-module reference without a DB FK**: `sales.order_lines.menu_item_id`
  /`variant_id` and `inventory.packaging_units.supplier_id` are the existing
  precedent for "record the id, validate through a published contract at the
  application layer, no cross-schema FK" — followed exactly for
  `stockItemId`/`purchaseUnitId` here.
- **Audit**: `governance/contract/audit.ts` (`AuditService.record(tx,
  event)`, `AUDIT_ACTION`, `AUDIT_ENTITY`) — a thin re-export, consumed
  without importing `AuditModule` (it is `@Global()`), exactly as Kitchen and
  Reporting already do.
- **Permissions**: per-module `<module>.permissions.ts`, dot-notation
  `module.resource.action`. `identity/contract/http.ts` publishes
  `JwtAuthGuard`/`TenantContextGuard`/`PermissionGuard`/`RequirePermission`/
  `RequireAnyPermission`/`AllowPosSession`/`CurrentPrincipal`/
  `CurrentTenantContext`. `identity/contract/authorization-target.ts`
  publishes `AuthorizationTarget`/`tenantTarget`/etc. (B1-3 scoped-RBAC).
  A prior audit report
  (`docs/reports/claude/2026-09-07_SRS-AUDIT-IDENTITY-RBAC_...md`)
  independently confirmed `supplier.manage`/`purchase.*` are SRS §15.2
  catalogue codes with **no** Procurement module existing to seed them.
- **Module-boundaries discipline**: Kitchen and Reporting are the two
  modules that add **zero** `KNOWN_DEVIATIONS` entries, reaching Identity/
  Governance/other modules exclusively through `contract/` barrels. This
  slice follows that pattern, not the older per-module private-path pattern
  (Catalogue/Inventory/Sales/Treasury/Workforce all carry legacy deviations).
- **Range-exclusion precedent**: `catalogue.price_lists` (migration
  `20260819120000_price_list_no_overlap`) and
  `workforce.scheduled_shifts` (migration
  `20260904010000_workforce_core_employee_schedule_attendance`) both use a
  Postgres `EXCLUDE USING gist (... , tstzrange(...) WITH &&)` constraint
  (`btree_gist` extension) for "no two overlapping windows for the same
  scope" — reused verbatim for `supplier_price_entries`.
- **Append-only ledger grant pattern**: `governance.audit_entries` /
  `inventory.stock_movements` / `workforce.employee_compensations` /
  `workforce.schedules`/`scheduled_shifts` all grant `ros_app` `SELECT,
  INSERT` only, with `REVOKE UPDATE, DELETE, TRUNCATE` — reused for
  `supplier_price_entries`.

No genuinely irreversible ambiguity blocked implementation; no STOP was
triggered.

---

## 1. Procurement module

Created `src/modules/procurement/` as a new bounded context:

```
src/modules/procurement/
  contract/
    index.ts                         (public barrel)
    procurement-facts.query.ts       (PROCUREMENT_FACTS_QUERY — §15)
  suppliers/suppliers.service.ts
  sourcing/sourcing.service.ts
  pricing/pricing.service.ts
  procurement.controller.ts
  procurement.dto.ts
  procurement.module.ts
  procurement.permissions.ts
  procurement.views.ts               (BigInt/Decimal -> JSON-safe view mappers)
  procurement.errors.ts → procurement-errors.ts (local rethrow/exclusion helpers)
  procurement-facts.query.service.ts (private impl of the contract above)
```

Procurement owns `Supplier`, `SupplierItemLink`, `SupplierPriceEntry`. It
imports `IdentityModule` (cross-cutting HTTP/auth plumbing, via
`identity/contract` only) and `InventoryModule` (for
`STOCK_ITEM_PURCHASING_FACTS_QUERY`, via `inventory/contract` only). It
never queries `inventory.*` tables directly and never imports an Inventory
private path (`inventory/stock-items/*`, `inventory/contract`'s own private
implementation files, etc.). `KNOWN_DEVIATIONS_ADDED: none` — verified by
`module-boundaries.spec.ts`'s whole-tree assertion (§16 below).

---

## 2. Supplier master — FR-PRC-005

`prisma/schema.prisma`: `model Supplier` (schema `procurement`, table
`suppliers`). Fields: `code` (unique per tenant, `@@unique([tenantId,
code])`), `legalName`, `tradingName?`, `taxRegistrationNumber?`, `addresses
Json` (array of `{line1, line2?, city?, state?, postalCode?, countryCode?,
isPrimary?}`, DTO-validated with a nested `AddressDto`), `contacts Json`
(array of `{name, role?, phone?, email?, isPrimary?}`, `ContactDto`),
`paymentTermsNetDays Int` (§3), `currency Char(3)`, `deliveryLeadTimeDays
Int`, `minimumOrderValue BigInt` (minor units), `deliveryDays Int[]`
(ISO weekday numbers 0–6, following the existing native-array convention
`catalogue.menus.order_types`/`catalogue.menu_items.allergens` already use
for small structured lists), `status SupplierStatus` (`active`/`inactive`
only — §2 of the mission brief; no richer vocabulary is SRS-given or already
conventional), `createdAt`, `updatedAt`.

**Invariants enforced**: `@@unique([tenantId, code])` (DB-level, 409 on
violation via `rethrowAsConflict`); `currencyOf()` (ISO-4217 shape/exponent)
called before every currency write, 400 on failure; DB `CHECK` constraints
`ck_supplier_currency_iso`, `ck_supplier_payment_terms_non_negative`,
`ck_supplier_lead_time_non_negative`, `ck_supplier_min_order_value_non_negative`
(defense-in-depth behind the DTO-level `@Min(0)` checks). No hard delete: no
`delete` method exists on `SuppliersService`, and the migration's `ros_app`
grant on `procurement.suppliers` carries **no** `DELETE` privilege at all —
deactivation is only ever `PATCH /procurement/suppliers/:id/status`.

## 3. Payment terms

No existing `PaymentTerms` abstraction was found anywhere in the repository
(grepped exhaustively). Implemented the smallest structured representation
the mission brief names: a plain `paymentTermsNetDays Int` column (the
semantic equivalent of `{ netDays: nonNegativeInteger }`), not a JSON blob —
consistent with how the repository represents a single scalar business fact
as a named column rather than a one-key JSON object. Richer FR-PRC-045
payment-proposal semantics (early-settlement discounts, etc.) are explicitly
documented as future work in `procurement.permissions.ts`'s and the Prisma
model's own doc comments; nothing is invented here.

## 4. Supplier <-> StockItem sourcing — FR-PRC-007 / FR-INV-005

`model SupplierItemLink` (table `supplier_item_links`): `supplierId`,
`stockItemId` (recorded Inventory id, **no DB FK** — see §1's precedent),
`supplierItemCode?`, `supplierBarcodes String[]`, `preferenceRank Int
@db.SmallInt @default(0)`, `isActive Boolean @default(true)`.

**Invariants**: `@@unique([tenantId, supplierId, stockItemId])` (one link per
supplier+item); `@@unique([tenantId, supplierId, id])` (a D-16-style extra
composite-uniqueness that lets `SupplierPriceEntry`'s own composite FK
structurally guarantee its `supplierId` matches the link's real supplier —
no service-layer cross-check needed); `stockItemId` and `tenant` match
validated via the new **Inventory published contract**
`STOCK_ITEM_PURCHASING_FACTS_QUERY` (§6) — a cross-tenant or non-existent
stock item resolves to `null` and the route returns 404, never a database
error. `preferenceRank` is a non-negative `SmallInt` (DB `CHECK`), mirroring
`catalogue.price_lists.priority`'s ranking convention (lower = more
preferred). `supplierItemCode`/`supplierBarcodes` are stored and returned
verbatim, entirely distinct columns from `stock_items.sku` — never conflated
(the FR-INV-005 §4 invariant).

## 5. Supplier price list — FR-PRC-006

`model SupplierPriceEntry` (table `supplier_price_entries`, `procurement`
schema): `supplierId`, `supplierItemLinkId`, `purchaseUnitId` (recorded
Inventory id, no DB FK), `packSize Decimal(18,6)`, `unitPrice BigInt`,
`currency Char(3)`, `validFrom Timestamptz`, `validUntil Timestamptz?`,
`volumeTiers Json?`, `createdAt`. **Immutable**: no `update` method exists on
`PricingService`; the `ros_app` DB grant is `SELECT, INSERT` only
(`REVOKE UPDATE, DELETE, TRUNCATE`) — a new agreed price is always a new row.

**Currency compatibility (§5 of the brief)**: `PricingService.createPriceEntry`
loads the sourcing link's supplier and rejects (400) any price entry whose
`currency` does not equal `Supplier.currency` at creation time — cross-
currency ambiguity is refused outright rather than silently permitted, since
neither the SRS nor any existing repository convention authorizes
multi-currency supplier quotes. The **entry's own `currency` column** is
what is read back on every later query — pinned at creation, independent of
any later change to the supplier's configured currency.

## 6. Purchase unit validation

Added the smallest additive Inventory contract the mission brief's §6 asks
for: `inventory/contract/purchasing-facts.query.ts`
(`STOCK_ITEM_PURCHASING_FACTS_QUERY`, interface
`StockItemPurchasingFactsQuery.find(tx, {tenantId, stockItemId})`), backed
by a new private `StockItemPurchasingFactsQueryService`
(`inventory/stock-items/stock-item-purchasing-facts.query.service.ts`, bound
in `InventoryModule`). It returns the stock item's own base `Uom` (as a
`kind: 'base'` purchase unit, conversion factor `'1'`) plus every configured
`PackagingUnit` (`kind: 'packaging'`), reusing Inventory's existing UOM
model verbatim — no UOM conversion logic is duplicated in Procurement.
`PricingService` validates a submitted `purchaseUnitId` against this list by
simple membership; an unlisted id is a 400, not a 500 or silent acceptance.

## 7. Price history

No `update`/`delete` write path exists for `SupplierPriceEntry` (§5). A
`GET /procurement/supplier-price-entries?supplierItemLinkId=` route returns
the full history ordered `validFrom desc`; a superseded historical price
remains fully readable. **Deterministic effective-price resolution** is
`validFrom <= at AND (validUntil IS NULL OR at < validUntil)`
(`PricingService.effectivePrice`/`comparativePricing`), served via
`GET /procurement/supplier-price-entries/effective`.

**Ambiguity rejection (§7's key invariant)** is enforced at the database, not
merely re-checked in application code — a real Postgres `EXCLUDE USING gist`
constraint (`ex_supplier_price_entry_no_overlap`, migration SQL), on
`(tenant_id, supplier_item_link_id, purchase_unit_id, tstzrange(valid_from,
valid_until))`. A volume-tier schedule is embedded whole inside one price
entry row (§8), so this key IS the full "supplier + item + purchase unit +
volume tier scope" the mission brief names: two rows for the same
`(supplierItemLink, purchaseUnit)` can never have overlapping validity
windows, which is exactly "at most one applicable agreed price (and its
tier schedule) at any instant." A concurrent-writer race is caught by the
constraint (mapped to `409 Conflict` via the local `isExclusionViolation`
helper), never silently resolved by "latest created wins."

## 8. Volume break tiers

`SupplierPriceEntry.volumeTiers Json?` — one typed JSONB array, each element
`{minimumQuantity: string, unitPriceMinor: string}` (both decimal/minor-unit
strings, never floats). `PricingService.validateVolumeTiers` enforces:
quantities `> 0`, prices `>= 0`, strictly increasing `minimumQuantity` with
no duplicate thresholds (400 on any violation). No purchasing-quantity
optimisation is implemented: `comparativePricing` accepts an optional
`quantity` and, only if supplied, selects the **greatest satisfied minimum
quantity** tier (the brief's explicitly sanctioned rule, consistent with no
contradicting existing tier-selection precedent found in the repository);
without a `quantity`, the full `volumeTiers` array and the entry's base
`unitPrice` are both returned, and the caller decides.

## 9. Comparative supplier pricing — FR-PRC-007

`GET /procurement/comparative-pricing?stockItemId=&at=&quantity=`
(`PricingService.comparativePricing`, read-only). For each **active**
`SupplierItemLink` whose **supplier is `active`** (inactive suppliers and
inactive links are excluded — a Prisma relation filter,
`supplier: { status: 'active' }`), every currently-effective
`SupplierPriceEntry` at `at` (default now) is returned as one row: supplier
id/code/name/status, `supplierItemLinkId`, `preferenceRank`,
`supplierItemCode`, `purchaseUnitId`, `packSize`, effective `unitPrice`,
`currency`, `validFrom`/`validUntil`, `volumeTiers`, and (if `quantity` was
supplied) the `selectedTier`. **Deterministic ordering**: `preferenceRank`
ascending first, then `supplierCode` ascending, then `purchaseUnitId`
ascending as a final stable tiebreak — never incidental row order. Prices
are **never numerically compared across currencies**: no ranking or
arithmetic in this method ever touches `unitPrice`, only `preferenceRank`
and the tenant-uniform tiebreak fields — a client comparing amounts is
handed each row's own `currency` and decides for itself; nothing here
manufactures a false cross-currency ranking.

## 10. FR-PRC-008 boundary

History portion (track price history per supplier per item) is now genuinely
implemented end-to-end (§5/§7) — **COMPLETE**. Receipt-time variance alerting
("alert when a received price differs from the agreed price beyond
tolerance") requires Goods Receipt, which is explicitly out of scope (§19)
and was **not** built merely to close this code — **PARTIAL** remains the
honest status, unchanged in kind, closer in substance.

## 11. HTTP surfaces

All under `@Controller('procurement')`, `@UseGuards(JwtAuthGuard,
TenantContextGuard, PermissionGuard)`, `@ApiBearerAuth()`:

| Method | Path | Purpose |
|---|---|---|
| POST | `/procurement/suppliers` | create supplier |
| GET | `/procurement/suppliers` | list suppliers (optional `status` filter) |
| GET | `/procurement/suppliers/:id` | get supplier |
| PATCH | `/procurement/suppliers/:id` | update supplier (not status) |
| PATCH | `/procurement/suppliers/:id/status` | deactivate/reactivate |
| POST | `/procurement/supplier-item-links` | create sourcing link |
| GET | `/procurement/supplier-item-links` | list by `supplierId` or `stockItemId` |
| PATCH | `/procurement/supplier-item-links/:id` | update preference/status/codes |
| POST | `/procurement/supplier-price-entries` | create historical price entry |
| GET | `/procurement/supplier-price-entries` | price history for a sourcing link |
| GET | `/procurement/supplier-price-entries/effective` | effective price at instant |
| GET | `/procurement/comparative-pricing` | comparative pricing for a stock item |

No `DELETE` route exists anywhere in this controller (mission §11/§19). No
`@AllowPosSession()` decorator appears anywhere in the file — back-office/
console only, proven by the POS-token e2e test (§16).

## 12. Authorization

`procurement.permissions.ts` defines exactly one seeded code,
`supplier.manage` — taken verbatim from the SRS §15.2 catalogue, the same
"unwired SRS code, now seeded by the module that finally implements it"
pattern `hr.employee.manage`/`kds.operate`/`report.view.*` each established.
Every mutation route requires it (`@RequirePermission`). Every read route
uses `@RequireAnyPermission(PROCUREMENT_PERMISSIONS.SUPPLIER_MANAGE,
PURCHASE_ORDER_CREATE_PERMISSION)` — the existing any-permission guard
(`identity/contract`'s `RequireAnyPermission`). `PURCHASE_ORDER_CREATE_PERMISSION
= 'purchase.order.create'` is referenced **only** as a string literal
(documented as owned by the future PO slice, §19 scope fence) — it is
**not** included in `PROCUREMENT_PERMISSION_DEFS`, so Procurement seeds no
permission it does not own; the OR-guard is forward-compatible scaffolding,
proven functional in the e2e suite by having the test itself seed the code
(simulating the future PO slice) and confirming the read route accepts it.
Every route carries an explicit `@AuthorizationTarget(tenantTarget(...))`
(B1-3): Supplier/sourcing/price data is tenant-wide master data with no
narrower branch owner — exactly the classification
`AuthorizationTargetSpec`'s own doc comment names for "tenant master data,
tenant-level registries." `authorization-coverage.spec.ts` passes unchanged
(9/9) — no route is left on the undeclared/tenant-only allowlist.

## 13. RLS / database security

Migration `20260910122221_procurement_supplier_foundation`:
`tenant_id NOT NULL` on all three tables; `ENABLE ROW LEVEL SECURITY` +
`FORCE ROW LEVEL SECURITY`; `SELECT`/`INSERT`/`UPDATE` policies on
`suppliers`/`supplier_item_links` (`WITH CHECK`/`USING
tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`);
`SELECT`/`INSERT`-only policies on `supplier_price_entries` (append-only,
matching its `REVOKE UPDATE, DELETE, TRUNCATE` grant). Tenant-leading
composite FKs throughout: `supplier_item_links.(tenant_id, supplier_id) ->
suppliers.(tenant_id, id)`; `supplier_price_entries.(tenant_id, supplier_id)
-> suppliers(tenant_id, id)` AND `(tenant_id, supplier_id,
supplier_item_link_id) -> supplier_item_links(tenant_id, supplier_id, id)`
(the D-16-style extra key that structurally pins a price entry's
`supplierId` to its own sourcing link's supplier). Proven live against a
real PostgreSQL 16 database (`test/procurement-rls.e2e-spec.ts`, run twice —
once against the persistent lane-d dev DB, once against a from-zero
migrated e2e template DB):

- Tenant A cannot read Tenant B `Supplier` / `SupplierItemLink` /
  `SupplierPriceEntry` (each independently proven, migrator client confirms
  the row genuinely exists).
- Cross-tenant `Supplier` INSERT (tenant_id spoofing) fails closed.
- Cross-tenant `SupplierPriceEntry` INSERT fails closed.
- `SupplierPriceEntry` is append-only: even an **own-tenant** `UPDATE` is
  rejected (no `UPDATE` grant at all, independent of RLS).
- Same-tenant reads/writes succeed; a same-tenant `Supplier` status update
  succeeds.

8/8 RLS tests pass.

## 14. Audit

Every mutation is audited inside the SAME `withAuthContext` transaction as
the write, via `governance/contract`'s `AuditService.record`/`AUDIT_ACTION`/
`AUDIT_ENTITY` (no `AuditModule` import needed — `@Global()`, Kitchen/
Reporting's own precedent). New `AUDIT_ACTION` entries:
`SUPPLIER_CREATED`, `SUPPLIER_UPDATED`, `SUPPLIER_STATUS_CHANGED`,
`SUPPLIER_ITEM_LINK_CREATED`, `SUPPLIER_ITEM_LINK_UPDATED`,
`SUPPLIER_PRICE_ENTRY_CREATED` (no `_UPDATED`/`_CANCELLED` — mirrors
`CASH_CLOSE_POLICY_VERSION_CREATED`'s "every write is a new version" habit).
New `AUDIT_ENTITY` entries: `supplier`, `supplier_item_link`,
`supplier_price_entry`. A rejected mutation (validation failure, FK/unique
violation, exclusion-constraint conflict) throws before `audit.record` is
ever reached, or inside the same transaction that is rolled back — no
partial/false audit entry is possible by construction. Verified live:
successful `POST /procurement/suppliers` and `.../status` and
`.../supplier-price-entries` each produce exactly one matching
`governance.audit_entries` row (`admin.auditEntry.count(...)` assertions in
the e2e suite).

## 15. Procurement public contract

`procurement/contract/procurement-facts.query.ts` publishes
`PROCUREMENT_FACTS_QUERY` (`ProcurementFactsQuery`), implemented privately by
`ProcurementFactsQueryService` and bound in `ProcurementModule`. Three
methods, deliberately narrow (no PO domain vocabulary):
`getSupplierFacts(tx, {tenantId, supplierId})`,
`getSupplierItemSourcing(tx, {tenantId, supplierId, stockItemId})`,
`getEffectivePrice(tx, {tenantId, supplierItemLinkId, purchaseUnitId, at})`.
A future Purchase Order slice can require an active supplier (reading
`status` itself), snapshot supplier facts, validate sourcing, and resolve an
effective price — all without importing `SuppliersService`/`SourcingService`/
`PricingService` or querying `procurement.*` tables directly.

## 16. Tests

**Live this session, against a real PostgreSQL 16 database** (both the
persistent lane-d dev DB at `localhost:5566`, and, for the full e2e suite
run, a from-zero-migrated isolated per-run template database):

- `test/procurement-rls.e2e-spec.ts` — **8/8 passed** (§13).
- `test/procurement-supplier-foundation.e2e-spec.ts` — **18/18 passed**:
  Supplier master (full valid create; duplicate code 409 same tenant, 201
  same code other tenant; invalid currency 400; negative lead
  time/payment-terms 400; inactive supplier preserved+readable+audited),
  Supplier sourcing (multi-supplier-per-item and multi-item-per-supplier;
  cross-tenant stock item 404; supplier-specific code/barcode persisted +
  deterministic preference ordering), Supplier price list (base entry exact
  minor units + 6dp pack size + audited; invalid purchase unit 400;
  currency-mismatch 400; volume tiers validate+persist, reject
  non-increasing thresholds; validFrom/validUntil semantics — future price
  not yet effective, historical price still readable after a newer one;
  ambiguous overlap 409), Comparative pricing (multiple suppliers, ordered
  by preference, inactive supplier excluded, historical `at` honored),
  Permissions (`supplier.manage` mutate success / no-permission 403;
  `purchase.order.create`-only actor can read but not mutate; POS token
  rejected 403 on a back-office-only route).
- `src/modules/module-boundaries.spec.ts` — **46/46 passed**, including the
  whole-tree "records every pre-existing deviation, and no more" assertion
  — `procurement` adds zero entries.
- `src/modules/authorization-coverage.spec.ts` — **9/9 passed**.
- **Full unit suite** (`npx jest`, no DB) — **1229/1229 passed, 89 suites**,
  zero regressions (Inventory's new contract/service included).
- `test/inventory-rls.e2e-spec.ts` not re-run in isolation this session
  (unchanged behaviorally by the new read-only contract addition); the new
  `StockItemPurchasingFactsQueryService` is exercised indirectly by every
  Procurement e2e test that creates a sourcing link or price entry.

## 17. Regressions / boundaries

```
$ npx prisma validate           → schema valid
$ npx prisma generate           → OK
$ npx tsc --noEmit               → clean, zero errors
$ npm run build                  → OK (nest build)
$ npm run openapi:generate       → OK; docs/api/{openapi.json,yaml} diff is
                                    PURELY ADDITIVE (2762 insertions, 0
                                    deletions) — 8 new /procurement/* paths
$ npx eslint --fix <changed files>  → clean, zero remaining errors/warnings
```

Full unit suite and both new e2e suites reported in §16. No unrelated heavy
suite (full E2E) was run, per the mission's explicit instruction.

---

## RETURN

```
START_HEAD: 96ab003062b36c7ee887dc6062f1b27fbd89c9b7

PROCUREMENT_MODULE: src/modules/procurement/ — new bounded context, feature-folder style, matches Kitchen/Reporting's zero-deviation module-boundary pattern.

DATA_MODEL:
SUPPLIER_MODEL: procurement.suppliers — code (unique/tenant), legalName, tradingName?, taxRegistrationNumber?, addresses Json[], contacts Json[], paymentTermsNetDays Int, currency Char(3), deliveryLeadTimeDays Int, minimumOrderValue BigInt, deliveryDays Int[], status SupplierStatus{active,inactive}, timestamps.
SUPPLIER_ITEM_LINK_MODEL: procurement.supplier_item_links — supplierId, stockItemId (recorded Inventory id, no FK), supplierItemCode?, supplierBarcodes String[], preferenceRank SmallInt, isActive Boolean. uq(tenant,supplier,stockItem); uq(tenant,supplier,id) for child composite-FK integrity.
SUPPLIER_PRICE_MODEL: procurement.supplier_price_entries — supplierId, supplierItemLinkId, purchaseUnitId (recorded Inventory id, no FK), packSize Decimal(18,6), unitPrice BigInt, currency Char(3), validFrom/validUntil Timestamptz, volumeTiers Json?. Immutable (SELECT/INSERT-only grant). EXCLUDE USING gist (tenant_id, supplier_item_link_id, purchase_unit_id, tstzrange(valid_from, valid_until) WITH &&).

PAYMENT_TERMS_SHAPE: flat Int column paymentTermsNetDays (semantic {netDays}), no early-settlement-discount semantics invented.
STATUS_MODEL: SupplierStatus enum {active, inactive}; deactivation only via dedicated PATCH .../status route; no hard delete (no DELETE method, no DELETE DB grant).
PRICE_HISTORY_MODEL: append-only rows, validFrom/validUntil half-open window, DB EXCLUDE constraint rejects ambiguous overlap; effective-price resolution validFrom<=at AND (validUntil IS NULL OR at<validUntil).
VOLUME_TIER_MODEL: SupplierPriceEntry.volumeTiers Json? — [{minimumQuantity, unitPriceMinor}], strictly increasing, no dup thresholds, validated at write time; comparative-pricing selects the greatest satisfied tier only when a quantity is supplied.

INVENTORY_CONTRACTS_USED_OR_ADDED: ADDED inventory/contract/purchasing-facts.query.ts (STOCK_ITEM_PURCHASING_FACTS_QUERY) — stock item existence/active + base-unit + packaging-unit facts. No pre-existing Inventory stock-item/UOM query contract existed before this slice.
PROCUREMENT_PUBLIC_CONTRACT: procurement/contract/procurement-facts.query.ts (PROCUREMENT_FACTS_QUERY) — getSupplierFacts, getSupplierItemSourcing, getEffectivePrice. For the future Purchase Order slice; zero PO vocabulary.

HTTP_ROUTES: POST/GET/PATCH suppliers[,/:id,/:id/status]; POST/GET/PATCH supplier-item-links[,/:id]; POST/GET supplier-price-entries[,/effective]; GET comparative-pricing. No DELETE anywhere.
PERMISSIONS: supplier.manage (SRS §15.2, newly seeded) on every mutation; RequireAnyPermission(supplier.manage, purchase.order.create) on every read (purchase.order.create referenced as a literal, NOT seeded by this module). tenantTarget(...) B1-3 declaration on every route. No @AllowPosSession anywhere.

RLS: ENABLE+FORCE on all 3 tables; select/insert/update policies on suppliers & supplier_item_links; select/insert-only on supplier_price_entries (matches its append-only grant). Fail-closed on missing/foreign tenant context (NULLIF(...)::uuid).
COMPOSITE_FKS: supplier_item_links.(tenant_id,supplier_id)->suppliers(tenant_id,id); supplier_price_entries.(tenant_id,supplier_id)->suppliers(tenant_id,id) AND (tenant_id,supplier_id,supplier_item_link_id)->supplier_item_links(tenant_id,supplier_id,id).
AUDIT: governance/contract AuditService, in the same transaction as every mutation. New AUDIT_ACTION: SUPPLIER_CREATED/UPDATED/STATUS_CHANGED, SUPPLIER_ITEM_LINK_CREATED/UPDATED, SUPPLIER_PRICE_ENTRY_CREATED. New AUDIT_ENTITY: supplier, supplier_item_link, supplier_price_entry.

COMPARATIVE_PRICING: GET /procurement/comparative-pricing — active links + active suppliers only, ordered preferenceRank asc then supplierCode asc then purchaseUnitId asc, at instant `at` (default now), optional quantity selects the greatest-satisfied volume tier.
CURRENCY_HANDLING: currencyOf() (ISO-4217 shape+exponent) validated on every Supplier currency write; a price entry's currency must equal its supplier's currency at creation (400 otherwise); an entry's own currency is pinned forever after creation; comparative pricing never numerically compares amounts across currencies.
HISTORICAL_PRICE_RESOLUTION: validFrom<=at AND (validUntil IS NULL OR at<validUntil), enforced deterministic-unique by the DB EXCLUDE constraint; ambiguous overlap is a 409, never "latest created wins."

FR_PRC_005_STATUS: COMPLETE
FR_PRC_006_STATUS: COMPLETE
FR_PRC_007_STATUS: COMPLETE
FR_PRC_008_STATUS: PARTIAL (history COMPLETE; receipt-time variance alert remains deferred to the PRC Receiving slice — Goods Receipt does not exist)
FR_INV_005_STATUS: COMPLETE (supplier-specific item codes/barcodes implemented and queryable through SupplierItemLink)

MODULE_GRAPH: procurement -> identity/contract, procurement -> inventory/contract, identity/authz/permission-catalog -> procurement/contract (permission defs), src/scripts/seed-dev-data.ts -> procurement.permissions (dev seed parity). No other module imports procurement (no consumer exists yet — PO is the next slice).
KNOWN_DEVIATIONS_ADDED: none (module-boundaries.spec.ts whole-tree assertion passed unchanged: 46/46).

TESTS: 8/8 RLS (test/procurement-rls.e2e-spec.ts) + 18/18 functional/permission/audit (test/procurement-supplier-foundation.e2e-spec.ts), both live against real Postgres 16. Full unit suite 1229/1229 (89 suites), zero regressions. module-boundaries 46/46. authorization-coverage 9/9.
PRISMA_VALIDATE: clean
TYPECHECK: clean (tsc --noEmit, zero errors)
BUILD: clean (nest build)
OPENAPI: regenerated, purely additive diff (2762 insertions / 0 deletions), 8 new /procurement/* paths
LINT: clean (eslint --fix on every changed/new file, zero remaining errors)

FILES_CHANGED: see `git diff --stat` at commit time (new: prisma migration 20260910122221_procurement_supplier_foundation; ~20 new src/modules/procurement/* and src/modules/inventory/* files; edits to prisma/schema.prisma, src/app.module.ts, src/modules/governance/audit/audit.constants.ts, src/modules/identity/authz/permission-catalog.ts, src/modules/inventory/{inventory.module.ts,contract/index.ts}, src/scripts/seed-dev-data.ts, docs/api/{openapi.json,yaml}; new test/procurement-rls.e2e-spec.ts, test/procurement-supplier-foundation.e2e-spec.ts).
IMPLEMENTATION_COMMIT: recorded in a follow-up docs-only commit per repository convention (see INDEX.md entry / follow-up commit hash).
REPORT_HASH_COMMIT_IF_ANY: pending (one docs-only hash-record follow-up, per repository convention).

SUPPLIER_FOUNDATION_CLOSED: yes, for FR-PRC-005/006/007 and the FR-INV-005 sourcing-identifier portion. FR-PRC-008 remains PARTIAL by design (receiving not built).
SAFE_TO_START_POS_ORDER_CANCELLATION: yes — this task did not touch Sales/Orders/POS in any way; zero files under src/modules/sales/ were read or modified.
BLOCKERS_OR_UNCERTAINTIES: none discovered that required a STOP. One documented judgment call: `purchase.order.create` is referenced as a permission-guard literal but deliberately not seeded (owned by the future PO slice) — the OR-guard is proven functional in the e2e suite by having the test seed the code itself, simulating that slice's eventual arrival.
```
