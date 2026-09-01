# MINIMUM OPERATIONAL REPORTING — Implementation Report

| Field | Value |
|---|---|
| **Task / slice name** | MINIMUM OPERATIONAL REPORTING — branch daily-trading read surface (implementation) |
| **Report type** | Implementation. Full route/service/contracts/tests built and verified. |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the **ratified** entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the only authorities. This report records what was built and verified; it decides nothing and creates no scope beyond what `RPT-R1`/`RPT-R2`/`RPT-R3` (register entry "Minimum Operational Reporting Ratification — 2026-08-31") already authorised. Governed by `docs/reports/claude/2026-08-31_MINIMUM-reporting-design-gate-acceptance-correction.md`, which supersedes `2026-08-31_MINIMUM-reporting-final-design-gate.md` wherever they differ. |
| **Date** | 2026-08-31 |
| **HEAD** | `38e007b0cd285679fc7fd334aec54d3bf2a8006c` — *feat: complete KDS operator lifecycle* (**unchanged** — verified at start and end of this session) |
| **Branch** | `feat/production-spec` |
| **Working tree** | This slice's contracts/module/tests/OpenAPI, plus the pre-existing documentation-only drift already present at session start (governance register RPT-R1/R2/R3 entry, prior design/ratification reports, and four unrelated pre-existing report files — none touched by this task). |
| **Task identifier** | MINIMUM-reporting-implementation |
| **Status** | COMPLETE |
| **Migrations** | **34 — unchanged. No migration created, modified, or required.** |
| **Tests** | Unit: 792/792 (58 suites), incl. `module-boundaries.spec.ts` 45/45. Reporting e2e: 56/56 across 8 new files. Full e2e on a clean, from-zero scratch database: **1070/1070, 59/59 suites** (see §12). |

---

## §0. VERDICT

> # **A. MINIMUM OPERATIONAL REPORTING IMPLEMENTED — READY FOR ACCEPTANCE REVIEW**

Route `GET /reports/branches/{branchId}/daily-trading/{businessDay}` is live, guarded by both `report.view.sales` and `report.view.financial` (AND), and composes its entire response inside one RepeatableRead transaction. Zero `KNOWN_DEVIATIONS` growth. No migration. OpenAPI regenerated to exactly one new path. Full e2e suite is 100% green from a clean scratch database built from zero via all 34 committed migrations.

---

## §1. BASELINE

```
git rev-parse HEAD           -> 38e007b0cd285679fc7fd334aec54d3bf2a8006c (unchanged)
git branch --show-current    -> feat/production-spec
ls -d prisma/migrations/*/ | wc -l -> 34 (unchanged)
```

No `src/**`, `prisma/schema.prisma`, `prisma/migrations/**`, `test/**`, or `docs/api/openapi.*` drift existed at the start of this task beyond what is itself part of this implementation.

---

## §2. FILES CHANGED

### New

```
src/modules/reporting/reporting.module.ts
src/modules/reporting/reporting.permissions.ts
src/modules/reporting/reporting.controller.ts
src/modules/reporting/reporting.dto.ts
src/modules/reporting/daily-trading-report.service.ts

src/modules/sales/contract/daily-trading-sales.query.ts
src/modules/sales/orders/daily-trading-sales.query.service.ts

src/modules/treasury/contract/daily-cash-reconciliation.query.ts
src/modules/treasury/cash-sessions/daily-cash-reconciliation.query.service.ts

src/modules/organisation/contract/branch-reporting-scope.query.ts
src/modules/organisation/branches/branch-reporting-scope.query.service.ts

src/modules/localisation/contract/tax-class-labels.query.ts
src/modules/localisation/tax/tax-class-labels.query.service.ts

test/reporting-fixtures.ts
test/reporting-authorization.e2e-spec.ts
test/reporting-sales.e2e-spec.ts
test/reporting-tender.e2e-spec.ts
test/reporting-tax.e2e-spec.ts
test/reporting-cash-reconciliation.e2e-spec.ts
test/reporting-period.e2e-spec.ts
test/reporting-currency.e2e-spec.ts
test/reporting-snapshot.e2e-spec.ts
```

### Modified (DI wiring, contract barrels, and the one refactor)

```
src/app.module.ts                                    -- registers ReportingModule
src/modules/sales/contract/index.ts                   -- + daily-trading-sales.query barrel export
src/modules/sales/sales.module.ts                     -- + DAILY_TRADING_SALES_QUERY provider/export
src/modules/sales/orders/business-day.ts              -- + exported cutoverLookup (extract-method)
src/modules/sales/orders/orders.service.ts            -- uses the extracted cutoverLookup
src/modules/treasury/contract/index.ts                -- + daily-cash-reconciliation.query barrel export
src/modules/treasury/treasury.module.ts               -- + DAILY_CASH_RECONCILIATION_QUERY provider/export
src/modules/organisation/contract/index.ts             -- + branch-reporting-scope.query barrel export
src/modules/organisation/organisation.module.ts        -- + BRANCH_REPORTING_SCOPE_QUERY provider/export
src/modules/localisation/contract/index.ts             -- + tax-class-labels.query barrel export
src/modules/localisation/localisation.module.ts        -- + TAX_CLASS_LABELS_QUERY provider/export
src/modules/module-boundaries.spec.ts                  -- + 3 Reporting assertions (§8)
src/scripts/seed-dev-data.ts                           -- + REPORTING_PERMISSION_DEFS / REPORTING_PERMISSIONS wiring
docs/api/openapi.json / docs/api/openapi.yaml          -- regenerated (§13)
```

No file outside this list was touched. `prisma/schema.prisma` and `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are byte-unchanged by this task.

**Note on process:** an earlier attempt at this implementation (a delegated background agent) also reformatted six unrelated pre-existing files (`treasury.controller.ts`, `treasury/contract/events.ts`, `cash-session-close.service.ts`, `cash-sessions.service.ts`, and two pre-existing e2e specs) with pure Prettier line-wrapping and no logic change. That noise was identified by diffing against `HEAD` and fully reverted before proceeding, so none of it appears in the file list above.

---

## §3. PERMISSIONS — RPT-R1

`src/modules/reporting/reporting.permissions.ts` defines exactly:

| Code | Description |
|---|---|
| `report.view.sales` | "View sales reports" |
| `report.view.financial` | "View financial reports" |

Both are required together on the route via `@RequirePermission(REPORTING_PERMISSIONS.VIEW_SALES, REPORTING_PERMISSIONS.VIEW_FINANCIAL)` — the existing `PermissionGuard` default is `mode: 'all'` (AND), so no new authorization capability was added. No `report.export` or other `report.view.*` code exists anywhere in the diff. `src/scripts/seed-dev-data.ts` was extended following the exact established pattern (`REPORTING_PERMISSION_DEFS` added to the `permissions.upsertMany([...])` call; `Object.values(REPORTING_PERMISSIONS)` added to the dev Owner role's permission list) — this is the pre-existing dev-bootstrap convention, not new production role seeding. No standard role is seeded by this task.

---

## §4. REPORTING MODULE

`src/modules/reporting/reporting.module.ts` imports `IdentityModule` (HTTP/auth plumbing only, via `identity/contract`), `SalesModule`, `TreasuryModule`, `OrganisationModule`, `LocalisationModule` (each solely for its published `contract/` token, plus the module import Nest's DI composition requires). It owns zero Prisma models, zero migrations, and is not imported back by any other module (`SalesModule`/`TreasuryModule`'s pre-existing `forwardRef()` cycle between each other is untouched; Reporting sits above both and introduces no new cycle).

---

## §5. ROUTE

```
GET /reports/branches/{branchId}/daily-trading/{businessDay}
```

- No `/v1` prefix (matches the design's dashboard-only routes).
- Guard chain: `JwtAuthGuard` → `TenantContextGuard` → `PermissionGuard`, all from `identity/contract`. No `@AllowPosSession` — a PIN/POS session is refused by `JwtAuthGuard`'s existing default, proven by `reporting-authorization.e2e-spec.ts`.
- `Cache-Control: no-store` set via `@Header(...)`. No `Idempotency-Key`, no `If-Match`, no `ETag`.
- No business audit entry is written for this GET (`FR-AUD-001` binds state-changing operations; this route changes nothing).
- **Zero query parameters, enforced, not merely documented**: `DailyTradingReportQueryDto` declares no properties; bound via `@Query()`, the pre-existing global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` (`src/main.ts`) rejects any supplied query parameter with 400. Proven by `reporting-authorization.e2e-spec.ts`.
- `businessDay`/`branchId` path params are shape-validated by `DailyTradingReportParamsDto` (`@Matches`); a malformed calendar date is separately rejected inside the transaction (`parseBusinessDay` in the controller, mirroring `orders.controller.ts`'s own private helper — a shape validator, never a second business-day *algorithm*).

---

## §6. CONTRACTS ADDED (all additive, `tx`-first, tokened, private implementation)

| Owner | Token | Purpose |
|---|---|---|
| Sales | `DAILY_TRADING_SALES_QUERY` | `currentBusinessDay()` (reuses the single FR-FIN-024 implementation) + `facts()` — sales population, tender totals, tax-by-class, session attribution, currency sets |
| Treasury | `DAILY_CASH_RECONCILIATION_QUERY` | `forSessions()` — WHOLE_SESSION close/movement facts for a caller-supplied set of session ids, fail-closed (unknown/foreign ids silently dropped) |
| Organisation | `BRANCH_REPORTING_SCOPE_QUERY` | `operativeBranches()` — active branch ids for a tenant, capped at a caller-supplied limit |
| Localisation | `TAX_CLASS_LABELS_QUERY` | `findByIds()` — `code`/`countryPackCode` labels only; unresolved ids are simply absent from the returned map, never an error |

The pre-existing `BRANCH_CURRENCY_QUERY` (Organisation) is reused unchanged for branch existence/tenant-safety and the empty-day currency fallback.

### Business-day algorithm — single implementation, not duplicated

`cutoverLookup` (the small closure that turns a branch's `operating_hours` rows into the `resolveBusinessDay` lookup function) was a **private static method** on `OrdersService`. It is now an **exported named function** in `sales/orders/business-day.ts`, imported by both `OrdersService` (unchanged behaviour, verified by its own pre-existing tests, which still pass) and `DailyTradingSalesQueryService.currentBusinessDay`. This is a pure extract-method refactor — `resolveBusinessDay` itself is untouched. There is exactly one FR-FIN-024 implementation in the system.

---

## §7. BRANCH FAIL-CLOSED IMPLEMENTATION (§8/§14, D-2 untouched)

Inside the report's single transaction, in order:

1. `BRANCH_CURRENCY_QUERY.find(tx, {tenantId, branchId})` — `null` (unknown or cross-tenant, RLS-invisible) → `404 Branch not found.`, byte-identical for both cases.
2. `BRANCH_REPORTING_SCOPE_QUERY.operativeBranches(tx, {tenantId, limit: 2})`:
   - `0` active branches → `403`.
   - `> 1` active branches → `403` ("Reporting is not supported for a tenant with more than one active branch in this release.").
   - exactly `1`, and it is not the supplied `branchId` → `403`.
3. Only then is `currentBusinessDay` resolved and the future-day `400` check performed.

No `ReportingBranchGuard` exists. Nothing consults `identity.membership_roles.branch_id` or populates `TenantContext.branchId`; `PermissionGuard` is not made branch-aware. **D-2 is untouched.**

---

## §8. ONE RepeatableRead TRANSACTION

`DailyTradingReportService.build()` wraps the entire response in one `prisma.withAuthContext(..., { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })` call. Inside it, in this order: `dataAsOf` (`SELECT transaction_timestamp()`), branch existence, single-active-branch assertion, current business day + future-day check, Sales facts, historical currency resolution, Treasury facts (only if there are contributing session ids), tax-class labels, `periodStatus` composition. No second transaction anywhere in the call graph.

Proven by instrumentation, not source inspection, in `reporting-snapshot.e2e-spec.ts` (3/3 tests): a branch activated mid-transaction from an independent connection never changes the report's own single-active-branch shape; a payment committed mid-transaction from an independent connection never appears in the report's own totals; and a direct assertion that the exact same `tx` object backs both the branch-scope read and the sales-facts read within one request.

Module-boundary sanity in `module-boundaries.spec.ts` additionally confirms Reporting issues no direct Prisma model call at all (`tx.<model>.<verb>(` regex scan over the whole `reporting/` directory returns empty) — every fact comes through a contract.

---

## §9. SALES POPULATION AND FORMULAS

- **Revenue population**: `orders.state = 'completed'` only, for `(tenantId, branchId, businessDay)`. `draft`/`open`/`held`/`parked`/`partially_paid`/`cancelled` excluded.
- `grossSales = Σ completed orders.grand_total` (tax-inclusive). `orders.subtotal` is never read by any formula — proven by a fixture that deliberately sets a wrong `subtotal` on every order and asserts the report is unaffected.
- `discounts = Σ completed orders.discount_total` (structurally `0n` at this HEAD). `refunds = 0n` (literal — no refund mechanism exists).
- `taxTotal = Σ completed orders.tax_total`. `netSales = grossSales − discounts − refunds − taxTotal`.
- `completedOrderCount`, `openOrderCount` (draft/open/held/parked/partially_paid).
- `averageOrderValue = divideRounded(netSales, BigInt(completedOrderCount), RoundingMode.HALF_UP).toString()`, **present** (RPT-R3 ratified NET basis) and `null` exactly when `completedOrderCount === 0`.
- Money is `bigint` internally and a decimal (minor-unit) integer string externally via plain `.toString()` — the exact convention already used by `sales.views.ts` and `treasury.controller.ts`, verified against a value beyond `2^53` by asserting the raw response *text* (before `JSON.parse` could round it).

Query shape: **orders-first**. Step 1 reads `sales.orders` on `(tenant_id, branch_id, business_day)`. Step 2 reads `sales.order_payments` filtered by `tenant_id`, `business_day`, and `order_id IN (<step-1 ids>)` — never a bare `(tenant, branch, day)` predicate against `order_payments`, which carries no such index. Step 3 (session span) and step 4 (tax lines) are similarly bounded by the ids already resolved in steps 1–2. Query count for `facts()` is fixed at four statements regardless of order/payment/line/session volume.

---

## §10. TENDER, PARTIALLY-PAID RECONCILIATION

- Tender population is **all** `order_payments` for `(tenantId, branchId, businessDay)`, regardless of the owning order's state.
- Only `payment.amount` is summed — never `tendered_amount`, never `change_given`. Verified with the exact 90-due/100-tendered/10-change fixture (cash sales = 90).
- `cash.roundingAdjustmentTotal` is summed separately and never enters `grossSales`/`netSales`/`taxTotal`; `cashDrawerContribution = cash.amountTotal + cash.roundingAdjustmentTotal`.
- `manualExternalCard.roundingAdjustmentTotal` is always `0n` (CHECK-enforced at the DB). No card-scheme grouping is exposed anywhere (verified by asserting the response text does not contain `cardScheme`/`byCardScheme`).
- `unsettledCapturedTotal = Σ payment.amount` for branch-day payments whose order is **not** completed (i.e. `partially_paid`). Verified: `tenderGrandTotal === grossSales + unsettledCapturedTotal` at this HEAD.

---

## §11. TAX SUMMARY, CURRENCY, SESSION ATTRIBUTION, CASH RECONCILIATION, PERIOD STATUS

- **Tax by class**: `order_lines` of the completed population, excluding `state IN ('voided', 'comped')` (the full `OrderLineState` enum was confirmed to include both values). Grouped by `tax_class_id` only — no `byRate` key anywhere (asserted by absence). Identities verified: `Σ byClass.taxAmount === taxSummary.taxTotal === salesSummary.taxTotal`; per class `netAmount + taxAmount === grossAmount`. An unresolved `taxClassId` (never persisted as a `TaxClass` row) still succeeds with `taxClassCode: null`, `countryPackCode: null` — the report never fails for an unresolved label.
- **Historical currency**: observed set = distinct `orders.currency` over the completed population ∪ distinct `order_payments.currency` over the tender population. `|C| = 1` → that currency, `currencySource: "TRANSACTION"`. `|C| = 0` → `Branch.baseCurrency`, `currencySource: "BRANCH_FALLBACK"`. `|C| > 1` → `409`, no partial total. **Regression proven**: a day fully denominated in EGP still returns `EGP`/`TRANSACTION` after the branch's `baseCurrency` is changed to `USD` post-hoc — this is exactly the scenario the design correction exists to fix, and it fails against the original (pre-correction) design. A contributing session whose currency disagrees with the resolved report currency is a `409` (defence in depth over an otherwise-unreachable capture-time invariant).
- **Session attribution**: `DISTINCT order_payments.cash_session_id` over the tender population, with `businessDayCount = COUNT(DISTINCT business_day)` over *all* of that session's payments (not scoped to the requested day). A zero-payment session and a movement-only session are both absent from the response and not counted, by construction — proven directly.
- **Cash reconciliation**: `scope: "WHOLE_SESSION"` literal on the wire. Every session row's `expectedCash`/`countedCash`/`variance`/`payInTotal`/`payOutTotal`/`safeDropTotal` comes straight off `treasury.cash_sessions`/`cash_movements`, never `CashSessionCloseAttempt` or `cash_count_denominations`. **No day-level `varianceTotal`/`payInTotal`/`payOutTotal`/`safeDropTotal`/`expectedCashTotal`/`countedCashTotal` key exists anywhere** — asserted by key-absence over the whole `cashReconciliation` object. A session spanning two business days appears in both days' reports with `businessDayCount: 2`/`spansMultipleBusinessDays: true`, and each day's `tenderTotalsForThisBusinessDay` differs correctly. `closedSessionCount + unclosedSessionCount === contributingSessionCount`, always.
- **Period status**: exactly `OPEN` (requested day = branch's current business day), `UNSEALED` (past day, and `openOrderCount > 0` or `unclosedContributingSessionCount > 0`), `SETTLED` (past day, neither blocker). `SEALED` and `FUTURE` are never emitted. A past day whose *only* issue is an unrelated, zero-payment open session is `SETTLED` — the zero-payment-session non-blocker proof. `businessDay > branchCurrentBusinessDay` is `400` ("Future business days are not supported."), never a status value, checked against the *branch's own* calendar (a non-UTC-offset branch case is tested directly).
- **`dataAsOf`**: `SELECT transaction_timestamp()`, read as the first statement of the transaction.

---

## §12. ZERO KNOWN_DEVIATIONS GROWTH

`module-boundaries.spec.ts` gained three assertions: (1) `KNOWN_DEVIATIONS['reporting->*']` is `undefined` for every other module, and `violations.filter(v => v.importer === 'reporting')` is `[]`; (2) no reporting source file's import lines contain `identity/auth/`, `identity/authz/`, or `identity/context/`; (3) no reporting file contains a direct `tx.<model>.<verb>(` call, `schema.prisma` contains no `@@schema("reporting")`, and the migrations directory holds exactly 34 entries. All three pass; the full suite is 45/45 (up from 42/42 pre-slice).

---

## §13. MIGRATION / SCHEMA STATEMENT

**No migration was created, modified, or found necessary. `prisma/schema.prisma` is byte-unchanged.** `npx prisma validate` passes. The reporting module owns zero Prisma models.

---

## §14. EXPLAIN EVIDENCE — NO SEQ SCAN ON `order_payments`

Captured as `ros_app` with `app.tenant_id`/`app.user_id` RLS context set, inside `BEGIN … ROLLBACK`, against real data produced by the full e2e run on the scratch database (small cardinality — the same caveat the accepted acceptance-correction evidence already records: conclusions rest on access paths determined by index definitions, not on cardinality at this scale):

1. **Orders** (`(tenant_id, branch_id, business_day)`): `Index Scan using orders_2026_08_tenant_id_branch_id_business_day_idx`.
2. **Payments, orders-first join** (`order_id = ANY(<order ids>)`, `tenant_id`, `business_day`): `Bitmap Heap Scan on order_payments` / **`Bitmap Index Scan on order_payments_tenant_order_idx`** — index-driven, **no sequential scan**.
3. **Session span** (`businessDayCount`, `tenant_id` + `cash_session_id = ANY(...)`): `Index Scan using order_payments_tenant_cash_session_idx`.
4. **Tax lines** (`order_id = ANY(...)`, `tenant_id`, `business_day`, `state <> ALL('{voided,comped}')`): `Index Scan using order_lines_2026_08_tenant_id_order_id_id_business_day_idx`.
5. **Treasury sessions** (`tenant_id`, `branch_id`, `id = ANY(...)`): `Index Scan using uq_cs_branch_scoped_id`.
6. **Organisation active-branch scope** (`tenant_id`, `status = 'active'`, `LIMIT 2`): `Bitmap Index Scan on uq_branch_code`.

`treasury.cash_movements` (grouped by `cash_session_id`, `movement_type`, over the two session ids in this scratch data) planned as a `Seq Scan` — the table held under 100 rows; the `(tenant_id, cash_session_id)` index exists and the design's own §48 requirement is scoped specifically to `sales.order_payments`, not `cash_movements`. No `enable_seqscan` or other planner-forcing configuration was used anywhere.

---

## §15. TESTS

**Unit**: 792/792 passing, 58 suites (includes `module-boundaries.spec.ts` 45/45 and the untouched `business-day.spec.ts`, both re-verified after the `cutoverLookup` extract-method refactor).

**Reporting e2e** (56/56, 8 new files):

| File | Tests |
|---|---|
| `reporting-authorization.e2e-spec.ts` | 15 |
| `reporting-sales.e2e-spec.ts` | 7 |
| `reporting-tender.e2e-spec.ts` | 5 |
| `reporting-tax.e2e-spec.ts` | 4 |
| `reporting-cash-reconciliation.e2e-spec.ts` | 8 |
| `reporting-period.e2e-spec.ts` | 10 |
| `reporting-currency.e2e-spec.ts` | 4 |
| `reporting-snapshot.e2e-spec.ts` | 3 |

Coverage includes: both permissions required (AND), missing either → 403, POS/PIN session refused, dashboard positive control, foreign-tenant/unknown-branch byte-identical 404, zero/two active branches → 403 for both ids, wrong branch in single-active-branch shape → 403, arbitrary query parameter → 400; completed/open/held/parked/partially_paid/cancelled population rules; the 90/100/10 cash example; cash rounding separation; no card-scheme grouping; the tender identity; two-class tax aggregation with all stated identities; voided/comped exclusion; unresolved label; several contributing sessions, closed/open/closing facts, spanning-session businessDayCount, zero-payment/movement-only absence, no day-level keys, count identity; OPEN/UNSEALED/SETTLED including the zero-payment-session non-blocker and a non-UTC branch; the historical-currency regression, empty-day fallback, and both 409 currency cases; and the three RepeatableRead-snapshot concurrency proofs.

**Full e2e suite, clean scratch database from zero** (§16): **1070/1070 passing, 59/59 suites**, including this slice.

---

## §16. CLEAN SCRATCH DATABASE — CONSTRUCTION AND RESULT

1. Created a new, empty PostgreSQL database (`ros_scratch_rpt_<timestamp>`) on the existing local Postgres instance (the same instance the persistent dev `ros` database lives on; `ros` itself was never touched).
2. `DATABASE_URL` pointed at it as `ros_migrator`; ran `npx prisma migrate deploy`. **All 34 migrations applied cleanly, from zero, no errors.**
3. `APP_DATABASE_URL` pointed at it as `ros_app`; ran the full `test:e2e` suite (`NODE_OPTIONS=--experimental-vm-modules jest --config ./test/jest-e2e.json --runInBand`) against it.
4. **First run** (before OpenAPI regeneration): 1069/1070 passing — the single failure was `openapi.e2e-spec.ts`'s drift-detection test, correctly reporting the new route as documented-route drift (expected: OpenAPI had not yet been regenerated).
5. Regenerated OpenAPI (§17) against the same scratch database.
6. **Second, final run**: **1070/1070 passing, 59/59 suites, exit code 0.**
7. Dropped the scratch database.

No exclusion of any suite. No pre-existing-dirty-DB attribution was needed — the database was genuinely empty before the 34 migrations ran.

---

## §17. OPENAPI

Regenerated via `npm run openapi:generate` against the scratch database. `git diff --stat` on `docs/api/openapi.json`/`.yaml` shows **pure additions** (89 / 54 lines respectively) — exactly one new path, `/reports/branches/{branchId}/daily-trading/{businessDay}`, `GET` only. No existing path, schema, or component was altered. The document's description for the route states: dashboard-only; query-time aggregation over the transactional primary (FR-RPT-001/002/003/005 NOT IMPLEMENTED); both permissions required (AND); the single-active-branch refusal; future-day 400; WHOLE_SESSION cash-reconciliation scope; tax by class only (no by-rate); money as decimal strings. `openapi.e2e-spec.ts` (32/32, including drift detection in both directions) passes.

---

## §18. ERROR SEMANTICS — ORDERING VERIFIED

400 (malformed shape / any query parameter, then future-day) → 401 (missing/invalid token, or a POS/PIN session) → 403 (no tenant context; missing permission — the missing code never named; 0 or >1 active branches; wrong branch in the single-active-branch shape) → 404 (unknown/foreign branch, byte-identical) → 409 (>1 observed currency; session/report currency mismatch; Treasury resolving fewer sessions than requested). The relative ordering inside the transaction (branch existence → branch shape → future-day → currency) matches the design's required precedence; no test exercises an ordering the design forbids.

---

## §19. REQUIREMENT CLASSIFICATIONS

| Requirement | Status |
|---|---|
| **FR-RPT-004** `[M]` | **COMPLETE** — `dataAsOf` + three-state `periodStatus` + explanatory counts, all verified |
| **FR-RPT-001 / 002 / 003 / 005** `[M]` | **NOT IMPLEMENTED** — never claimed waived or complete |
| **FR-RPT-042** (drill-down) | **NOT IMPLEMENTED** |
| **FR-RPT-043 / 044** (export + export audit) | **NOT IMPLEMENTED** — no `report.export` |
| **FR-FIN-010** | **PARTIAL — advanced.** Per-day totals for the two implemented tenders only; "each card scheme" and the nine unbuilt tender families remain UNSATISFIED |
| §19.3 *Sales Summary* / *Sales by Tender* | **DELIVERED** (Internal-MVP form) |
| §19.3 *Tax Summary* | **PARTIAL** — by class only; by rate NOT IMPLEMENTED |
| §19.3 *Cash Reconciliation* | **PARTIAL** — payment-contributing sessions only, WHOLE_SESSION scope; zero-payment/movement-only session attribution NOT IMPLEMENTED |
| **FR-FIN-021** | **NOT IMPLEMENTED** — this report is not FR-FIN-021's blocking-session list |
| **FR-FIN-020…026** (DayClose / X/Z report) | **NOT IMPLEMENTED** |
| **FR-AUD-008** | **NOT IMPLEMENTED** — D-20 clause 9 stands |
| **FR-SEC-002 / 003 / 004** | **NOT IMPLEMENTED** — D-2 untouched; no branch-aware RBAC introduced |
| **FR-CST-003** | **NOT CLAIMED** — no COGS exposed |
| **NFR-PERF-010/011/012** | **NOT MEASURED, NOT CLAIMED** — EXPLAIN evidence shows index-driven access paths only |

**Reporting is not, and is not described anywhere as, complete.**

---

## §20. DEFERRED SCOPE (unchanged from the ratified design)

Read replica, star schema, `fact_*`/`dim_*` tables, Type-2 dimensions, rollups, report cache, export pipeline, analytics warehouse, ranges, weekly/monthly/hourly aggregation, multi-branch/consolidated reports, drill-down, CSV/XLSX/PDF, `report.export`, scheduled delivery, alerts, COGS, Prime Cost, Food Cost %, card-scheme financial grouping, additional payment tenders, DayClose, X/Z report, Receipt, Fiscal, Refund, post-fire Void, Comp, Offline sync, branch-aware RBAC, standard-role seeding. None of these was implemented, and none is implied as implemented anywhere in code, tests, or OpenAPI.

---

## §21. RESIDUAL RISKS

- The tender-vs-sales identity (`tenderGrandTotal === grossSales + unsettledCapturedTotal`) and the current gross/net formulas hold only while every completed order is fully paid and no refund/comp/void mechanism exists. The acceptance correction's five-point revisit trigger (population, `grossSales` formula, `discounts`/`refunds`, the tender identity, `SETTLED` semantics) applies unchanged when Discount/Comp/Refund/post-fire-Void/adjusting-entry slices ship.
- `businessDayCount`/session attribution depends on `order_payments.business_day` remaining the only anchor; a future session-to-day anchor (most likely arriving with DayClose) would change the zero-payment/movement-only-session exclusion and must re-derive `periodStatus`'s blocker set.
- EXPLAIN evidence was captured against a small (test-scale) dataset; conclusions rest on the access paths the existing index definitions guarantee at any volume, not on the observed costs themselves — consistent with the precedent already accepted for this same distinction in the design's own EXPLAIN evidence.

---

## §22. FINAL VERDICT

> # **A. MINIMUM OPERATIONAL REPORTING IMPLEMENTED — READY FOR ACCEPTANCE REVIEW**

---

*This report is non-authoritative evidence. The SRS and ratified governance decisions remain authoritative. The design-gate acceptance correction and the user-ratification record are preserved unmodified.*
