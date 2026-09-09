# DEMO-TAX-CLASS-BACKEND-P0 — Complete MenuItem Tax Class Integration

**Report type:** Investigation + implementation (model trace, gap analysis,
new branch-scoped read contract, write-time validation, Sales integration
proof, targeted tests, OpenAPI regeneration).

**Authority statement:** This report is non-authoritative evidence. The SRS
(`ROS_SRS_v1.0.pdf`) and ratified governance decisions in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. The
design choices recorded here (new `SELLABLE_TAX_CLASSES_QUERY` Localisation
contract; reuse of the existing `menu.item.read` / `menu.item.manage`
permissions; branch-scoped read, tenant-scoped write validation) are
documented engineering judgment applying the already-ratified C-04 AMENDMENT
(2026-08-20) and SRS §5.4 module-boundary rules — not a new ratification.

**Date:** 2026-09-09

**HEAD at start:** `806bbbefcee660381d72af1754147d3d1cffb0e9`
(`806bbbe` — `feat: add manager cash-session discovery — GET
/branches/:branchId/cash-sessions/open`)

**Branch:** `full-srs/lane-d4-reporting-demo`

**Working tree summary at start:** untracked `.DS_Store` files (unrelated,
untouched) and untracked
`docs/reports/claude/2026-09-08_DEMO-RELEASE-BRANCH-RECOVERY-P0_render-build-break-diagnosis.md`
(prior, unrelated report — untouched). No other changes present before this
task began.

**Task identifier:** `DEMO-TAX-CLASS-BACKEND-P0`

---

## 1. Trace of the current model

### MENU_ITEM_TAX_STORAGE

`catalogue.menu_items.tax_class_id` (`prisma/schema.prisma:1458`) is a real
`UUID` column with a genuine composite foreign key:
`taxClass TaxClass? @relation(fields: [tenantId, taxClassId], references:
[tenantId, id])` (`prisma/schema.prisma:1478`). It is **not** a free-text
field and **not** unvalidated at the database layer — the DB-level FK already
guarantees tenant-safety (ADR 0008 D-09), proven by
`test/tax-class-rls.e2e-spec.ts`'s "refuses a cross-tenant menu item
reference at the DATABASE" case.

### CURRENT_TAXCLASS_MEANING — classification C: materialised identifier

`fiscal.tax_classes` (`prisma/schema.prisma:1541-1569`) is **not** a
jurisdiction-agnostic lookup table and **not** a country-pack row copied
verbatim. Each row is a per-**tenant** materialised identity:
`(tenantId, countryPackCode, code)` unique, with an immutable semantic `code`
that must match a key the active country pack's `tax.classes` map defines
(`TaxClassService.ensureFromPack`,
`src/modules/localisation/tax/tax-class.service.ts:76-112`). It carries `id`,
`tenantId`, `countryPackCode`, `code`, `names` (display label) and
`isActive` — **no rate, no component, no engine configuration** (verified as
an exact column-set assertion in
`test/tax-class-rls.e2e-spec.ts:141-149`). So `MenuItem.taxClassId` is a DB
UUID that **is** a materialised, tenant-scoped representation of a
country-pack semantic code — classification **C**, not A (plain DB UUID with
no semantic meaning), not B (a bare pack code stored directly), not D in the
"data model is broken" sense.

Provisioning already exists and already runs automatically:
`TaxClassProvisioningService.provisionForTenant`
(`src/modules/localisation/tax/tax-class.provisioner.ts`) is called from
`TenantsService.create` and `RegistrationsService` (registration completion)
the moment a tenant's `countryPackCode` is assigned, materialising one
`fiscal.tax_classes` row per pack class. This was already true before this
session — nothing about provisioning changed here.

### SALES_LOOKUP_PATH

`order-lines.service.ts:272-288` (`OrderLinesService.addLine`):

1. `taxClasses.requireForSale(tx, menuItem.id, branch.countryCode)`
   (`src/modules/localisation/tax/tax-class.service.ts:137-183`) loads
   `menuItem.taxClass` and refuses (never defaults) in three cases: no class,
   class belongs to a different jurisdiction than the branch's active pack,
   or class is inactive.
2. `computeLineTax(pack, taxEngines, { taxableBase, taxClassCode:
   taxClass.code, orderType })` (`tax.calculator.ts`) resolves the **rate**
   purely from the pinned `CountryPack.tax.classes` map, keyed by the
   `code` — never from anything stored on `MenuItem` or `TaxClass`.
3. The computed `taxAmount` is snapshotted onto `order_lines.tax_amount`
   (BR-POS-004); the rate itself is never persisted anywhere outside the
   pack document.

### COUNTRY_PACK_TAX_MODEL

`CountryPack.tax.classes: ReadonlyMap<string, TaxClassDef>`
(`country-pack.model.ts:107-143`) — each class carries `code`, `exempt`
(true iff the pack gave `rate: null`), `components` (rate/base/rounding,
empty iff exempt) and an optional `label`. `branch.countryCode -> pack code
-> version effective at transaction time` is the ONLY resolution path
(`CountryPackService.resolveForBranch`,
`country-pack.service.ts:78-91`) — `identity.tenants.country_pack_code` is
deliberately not used for per-sale resolution (FR-BRN-003: two branches of
one tenant may run different packs).

### ROOT_CAUSE

Not a broken data model. The identity model, provisioning and Sales-side rate
resolution are all complete and correct — this is classification **D** in a
narrower sense than "broken model": **incomplete integration at the
boundary a human/admin caller needs**, specifically:

1. **No discovery contract.** `tax-class.port.ts`'s own header states it
   explicitly: *"NO PUBLIC ADMINISTRATION SURFACE — No source defines a
   TaxClass API ... Provisioning is an internal call ... The gap this
   leaves ... is real and is reported rather than papered over with an
   invented endpoint."* A caller creating/updating a `MenuItem` had **no way
   to learn which UUID to send** as `taxClassId`.
2. **No write-time validation.** `MenuItemsService.create`/`update`
   (`menu-items.service.ts`, pre-change) accepted any UUID-shaped string for
   `taxClassId` with zero existence/ownership/active check, relying entirely
   on the raw DB FK — which, unlike `place()`/`linkModifierGroup()` in the
   same service, was **not** caught and translated (no
   `rethrowAsNotFoundOnFk`), so an invalid id would have surfaced as an
   unhandled Prisma FK-violation (effectively a 500), not a clean 4xx.
3. Two stale comments (`catalogue.dto.ts`, `menu-items.service.ts`) still
   read *"Fiscal is out of scope, so this is never resolved"* — leftover
   from before the C-04 AMENDMENT, and misleading about current behaviour.

None of this required touching `TaxClassService`, `CountryPackService`, the
tax calculator, or provisioning — all three were already correct and are
unchanged.

## 2. The gap, precisely

A priced `MenuItem` with `taxClassId: null` reaches Sales because nothing
upstream of the DB FK ever required a value, and nothing ever told a caller
what a *valid* value looks like. `POST /orders/.../lines` then correctly (not
buggy) refuses with *"This item has no tax class and cannot be sold"* — that
refusal is FR-MNU-004/BR-POS-004 working as designed, not a bug to patch
around with a default. The fix is exclusively at the **discovery** and
**write-validation** boundary; the authoritative rate stays exactly where it
already was — the active country pack.

## 3. Backend read contract — NEW

### EXISTING_READ_ENDPOINT

None. `TaxClassLabelsQuery` (pre-existing, `localisation/contract`) resolves
`code`/`countryPackCode` for **already-known** ids for Reporting only — it is
not a discovery/enumeration surface and was deliberately left untouched
(RPT-R1/R2/R3 design-gate scope).

### NEW_ENDPOINT_IF_REQUIRED

`GET /catalogue/branches/:branchId/tax-classes` — mirrors the existing
`GET /catalogue/branches/:branchId/menus` pattern exactly (same
`branchFromParam('branchId')` authorization target, same 404-on-unknown/
foreign-branch semantics).

Backed by a **new Localisation `contract/` publication** — SRS §5.4 requires
every cross-module read to go through `modules/<owner>/contract`, mechanically
enforced by `src/modules/module-boundaries.spec.ts`:

- `src/modules/localisation/contract/sellable-tax-classes.query.ts` —
  `SELLABLE_TAX_CLASSES_QUERY` token, `SellableTaxClassesQuery` interface
  (`listSellableForBranch`, `resolveSellable`), `SellableTaxClass` shape.
- `src/modules/localisation/tax/sellable-tax-classes.query.service.ts` —
  PRIVATE implementation, delegates entirely to the pre-existing
  `CountryPackService.resolveForBranch` + `TaxClassService.listForPackCode` /
  a direct `tenantId`-scoped `taxClass.findFirst`. No new pack-resolution or
  provisioning logic was written.
- Registered/exported in `localisation.module.ts`; consumed by
  `catalogue.module.ts` (which now imports `LocalisationModule` — the FIRST
  `catalogue -> localisation` edge, entirely through `contract/`, verified
  clean by `module-boundaries.spec.ts`).

`listSellableForBranch` resolves the branch's currently-effective pack
exactly as `CountryPackService.resolveForBranch` does (RLS-scoped — a
cross-tenant or unknown branch is indistinguishable, same as
`GET .../menus`) and returns every **active** `fiscal.tax_classes` row for
that pack. `BranchJurisdictionUnknownError` -> `NotFoundException` (404);
`CountryPackUnavailableError` (no activated pack / currency mismatch) ->
`UnprocessableEntityException` (422) — both plain Nest exceptions, so no
Localisation-internal error type crosses the contract boundary.

### PERMISSION

`CATALOGUE_PERMISSIONS.ITEM_READ` (`menu.item.read`) — the SAME existing
read permission every other catalogue read handler already requires. No
permission invented.

### RESPONSE_SHAPE

```json
[
  { "id": "<uuid>", "code": "standard", "names": { "en": "Standard" } }
]
```

Exactly `id` (the value to send back as `MenuItem.taxClassId`), `code`
(immutable semantic key) and `names` (localised label) — no rate, no
component, no engine configuration, no provider secret. Verified as an exact
key-set assertion in the new e2e suite (test A).

## 4. Write validation

### WRITE_VALIDATION_BEFORE

`CreateMenuItemDto`/`UpdateMenuItemDto.taxClassId` was `@IsOptional()
@Matches(UUID_PATTERN)` only — any UUID-shaped string was accepted by the
DTO layer, and `MenuItemsService.create`/`update` persisted it unchecked
(comment: *"recorded only; Fiscal is out of scope so it is never
resolved"*). No existence check, no tenant-ownership check, no active check;
an invalid id would fail only at the raw DB FK, uncaught.

### WRITE_VALIDATION_AFTER

`MenuItemsService` now injects `SELLABLE_TAX_CLASSES_QUERY` and, before
opening the create/update `withAuthContext` transaction (nested
`withAuthContext` calls are unsupported — `prisma.service.ts:51`), calls
`resolveSellable({ tenantId, taxClassId })`. `null` (id not found for this
tenant, OR found but `isActive: false`) -> `BadRequestException` (400) with
message *"taxClassId does not name an active tax class for this tenant."*
Explicit `taxClassId: null` (clearing the field) is preserved as
pre-existing behaviour and is **not** validated (only a truthy value
triggers the check). DTO-level UUID shape validation is unchanged.

## 5. Sales integration — proof, not a new fix

`OrderLinesService`/`TaxClassService.requireForSale`/`computeLineTax` are
**unchanged** — they were already correct (see §1). What this slice adds is
the ability to *reach* that correct path with a valid id in the first place.
Proven end to end:

- **Positive path (new e2e test C):** `POST /catalogue/items` with a
  `taxClassId` returned by the new read endpoint persists it; `GET`/`PATCH`
  round-trip confirmed against the DB row directly.
- **Sales computes tax from the active pack, snapshots on the line, and
  refuses a class-less item** — already fully proven by the pre-existing
  `test/sales-lines.e2e-spec.ts` (untouched by this slice; re-run below as
  regression):
  - "refuses an item with no tax class, and does NOT default to standard"
    (line 926) — mission test **E**.
  - standard-class line: `taxAmount` computed at the pack's 14% rate
    (line 588) — mission tests **F**/**H**.
  - zero-rated class: `taxAmount = '0'` as a **computed** zero, not an
    absent value (lines 1040-1134) — mission test **G**.
  - tax survives a later pack-rate change unchanged on the historical line
    (line 689-733) — proves the snapshot, not a live re-derivation.

No frontend tax computation exists or was added; the rate is resolved
exclusively from the pinned `CountryPack` at line-capture time.

### TAX_ENGINE_SOURCE

`CountryPack.tax` (`tax-engine.registry.ts` + `vat-standard.strategy.ts`),
resolved via `CountryPackService.resolveForBranch`/`requirePinned` — no
country code, rate or tax-class code is compiled into core code anywhere
touched by this slice (CR-03 unchanged).

## 6. Targeted tests

New suite: `test/catalogue-tax-classes.e2e-spec.ts` (12 tests, all passing) —
covers exactly what changed:

| Mission test | Covered by |
|---|---|
| A. authorized actor reads valid tax classes | `A.` — full class list + exact response shape |
| B. unauthorized/cross-branch access denied | `B1` (no permission -> 403), `B2` (foreign tenant's branch -> 404), `B3` (unknown branch -> 404), `B4` (own tenant reading foreign branch -> 404) |
| C. item can persist a valid returned tax-class identifier | `C.` (create), `C2.` (update) |
| D. invalid identifier rejected | `D1.` (random UUID, + positive control without it), `D2.` (real but foreign-tenant id), `D3.` (real but `isActive: false` id), `D4.` (update path) |
| — | "omitting taxClassId still creates the item" — regression guard on unchanged optional-field behaviour |

Mission tests **E/F/G/H** (Sales-side behaviour) are **pre-existing,
unmodified** coverage in `test/sales-lines.e2e-spec.ts` — re-run as
regression below rather than duplicated, per the reporting policy's
instruction to use only evidence actually verified this session and not
re-report old results as new: they were **re-executed in this session**
against the changed code and still pass.

### Regression runs (this session, against the changed tree)

- `test/catalogue-tax-classes.e2e-spec.ts` — **12/12 passed** (new).
- `test/sales-lines.e2e-spec.ts` — **36/36 passed** (tests E/F/G/H
  unaffected; `MenuItemsService`'s new write-time check is not on this
  suite's path — it creates rows via the admin Prisma client directly).
- `test/tax-class-rls.e2e-spec.ts` — **passed** (all cases; provisioning/RLS
  behaviour unchanged).
- `test/catalogue-rls.e2e-spec.ts` — **passed** (all cases).
- `test/catalogue.e2e-spec.ts` — **1 test failed, pre-existing and
  unrelated**: `boundary compliance > no Fiscal / Sales / Procurement
  tables were created` asserts a frozen `workforce`/`treasury` table list
  that predates this session — `workforce.attendance_*`,
  `workforce.schedules`, `workforce.scheduled_shifts`,
  `workforce.clock_events`, `workforce.employee_compensations` exist from
  commit `32a2ba7` (`feat(workforce): add employee scheduling and
  attendance core`), already on `HEAD` before this task started; this
  slice touches neither `workforce` nor that test file. The SAME test's
  Fiscal-schema assertion (`expect(fiscalTables...).toEqual(['tax_classes'])`)
  **passed**, confirming this slice added **no** new Fiscal-schema table.
  All 97 other assertions in that run passed.
- `src/modules/module-boundaries.spec.ts` — **46/46 passed**, confirming
  the new `catalogue -> localisation` edge is clean (contract-only; no
  new `KNOWN_DEVIATIONS` entry required).

## 7. Structured summary

```
MENU_ITEM_TAX_STORAGE: Real DB UUID FK — catalogue.menu_items.tax_class_id
  -> composite (tenantId, id) FK into fiscal.tax_classes. Unchanged this
  session; already correct.

CURRENT_TAXCLASS_MEANING: (C) Materialised identifier — a per-tenant
  fiscal.tax_classes row provisioned from the active country pack's
  semantic class codes; carries id/code/names/isActive, never a rate.

SALES_LOOKUP_PATH: OrderLinesService.addLine -> TaxClassService.
  requireForSale(menuItem.id, branch.countryCode) -> ResolvedTaxClass
  {id, code, countryPackCode} -> computeLineTax(pack, code) -> taxAmount
  snapshotted on order_lines. Unchanged this session; already correct.

COUNTRY_PACK_TAX_MODEL: CountryPack.tax.classes: Map<code, TaxClassDef
  {exempt, components[], label}>, resolved via branch.countryCode -> pack
  code -> version effective at transaction time.

ROOT_CAUSE: (D, narrow sense) No discovery contract for a valid
  MenuItem.taxClassId, and no write-time validation — the identity model,
  provisioning and Sales-side rate resolution were already complete and
  correct.

EXISTING_READ_ENDPOINT: None (TaxClassLabelsQuery resolves known ids for
  Reporting only; not a discovery surface).

NEW_ENDPOINT_IF_REQUIRED: GET /catalogue/branches/:branchId/tax-classes
  (via NEW localisation/contract SELLABLE_TAX_CLASSES_QUERY).

PERMISSION: menu.item.read (CATALOGUE_PERMISSIONS.ITEM_READ) — existing,
  reused, not invented.

RESPONSE_SHAPE: [{ id, code, names }] — no rate/component/engine config.

WRITE_VALIDATION_BEFORE: Any UUID-shaped string accepted, unchecked;
  invalid id failed only at the raw, uncaught DB FK.

WRITE_VALIDATION_AFTER: MenuItemsService.create/update reject (400) any
  non-null taxClassId that does not resolve to an ACTIVE fiscal.tax_classes
  row for this tenant, via SellableTaxClassesQuery.resolveSellable.
  Explicit null (clear) still allowed, unchanged.

SALES_FIX: None needed — Sales integration was already correct; proven,
  not newly fixed, by re-run of test/sales-lines.e2e-spec.ts (E/F/G/H).

TAX_ENGINE_SOURCE: CountryPack.tax (active/pinned pack), unchanged.

TESTS: test/catalogue-tax-classes.e2e-spec.ts 12/12 passed (new, A-D).
  test/sales-lines.e2e-spec.ts 36/36 passed (regression, E-H).
  test/tax-class-rls.e2e-spec.ts passed (regression).
  test/catalogue-rls.e2e-spec.ts passed (regression).
  test/catalogue.e2e-spec.ts 97/98 passed — 1 pre-existing, unrelated
  failure (frozen workforce/treasury table-list guard, predates this
  session; this slice's own fiscal-schema assertion in the same test
  passed).
  src/modules/module-boundaries.spec.ts 46/46 passed (regression).

OPENAPI: npm run openapi:generate — regenerated cleanly; docs/api/
  openapi.json and openapi.yaml updated with the new endpoint and the
  updated taxClassId description (both files diffed, no unrelated drift).

TYPECHECK: npx tsc --noEmit — clean.

BUILD: npm run build — clean (nest build).

BACKEND_FILES_CHANGED:
  NEW  src/modules/localisation/contract/sellable-tax-classes.query.ts
  NEW  src/modules/localisation/tax/sellable-tax-classes.query.service.ts
  NEW  test/catalogue-tax-classes.e2e-spec.ts
  MOD  src/modules/localisation/contract/index.ts
  MOD  src/modules/localisation/localisation.module.ts
  MOD  src/modules/catalogue/catalogue.module.ts
  MOD  src/modules/catalogue/catalogue.controller.ts
  MOD  src/modules/catalogue/catalogue.dto.ts
  MOD  src/modules/catalogue/menu-items/menu-items.service.ts
  MOD  docs/api/openapi.json
  MOD  docs/api/openapi.yaml

BACKEND_COMMIT: `571539b` — "feat(catalogue,localisation): complete
  MenuItem tax-class discovery/validation contract" (not pushed).

SAFE_TO_DEPLOY: Yes, for the backend contract described here. No Prisma
  migration was needed (fiscal.tax_classes already existed). No existing
  route's behaviour changed except: (a) an invalid/inactive taxClassId on
  MenuItem create/update now fails fast with 400 instead of an unhandled
  FK error — a strict tightening, not a behaviour removal; (b) two stale
  comments corrected. The one pre-existing failing test
  (catalogue.e2e-spec.ts workforce/treasury table-list guard) is UNRELATED
  to this change and was already failing on HEAD before this session;
  it should be tracked and fixed separately, not blocking this slice.
```
