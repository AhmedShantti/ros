# Full API Surface — OpenAPI/DTO/Schema Audit and Correction

**Report type:** API-contract quality audit and correction. Documentation-only:
no domain/workflow/permission/transaction/persistence semantics changed, no
migration, no governance reopened.

**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative. It records the
result of a mechanical, source-derived audit of the entire current HTTP API
surface against the generated OpenAPI document, and the narrow corrections
applied — it does not adjudicate requirement status or governance.

**Date:** 2026-09-01

**HEAD at start:** `02fd05a782f7638e375b5418ad7c8775b0e2466f` (`feat: add day close`)

**Branch:** `feat/production-spec`

**Working tree at start:** exactly the 4 expected pre-existing historical
reports (untracked) + their 4 `INDEX.md` rows (modified) — verified via
`git diff` line-count before any work began (only 4 `+` lines in the
`INDEX.md` diff, each matching one of the 4 untracked files).

**Task identifier:** ROS — FULL API SURFACE OPENAPI/DTO/SCHEMA AUDIT + CORRECTION

---

## 1. Baseline verification

```
git rev-parse HEAD            → 02fd05a782f7638e375b5418ad7c8775b0e2466f
git branch --show-current     → feat/production-spec
git status --short --untracked-files=all →
  M kitchen-kit/backend/docs/reports/claude/INDEX.md
  ?? kitchen-kit/backend/docs/reports/claude/2026-08-26_MVP_current-state-and-next-slice.md
  ?? kitchen-kit/backend/docs/reports/claude/2026-08-27_RENDER_empty-db-demo-provisioning-check.md
  ?? kitchen-kit/backend/docs/reports/claude/2026-08-28_P1G1_cash-close-design-gate.md
  ?? kitchen-kit/backend/docs/reports/claude/2026-08-28_POST-P1F2_MVP_next-slice-rebase.md
```

Matches the expected baseline exactly. `INDEX.md`'s diff was inspected line
by line: exactly 4 added (`+`) content lines, one per untracked report, no
other content changed. No pre-existing source/test/OpenAPI/schema/migration/
governance drift found. Proceeded.

---

## 2. Endpoint inventory — derived mechanically from source

Searched every file matching `src/**/*.controller.ts` (16 files) for
`@Controller`/`@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` decorators, resolved
each route's controller prefix + method path, normalized `:param` → `{param}`,
and built one canonical `METHOD /full/path` identity per operation.

**Controllers found (16):** `health.controller.ts`,
`catalogue.controller.ts`, `identity/auth/auth.controller.ts`,
`identity/authz/rbac.controller.ts`, `identity/password/password.controller.ts`,
`identity/tenants/tenant.controller.ts`, `identity/terminals/terminal.controller.ts`,
`inventory.controller.ts`, `kitchen.controller.ts`, `organisation.controller.ts`,
`production.controller.ts`, `reporting.controller.ts`, `orders.controller.ts`,
`treasury/cash-close-policy.controller.ts`, `treasury/day-close.controller.ts`,
`treasury.controller.ts`.

**Total source routes: 151.**

## 3. Source vs generated OpenAPI cross-check

Built an independent `METHOD + path` inventory from `docs/api/openapi.json`
(`.paths` keys × HTTP-method keys): **151 operations.**

Diffed the two normalized, sorted lists (Python script, byte comparison):

```
$ diff source_routes.txt openapi_routes.txt
IDENTICAL - NO MISMATCHES
```

**Classification: 151/151 Class A (source route + OpenAPI operation).
Zero Class B (missing from OpenAPI), zero Class C (OpenAPI operation with no
source route), zero Class D (duplicate/ambiguous).** No unexplained mismatch.

---

## 4. Module-by-module endpoint counts

| Module | Endpoints |
|---|---|
| Identity | 23 |
| Organisation | 31 |
| Governance | 0 (no HTTP controller — Governance is exposed only via other modules' permission codes/audit trail, confirmed no `governance.controller.ts` or route prefix exists) |
| Catalogue | 38 |
| Sales | 7 |
| Treasury | 10 |
| Inventory | 22 |
| KDS (Kitchen) | 6 |
| Reporting | 1 |
| Other — Production | 12 |
| Other — Health | 1 |
| **TOTAL** | **151** |

---

## 5. BEFORE defect metrics

A mechanical scanner (Python, walking every `paths[*][method]` in the
generated `docs/api/openapi.json`, resolving `$ref`s against
`components.schemas`) was built and run against the pre-correction document
to classify every response/request schema as empty, untyped-object,
untyped-array, or missing entirely. Every finding was then manually verified
against the actual controller/service/view source before being counted as a
real defect — the scanner's raw output (70 hits) included many **false
positives** for fields that are genuinely opaque, dynamically-shaped JSON
columns (localized-name objects, address/theme/capacityConfig blobs) that
the repository already documents correctly with a `description` explaining
the opacity (`schema-helpers.ts` consumers across
catalogue/organisation/inventory) — those are not defects and are recorded
as such below, not fixed.

```
TOTAL HTTP ENDPOINTS:                151
TOTAL JSON SUCCESS OPERATIONS:       139   (151 − 12 genuinely bodyless 204s)
SUCCESS-SCHEMA COMPLETE:             130
SUCCESS-SCHEMA DEFECTIVE:            9     (real) + 0 confirmed-false-positive (opaque JSON, already documented)
REQUEST-BODY OPERATIONS:             79 (POST/PUT/PATCH with an actual @Body(), i.e. a real `requestBody` in the document)
REQUEST-SCHEMA DEFECTIVE:            0    (every real request-body operation already had a concrete DTO-class-derived schema)
BROKEN REFS:                         0    (existing `every $ref resolves` test already covers this; confirmed clean)
EMPTY SCHEMAS:                       0    (no `schema: {}` found anywhere)
UNTYPED STRUCTURES (real defects):   0    (all "untyped object" scanner hits were the documented-opaque-JSON convention, not defects)
UNION DEFECTS:                       1    (DayClose POST ACTIVATED/CLOSED had no schema at all — see below)
FORMAT DEFECTS:                      104 UUID/businessDay path-parameter instances lacked a `format` keyword despite the identical field carrying one in response bodies via `uuidSchema()`/`businessDaySchema()`, plus 2 `version` path parameters typed `number` instead of `integer`
```

### 5a. The 9 real MISSING_SUCCESS_RESPONSE_SCHEMA defects

| # | Method | Path | Module | Classification |
|---|---|---|---|---|
| 1 | GET | `/branches/{branchId}/day-closes/{businessDay}` | Treasury | MISSING_SUCCESS_RESPONSE_SCHEMA |
| 2 | POST | `/branches/{branchId}/day-closes/{businessDay}` | Treasury | MISSING_SUCCESS_RESPONSE_SCHEMA + UNION_NOT_REPRESENTED (ACTIVATED/CLOSED) |
| 3 | GET | `/kds/stations/{stationId}/queue` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA |
| 4 | POST | `/kds/stations/{stationId}/tickets/view` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA |
| 5 | POST | `/kds/tickets/{ticketId}/bump-all` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA |
| 6 | POST | `/kds/tickets/{ticketId}/lines/{lineId}/bump` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA |
| 7 | POST | `/kds/tickets/{ticketId}/lines/{lineId}/start` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA |
| 8 | POST | `/kds/tickets/{ticketId}/recall` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA |
| 9 | GET | `/reports/branches/{branchId}/daily-trading/{businessDay}` | Reporting | MISSING_SUCCESS_RESPONSE_SCHEMA |

All 9 had `@ApiOkResponse({ description: '...' })` with **no `schema`
property at all** — Swagger UI/generated clients would see these operations
as returning an undocumented, unstructured 200, despite the `description`
text itself naming rich structured fields (e.g. Reporting's:
"salesSummary, tenderTotals (incl. completedExcessCapturedTotal),
taxSummary, cashReconciliation..."). Confirmed by direct inspection of
`docs/api/openapi.json` (`responses."200"` had only a `description` key, no
`content`).

### 5b. Verified bodyless routes (not defects) — 12

Every one of the following returns `Promise<void>` at the handler level
(confirmed by reading the controller source directly, not inferred) and is
documented `204 No Content` with no `content` block — correct, not a defect.
See §11 for the full per-route allowlist with reasons.

### 5c. Requestbody "MISSING_REQUEST_BODY" scanner hits — all false positives

The scanner flagged 8 POST operations with no `requestBody` at all
(`/auth/logout`, `/inventory/counts/{sessionId}/post`,
`/kds/tickets/{ticketId}/bump-all`,
`/kds/tickets/{ticketId}/lines/{lineId}/bump`,
`/kds/tickets/{ticketId}/lines/{lineId}/start`,
`/kds/tickets/{ticketId}/recall`, `/orders/{businessDay}/{id}/fire`,
`/recipes/{recipeId}/versions/{version}/publish`). Each was checked against
its controller handler: **none declares a `@Body()` parameter** — they are
genuinely bodyless POSTs (state derived entirely from path params/session
context), so the absence of `requestBody` in OpenAPI is correct, not a
defect.

### 5d. Path-parameter format defect — systemic, all 151 endpoints with a path parameter

Every UUID-shaped or `businessDay` path parameter across the entire API
(`branchId`, `brandId`, `categoryId`, `centralKitchenId`, `groupId`, `id`,
`itemId`, `lineId`, `membershipId`, `menuId`, `modifierId`, `priceListId`,
`recipeId`, `roleId`, `ruleId`, `sessionId`, `stationId`, `tableId`,
`terminalId`, `ticketId`, `variantId`, `warehouseId`, `businessDay`) was
generated by `@nestjs/swagger`'s CLI plugin as a bare `{type: 'string'}`
with **no `format`** — while the identical field in every response body
already carries `format: 'uuid'` / `format: 'date'` via the existing
`uuidSchema()`/`businessDaySchema()` helpers (443 existing `format: "uuid"`
occurrences in response bodies at baseline). `version` (Production recipe
version, `ParseIntPipe`-backed) was `type: 'number'` instead of the more
precise `integer`. Classified **MISSING_PATH_PARAMETER_SCHEMA /
INCORRECT_FORMAT**, root cause **"CLI plugin infers path params from the
bare Express/TS parameter type, which carries no wire-shape information"**
(§13 root-cause category).

---

## 6. Root-cause categories

| Root cause (§13 taxonomy) | Defect family | Endpoints affected |
|---|---|---|
| Controller response decorator has description only, no `schema` | MISSING_SUCCESS_RESPONSE_SCHEMA | 9 (§5a) |
| CLI plugin infers path params from the bare Express/TS param type (no wire-shape info) | MISSING_PATH_PARAMETER_SCHEMA / INCORRECT_FORMAT / INCORRECT_PRIMITIVE | 104 UUID/businessDay path-parameter instances + 2 `version` path parameters across the API |
| (verified NOT a defect) opaque JSON columns already documented via `description` | — | localized-name/address/theme/capacityConfig fields (catalogue/organisation/inventory) |
| (verified NOT a defect) genuinely bodyless `Promise<void>` handlers | — | 12 (§5b) |
| (verified NOT a defect) genuinely bodyless POST with no `@Body()` | — | 8 (§5c) |

No `INCORRECT_REQUIREDNESS`, `INCORRECT_NULLABILITY`, `INCORRECT_ENUM`,
`BROKEN_REF`, `EMPTY_SCHEMA`, or `WIRE_SCHEMA_MISMATCH` defects were found
anywhere in the 151-operation surface — the existing `test/openapi.e2e-spec.ts`
suite (32 tests at baseline) already asserts money-as-string, nullable
JSON-Schema-2020-12 unions, nullable-enum, path-param existence, security
metadata, and the shared `ErrorResponse` schema on representative routes,
and passed clean at baseline; the exhaustive sweep added in this task (§9)
confirms this holds for the **entire** surface, not just the sampled routes.

---

## 7. Files changed

| File | Change |
|---|---|
| `src/modules/kitchen/kitchen.controller.ts` | Added 8 inline response schemas (`ticketCardModifierSchema`, `ticketCardLineSchema`, `ticketCardSchema`, `stationQueueSchema`, `acknowledgeViewedResultSchema`, `ticketAndLineResultSchema`, `bumpAllResultSchema`, `recallResultSchema`); wired into the 6 KDS endpoints' `@ApiOkResponse` |
| `src/modules/treasury/day-close/day-close.controller.ts` | Added `dayCloseViewSchema` (the full Z-snapshot) and `dayClosePostResultSchema` (flattened ACTIVATED/CLOSED, following the same established convention as `treasury.controller.ts`'s `declareCloseResponseSchema`); wired into GET/POST |
| `src/modules/reporting/reporting.controller.ts` | Added `dailyTradingReportSchema` (+ `tenderFamilyTotalsSchema` helper); wired into the daily-trading GET |
| `src/common/openapi/oas31.util.ts` | Added `enrichPathParameterSchemas` — a third document-level finalization pass (alongside the existing `nullable`-rewrite and `ErrorResponse`-fill passes) that adds `format: uuid`/`format: date`/`type: integer` to path parameters, driven by an exhaustive, manually-verified name list — not a blind heuristic |
| `test/openapi.e2e-spec.ts` | Added 4 new tests deriving the full operation inventory from the document itself (§9) |
| `docs/api/openapi.json` / `docs/api/openapi.yaml` | Regenerated via `npm run openapi:generate` (canonical script; never hand-edited) |

No runtime (non-OpenAPI) source file was touched. No DTO used for request
*validation* was changed — only inline Swagger response-schema constants and
one document-level post-processing pass.

---

## 8. DTO / component mapping

This codebase's established convention for **interface-typed** service
return values (not class-based DTOs) is an inline `const xSchema = {...}`
object built from `src/common/openapi/schema-helpers.ts` helpers
(`uuidSchema`, `moneyStringSchema`, `decimalStringSchema`,
`businessDaySchema`, `isoDateTimeSchema`, `nullable`), wired via
`@ApiOkResponse({ schema: xSchema })` — used throughout
`catalogue.controller.ts`, `organisation.controller.ts`,
`inventory.controller.ts`, and `treasury.controller.ts` already. Per
CLAUDE.md/task §14 ("reuse repository conventions"), the 9 new schemas
follow this same convention rather than introducing a second,
class-based (`@ApiExtraModels`/`getSchemaPath`) pattern alongside it —
request-body validation DTOs (real classes, e.g. `CreateBrandDto`,
`PostDayCloseDto`) were untouched; this task only added **response**-side
documentation for shapes that were already real, already-typed TypeScript
interfaces (`TicketCardDto`, `DayCloseView`, `DailyTradingReportView`, etc.)
with no `@ApiProperty` metadata reachable at runtime (interfaces are erased
by `tsc`).

New inline schema constants (9, all response-only):

- `kitchen.controller.ts`: `ticketCardModifierSchema`, `ticketCardLineSchema`, `ticketCardSchema`, `stationQueueSchema`, `acknowledgeViewedResultSchema`, `ticketAndLineResultSchema`, `bumpAllResultSchema`, `recallResultSchema`
- `day-close.controller.ts`: `dayCloseViewSchema`, `dayClosePostResultSchema`
- `reporting.controller.ts`: `dailyTradingReportSchema`, `tenderFamilyTotalsSchema`

Each was built by reading the actual serializing service/view source
directly (`ticket-reader.types.ts`'s `TicketCardDto`/`TicketCardLineDto`/
`TicketCardModifierDto`/`StationQueueDto`; `kds-operations.service.ts`'s
per-method `Promise<...>` return types; `day-close.service.ts`'s
`DayCloseView`/`DayClosePostResult`; `daily-trading-report.service.ts`'s
`DailyTradingReportView`) — never against the Prisma schema or the SRS, per
existing repository convention (every schema constant carries a comment
naming its source of truth).

**Union representation (DayClose POST):** the task text (§10) prefers
`oneOf` for a real discriminated union. This repository already has an
established precedent for the exact same shape — a state-dependent
Treasury response with a real discriminator property
(`treasury.controller.ts`'s `declareCloseResponseSchema`/
`finalizeCloseResponseSchema`, `status`/`outcome` enum plus per-field
"present only once status is X" descriptions, not `oneOf`). `dayClosePostResultSchema`
follows that established sibling-module precedent for internal consistency
rather than introducing `oneOf` as a second, inconsistent pattern for the
same kind of response within Treasury.

---

## 8a. Full per-endpoint before/after table (all 151 operations)

| METHOD | PATH | MODULE | DEFECT (BEFORE) | RESPONSE FIX | PATH-PARAM FIX |
|---|---|---|---|---|---|
| POST | `/auth/login` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/logout` | Identity | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | n/a (no path params) |
| GET | `/auth/me` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/memberships/{membershipId}/roles` | Identity | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| DELETE | `/auth/memberships/{membershipId}/roles/{roleId}` | Identity | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/auth/password/change` | Identity | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | n/a (no path params) |
| POST | `/auth/password/forgot` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/password/reset` | Identity | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | n/a (no path params) |
| GET | `/auth/permissions` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/pin` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/refresh` | Identity | COMPLETE | n/a | n/a (no path params) |
| GET | `/auth/roles` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/roles` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/roles/{roleId}/permissions` | Identity | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/auth/tenant` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/tenant` | Identity | COMPLETE | n/a | n/a (no path params) |
| GET | `/auth/tenants` | Identity | COMPLETE | n/a | n/a (no path params) |
| GET | `/auth/terminal` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/terminal` | Identity | COMPLETE | n/a | n/a (no path params) |
| GET | `/auth/terminals` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/terminals` | Identity | COMPLETE | n/a | n/a (no path params) |
| POST | `/auth/terminals/{terminalId}/fingerprints` | Identity | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/auth/terminals/{terminalId}/status` | Identity | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/branches/{branchId}/cash-close-policy` | Treasury | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/branches/{branchId}/day-closes/{businessDay}` | Treasury | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/branches/{branchId}/day-closes/{businessDay}` | Treasury | MISSING_SUCCESS_RESPONSE_SCHEMA + UNION_NOT_REPRESENTED | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/cash-sessions` | Treasury | COMPLETE | n/a | n/a (no path params) |
| POST | `/cash-sessions/{sessionId}/close` | Treasury | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/cash-sessions/{sessionId}/close-context` | Treasury | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/cash-sessions/{sessionId}/close/finalize` | Treasury | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/cash-sessions/{sessionId}/pay-in` | Treasury | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/cash-sessions/{sessionId}/pay-out` | Treasury | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/cash-sessions/{sessionId}/safe-drop` | Treasury | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/availability-rules` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| POST | `/catalogue/availability-rules` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| POST | `/catalogue/availability-rules/{ruleId}/86` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/branches/{branchId}/menus` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/catalogue/categories/{categoryId}` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/completeness` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| GET | `/catalogue/items` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| POST | `/catalogue/items` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| GET | `/catalogue/items/{itemId}` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/catalogue/items/{itemId}` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/items/{itemId}/modifier-groups` | Catalogue | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/items/{itemId}/placements` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/items/{itemId}/placements` | Catalogue | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| DELETE | `/catalogue/items/{itemId}/placements/{categoryId}` | Catalogue | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/items/{itemId}/status` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/items/{itemId}/variants` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/items/{itemId}/variants` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/menus` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| POST | `/catalogue/menus` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| GET | `/catalogue/menus/{menuId}` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/catalogue/menus/{menuId}` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/menus/{menuId}/branches` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/menus/{menuId}/branches` | Catalogue | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| DELETE | `/catalogue/menus/{menuId}/branches/{branchId}` | Catalogue | NONE (verified genuinely bodyless — Promise<void>, 204) | Confirmed via source (handler return type); added to explicit bodyless allowlist + test | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/menus/{menuId}/categories` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/menus/{menuId}/categories` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/menus/{menuId}/status` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/modifier-groups` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| POST | `/catalogue/modifier-groups` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| PATCH | `/catalogue/modifier-groups/{groupId}` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/modifier-groups/{groupId}/modifiers` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/modifier-groups/{groupId}/modifiers` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/price-lists` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| POST | `/catalogue/price-lists` | Catalogue | COMPLETE | n/a | n/a (no path params) |
| GET | `/catalogue/price-lists/{priceListId}` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/catalogue/price-lists/{priceListId}/entries` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/price-lists/{priceListId}/entries` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/catalogue/variants/{variantId}/status` | Catalogue | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/health` | Other (Health) | COMPLETE | n/a | n/a (no path params) |
| POST | `/inventory/count-lines/{lineId}` | Inventory | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/inventory/counts` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/counts/{sessionId}/lines` | Inventory | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/inventory/counts/{sessionId}/post` | Inventory | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/inventory/expiring` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/items` | Inventory | COMPLETE | n/a | n/a (no path params) |
| POST | `/inventory/items` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/items/{itemId}` | Inventory | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/inventory/items/{itemId}/base-unit` | Inventory | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/inventory/items/{itemId}/movements` | Inventory | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/inventory/items/{itemId}/reorder-config` | Inventory | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/inventory/levels` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/low-stock` | Inventory | COMPLETE | n/a | n/a (no path params) |
| POST | `/inventory/movements` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/negative-stock` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/reason-codes` | Inventory | COMPLETE | n/a | n/a (no path params) |
| POST | `/inventory/reason-codes` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/reconciliation` | Inventory | COMPLETE | n/a | n/a (no path params) |
| POST | `/inventory/transfers` | Inventory | COMPLETE | n/a | n/a (no path params) |
| POST | `/inventory/transfers/receive` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/inventory/waste` | Inventory | COMPLETE | n/a | n/a (no path params) |
| POST | `/inventory/waste` | Inventory | COMPLETE | n/a | n/a (no path params) |
| GET | `/kds/stations/{stationId}/queue` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/kds/stations/{stationId}/tickets/view` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/kds/tickets/{ticketId}/bump-all` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/kds/tickets/{ticketId}/lines/{lineId}/bump` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/kds/tickets/{ticketId}/lines/{lineId}/start` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/kds/tickets/{ticketId}/recall` | KDS | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/modifiers/{modifierId}/recipe-effects` | Other (Production) | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PUT | `/modifiers/{modifierId}/recipe-effects` | Other (Production) | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/orders` | Sales | COMPLETE | n/a | n/a (no path params) |
| POST | `/orders` | Sales | COMPLETE | n/a | n/a (no path params) |
| GET | `/orders/{businessDay}/{id}` | Sales | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/orders/{businessDay}/{id}/fire` | Sales | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/orders/{businessDay}/{id}/lines` | Sales | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| DELETE | `/orders/{businessDay}/{id}/lines/{lineId}` | Sales | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/orders/{businessDay}/{id}/payments` | Sales | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/branches` | Organisation | COMPLETE | n/a | n/a (no path params) |
| POST | `/org/branches` | Organisation | COMPLETE | n/a | n/a (no path params) |
| GET | `/org/branches/{branchId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/org/branches/{branchId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/org/branches/{branchId}/brand` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/branches/{branchId}/operating-hours` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/org/branches/{branchId}/operating-hours` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/branches/{branchId}/print-routing` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/org/branches/{branchId}/print-routing` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/branches/{branchId}/station-routing-rules` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/org/branches/{branchId}/station-routing-rules` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/branches/{branchId}/stations` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/org/branches/{branchId}/stations` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/org/branches/{branchId}/status` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/branches/{branchId}/tables` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/org/branches/{branchId}/tables` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/brands` | Organisation | COMPLETE | n/a | n/a (no path params) |
| POST | `/org/brands` | Organisation | COMPLETE | n/a | n/a (no path params) |
| GET | `/org/brands/{brandId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/org/brands/{brandId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/central-kitchens` | Organisation | COMPLETE | n/a | n/a (no path params) |
| POST | `/org/central-kitchens` | Organisation | COMPLETE | n/a | n/a (no path params) |
| GET | `/org/central-kitchens/{centralKitchenId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/org/central-kitchens/{centralKitchenId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/stations/{stationId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/org/stations/{stationId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/org/tables/{tableId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/org/warehouses` | Organisation | COMPLETE | n/a | n/a (no path params) |
| POST | `/org/warehouses` | Organisation | COMPLETE | n/a | n/a (no path params) |
| GET | `/org/warehouses/{warehouseId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PATCH | `/org/warehouses/{warehouseId}` | Organisation | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/recipes` | Other (Production) | COMPLETE | n/a | n/a (no path params) |
| POST | `/recipes` | Other (Production) | COMPLETE | n/a | n/a (no path params) |
| GET | `/recipes/requiring-completion` | Other (Production) | COMPLETE | n/a | n/a (no path params) |
| GET | `/recipes/{recipeId}/versions` | Other (Production) | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/recipes/{recipeId}/versions` | Other (Production) | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| PUT | `/recipes/{recipeId}/versions/{version}/lines` | Other (Production) | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| POST | `/recipes/{recipeId}/versions/{version}/publish` | Other (Production) | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/reports/branches/{branchId}/daily-trading/{businessDay}` | Reporting | MISSING_SUCCESS_RESPONSE_SCHEMA | Added concrete inline response schema (schema-helpers.ts convention) | Added format:uuid/date to path params (global oas31.util.ts enrichment) |
| GET | `/substitute-groups` | Other (Production) | COMPLETE | n/a | n/a (no path params) |
| POST | `/substitute-groups` | Other (Production) | COMPLETE | n/a | n/a (no path params) |
| POST | `/substitute-groups/{groupId}/members` | Other (Production) | COMPLETE | n/a | Added format:uuid/date to path params (global oas31.util.ts enrichment) |

## 9. Machine-readable contract audit (OpenAPI test suite additions)

Extended `test/openapi.e2e-spec.ts` (which already had 32 tests covering
`$ref` resolution, security metadata, idempotency/If-Match headers,
money-as-string, nullable JSON-Schema-2020-12 unions, and drift detection
against the live Express route table) with **4 new tests**, each deriving
its check set from `doc.paths` itself — not a hardcoded route list, so a
future route added without a real schema fails automatically:

1. **"every documented 2xx response is either the verified bodyless
   allowlist or carries a concrete JSON schema"** — walks every operation's
   every 2xx response; skips the 12-route allowlist; for everything else,
   requires `application/json` content, a non-empty schema, no
   underspecified bare `{type:'object'}` (unless it carries a `description`
   — the repo's existing signal for genuinely opaque JSON), and no
   untyped-`items` array.
2. **"every allowlisted bodyless route is genuinely 204 and carries no
   content"** — cross-checks the allowlist itself against the document (204
   status, no `content` key).
3. **"every write operation (POST/PUT/PATCH) that declares a requestBody
   gives it a concrete application/json schema"** — same completeness check
   for request bodies.
4. **"every operation carries a concrete schema for its documented
   400/401/403/404/409/422 error responses"** — confirms every declared
   error status resolves to a real schema (in practice always the shared
   `ErrorResponse` component).

**Proof these are not vacuous:** the pre-correction `docs/api/openapi.json`
(the file at `HEAD`, before this task's edits) was temporarily restored and
the 4 new tests re-run against it:

```
FAIL — "every documented 2xx response is either the verified bodyless
allowlist or carries a concrete JSON schema"
  - Expected  -  1
  + Received  + 11
  +   "GET /branches/{branchId}/day-closes/{businessDay} 200: no application/json content",
  +   "POST /branches/{branchId}/day-closes/{businessDay} 200: no application/json content",
  +   "GET /kds/stations/{stationId}/queue 200: no application/json content",
  +   "POST /kds/stations/{stationId}/tickets/view 200: no application/json content",
  +   "POST /kds/tickets/{ticketId}/bump-all 200: no application/json content",
  +   "POST /kds/tickets/{ticketId}/lines/{lineId}/bump 200: no application/json content",
  +   "POST /kds/tickets/{ticketId}/lines/{lineId}/start 200: no application/json content",
  +   "POST /kds/tickets/{ticketId}/recall 200: no application/json content",
  +   "GET /reports/branches/{branchId}/daily-trading/{businessDay} 200: no application/json content",
Test Suites: 1 failed | Tests: 1 failed, 33 skipped (fail-fast), 2 passed
```

— exactly the 9 real defects found in §5a, nothing else. The fixed artifact
was then restored and the full suite re-run clean (36/36). This demonstrates
the new tests fail in the BEFORE state for the defects found and pass after
correction, per task §29.

---

## 10. Focused module regression tests

| Suite | Result |
|---|---|
| `test/openapi.e2e-spec.ts` (NODE_OPTIONS=--experimental-vm-modules) | **36/36 passed** (32 pre-existing + 4 new) |
| Unit — `src/modules/kitchen`, `src/modules/reporting`, `src/modules/treasury/day-close` | **41/41 passed**, 4/4 suites |
| Full unit suite (`npx jest`) | **797/797 passed**, 59/59 suites |
| `src/modules/module-boundaries.spec.ts` | **45/45 passed** — matches the previously-accepted baseline exactly; zero new `KNOWN_DEVIATIONS` (Swagger-only DTO work introduced no cross-module import) |

---

## 11. Bodyless-response allowlist (§25) — exactly 12 routes

Every route below returns `Promise<void>` at the handler level (verified by
reading the controller source, not inferred) and is documented `204 No
Content` with no body:

| Method | Path | Handler return type (verified) |
|---|---|---|
| POST | `/auth/logout` | `Promise<void>` (`auth.controller.ts`) |
| POST | `/auth/memberships/{membershipId}/roles` | `Promise<void>` (`rbac.controller.ts`) |
| DELETE | `/auth/memberships/{membershipId}/roles/{roleId}` | `Promise<void>` (`rbac.controller.ts`) |
| POST | `/auth/password/change` | `Promise<void>` (`password.controller.ts`) |
| POST | `/auth/password/reset` | `Promise<void>` (`password.controller.ts`) |
| POST | `/auth/roles/{roleId}/permissions` | `Promise<void>` (`rbac.controller.ts`) |
| POST | `/auth/terminals/{terminalId}/fingerprints` | `Promise<void>` (`terminal.controller.ts`) |
| POST | `/catalogue/items/{itemId}/modifier-groups` | `Promise<void>` (`catalogue.controller.ts`) |
| POST | `/catalogue/items/{itemId}/placements` | `Promise<void>` (`catalogue.controller.ts`) |
| DELETE | `/catalogue/items/{itemId}/placements/{categoryId}` | `Promise<void>` (`catalogue.controller.ts`) |
| POST | `/catalogue/menus/{menuId}/branches` | `Promise<void>` (`catalogue.controller.ts`) |
| DELETE | `/catalogue/menus/{menuId}/branches/{branchId}` | `Promise<void>` (`catalogue.controller.ts`) |

This exact list is now also asserted mechanically by the new
`test/openapi.e2e-spec.ts` test #2 (§9) — a future route incorrectly added
to/removed from this set fails the test.

---

## 12. AFTER global metrics

```
MISSING SUCCESS SCHEMA:        0   (was 9)
MISSING REQUEST SCHEMA:        0   (was 0 real; 8 false positives resolved as legitimately bodyless)
BROKEN REFS:                   0   (unchanged)
EMPTY KNOWN-STRUCTURE SCHEMA:  0   (unchanged)
UNTYPED KNOWN ARRAYS:          0   (unchanged)
KNOWN UNION DEFECTS:           0   (was 1 — DayClose POST)
PATH-PARAM FORMAT/PRIMITIVE DEFECTS: 0   (was 104 format + 2 primitive — global oas31.util.ts enrichment; verified via re-scan)
```

Route set: **151 before → 151 after, byte-identical set** (verified by
sorted-list diff). Component schemas: **82 before → 82 after, unchanged**
(directly verified: `jq '.components.schemas | keys | length'` on both the
`HEAD` artifact and the regenerated one). The 12 new response schemas
(§8) are inline `schema:` blocks on their `@ApiOkResponse` decorators, not
`components.schemas` entries — matching the existing
`cashSessionSchema`/`brandSchema`/`stockItemSchema` inline convention, so
`components.schemas` count is unaffected by this task; all growth is
confined to the inline schema bodies themselves and to the 106 path
parameters gaining a `format`/`example`/`type` key.

---

## 13. Full end-to-end verification

**Scratch DB:** `ros_scratch_openapi_audit`, created inside the project's
own `docker-compose.yml` Postgres 16 container (started fresh this session;
was not running at session start — the named volume `ros-pgdata` already
held prior sessions' scratch databases, confirming it is the project's
standing dev-DB volume, not touched destructively). The persistent `ros`
database itself was never connected to for any write in this task.

```
$ DATABASE_URL=...ros_scratch_openapi_audit npx prisma migrate deploy
35 migrations found in prisma/migrations
All migrations have been successfully applied.

$ npx prisma migrate status
Database schema is up to date!
```

**35/35 migrations from zero** — matches the expected baseline exactly (no
migration added/removed/edited by this task).

```
$ DATABASE_URL=...scratch APP_DATABASE_URL=...scratch \
  NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json
Test Suites: 63 passed, 63 total
Tests:       1124 passed, 1124 total
```

**1124/1124, 63/63 suites** — previous accepted baseline was 1120/1120,
63/63 suites; the +4 is exactly the new OpenAPI completeness tests added in
§9. 100% pass, zero exclusions. (The `ERROR` log lines visible during the
run are deliberately-injected test-double failures proving transaction
rollback behavior in `cash-session-close`/`kds-first-viewed`/`day-close`
e2e specs — expected output, not real failures.)

Scratch database dropped after verification:

```
$ psql ... -c "DROP DATABASE ros_scratch_openapi_audit;"
DROP DATABASE
```

Confirmed via `SELECT datname FROM pg_database WHERE datname LIKE 'ros%'` —
`ros_scratch_openapi_audit` no longer present; `ros` and all
pre-existing historical scratch databases from prior sessions untouched.

---

## 14. Static quality

```
$ npx prisma validate          → valid
$ npx nest build                → clean (part of npm run openapi:generate)
$ npx tsc --noEmit               → 1 PRE-EXISTING error (src/modules/identity/auth/access-token.service.spec.ts,
                                    unrelated file, not touched by this task) — ZERO NEW ERRORS
$ git diff --check               → clean
$ npx eslint <5 changed files>   → 0 errors, 0 warnings (3 prettier formatting issues
                                    in the new test file were auto-fixed via --fix and
                                    re-verified clean)
```

Changed files (5): `src/common/openapi/oas31.util.ts`,
`src/modules/kitchen/kitchen.controller.ts`,
`src/modules/treasury/day-close/day-close.controller.ts`,
`src/modules/reporting/reporting.controller.ts`,
`test/openapi.e2e-spec.ts`.

---

## 15. OpenAPI generation

```
$ npm run openapi:generate
Wrote docs/api/openapi.json
Wrote docs/api/openapi.yaml
```

Determinism re-verified this session (ran twice consecutively, byte-diffed
— identical). Route set unchanged (151→151, identical sorted list — no
unrelated route disappearance). Diff stat: `docs/api/openapi.json` +
`openapi.yaml` — 5908 insertions / 955 deletions total across both files
(schema/component growth from the 9 new response schemas + 106 path-param
format additions; no route removed).

---

## 16. Requirement / governance classifications

**Not touched, not reclassified.** This task made zero changes to
`prisma/schema.prisma`, zero migrations, zero permission/RBAC code, zero
workflow logic, and zero governance register edits. All previously accepted
classifications stand exactly as before this task, including:

- DayClose: FR-FIN-020 COMPLETE, FR-FIN-021 COMPLETE, FR-FIN-022 PARTIAL,
  FR-FIN-023 COMPLETE, FR-FIN-024 COMPLETE, FR-FIN-025 NOT IMPLEMENTED `[S]`,
  FR-FIN-026 PARTIAL
- Reporting: existing accepted classifications unchanged
- KDS: accepted classifications unchanged
- D-2, P1C-1: unchanged

---

## 17. Runtime contract change count: **ZERO**

No field renamed, added, or removed on the wire. No status code changed. No
nullability/optionality behavior changed. No new outcome variant
introduced. Every schema added or corrected describes an **already-existing**
runtime shape (`TicketCardDto`, `DayCloseView`, `DailyTradingReportView`,
etc., all pre-existing TypeScript interfaces already serialized verbatim by
the already-shipped handlers) — nothing in `src/**/*.service.ts`,
`*.dto.ts` (request validation), or any non-`*.controller.ts`/
`oas31.util.ts`/`*.e2e-spec.ts` file was modified. Full e2e (1124/1124) and
full unit (797/797) suites, run against both the local unit runner and a
from-zero scratch database, confirm zero behavioral regression.

---

## 18. Verdict

**B. FULL API AUDIT CLEAN — DEFECTS FOUND AND FIXED**

9 real `MISSING_SUCCESS_RESPONSE_SCHEMA` defects (KDS ×6, DayClose ×2,
Reporting ×1, including one undocumented discriminated-outcome response)
and 1 systemic `MISSING_PATH_PARAMETER_SCHEMA`/`INCORRECT_FORMAT` defect
(affecting every UUID/businessDay/version path parameter across the API)
were found and corrected, documentation-only, with zero runtime wire
changes, zero DB/migration/governance changes, and full regression evidence
(unit 797/797, module-boundaries 45/45, OpenAPI 36/36, full e2e 1124/1124
on a from-zero scratch DB, all migrations 35/35 clean).
