# RPT-DEMO-1 — Operational Analytics / Reporting Demo Pack

**Report type:** Implementation + tests + acceptance evidence
**Authority statement:** This report is NON-AUTHORITATIVE EVIDENCE.
`ROS_SRS_v1.0.pdf` and the ratified entries in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. Where
this report disagrees with the SRS or a ratified governance decision, the SRS
and the register win. This report records what was observed and measured in
this session — it ratifies nothing and authorises nothing.
**Date:** 2026-09-04
**Baseline HEAD:** `d4fccfa` (docs: record multi-tenant multi-branch
acceptance)
**Branch:** `full-srs/lane-d4-reporting-demo`
**Working tree summary at session start:** clean, at `d4fccfa`.
**Task identifier:** RPT-DEMO-1

---

## CURRENT_REALITY

Before implementation, the existing Reporting module was inspected in full
(`kitchen-kit/backend/src/modules/reporting/`):

- Exactly **one** route existed: `GET
  /reports/branches/:branchId/daily-trading/:businessDay`
  (`reporting.controller.ts`), gated by `report.view.sales` AND
  `report.view.financial` (RPT-R1/R2/R3, ratified 2026-08-31), authorized via
  `@AuthorizationTarget(branchFromParam('branchId'))`.
- `DailyTradingReportService` composes the entire response inside ONE
  `withAuthContext` RepeatableRead transaction, reading facts exclusively
  through published `contract/` tokens from Sales
  (`DAILY_TRADING_SALES_QUERY`), Treasury (`DAILY_CASH_RECONCILIATION_QUERY`),
  Organisation (`BRANCH_CURRENCY_QUERY`, `BRANCH_REPORTING_SCOPE_QUERY`), and
  Localisation (`TAX_CLASS_LABELS_QUERY`) — Reporting itself owns **zero**
  Prisma models and **zero** migrations.
- `module-boundaries.spec.ts` mechanically enforces that Reporting adds no
  new private-path (`KNOWN_DEVIATIONS`) import into any other module, and
  separately scans every migration to confirm Reporting owns no
  `reporting`-schema table.
- Governance: `reporting.permissions.ts`'s own doc-comment states the two
  `report.view.*` codes "MUST NOT be broadened, split, or accompanied by
  `report.export` or any other `report.view.*` code" (RPT-R1 clause 5) — this
  session's non-negotiable "do not invent a permission" is therefore not just
  a task instruction but a standing governance constraint.
- Nine existing E2E suites already exhaustively cover the daily-trading
  route's sales/cash/tax/currency/period/snapshot/tender/overpayment
  semantics; none of that logic needed to be reproven, only reused.
- Inventory, Workforce and Kitchen (KDS) had **no published `contract/`
  query** for any of the aggregate metrics this task needed (low-stock count,
  waste totals, attendance summary, ticket/prep-duration summary) — only
  private, unpublished services with logic that was either not branch-scoped
  (Inventory: keyed on `location_id`, no `branch_id` column exists on
  `stock_levels`/`stock_item_reorder_configs`/`waste_records`) or not
  aggregated at all (Workforce, Kitchen).
- `kitchen.tickets` carries a genuine `business_day` column (unlike
  `workforce.attendance_records`/`inventory.waste_records`, which carry
  neither); `Ticket.servedAt` exists as a schema column but **is never
  written by any code path** in this repository (confirmed by a full-repo
  search) — so no fulfilment/serving-time metric can be truthfully computed.

## IMPLEMENTED_METRICS

**A. Sales** (reused from `DAILY_TRADING_SALES_QUERY`, restructured under a
`sales` section): gross sales, net sales, discounts, refunds, tax total,
completed order count, open order count, average order value, tender
breakdown (cash / manual-external-card, `tenderGrandTotal`,
`cashDrawerContribution`, `completedExcessCapturedTotal`,
`unsettledCapturedTotal`), business-day context (`businessDay`,
`branchCurrentBusinessDay`, `periodStatus`, `dataAsOf`, `currency`,
`currencySource`). Comps are **not** a separately summed figure — this is
inherited, unchanged behavior from `daily-trading` (a comp is a full-line
discount; there is no separate `comps` column anywhere in Sales' own
contract), not a new gap introduced by this task.

**B. Cash / Treasury** (reused from `DAILY_CASH_RECONCILIATION_QUERY`, under
a `cash` section): per-session expected cash, declared/counted cash,
variance, pay-in/pay-out/safe-drop totals, session status,
`contributingSessionCount`/`closedSessionCount`/`unclosedSessionCount` —
identical WHOLE_SESSION scope and identical numbers to `daily-trading` for
the same fixture (proven by cross-endpoint test, see TEST_MATRIX).

**C. Inventory** (new `BRANCH_INVENTORY_SNAPSHOT_QUERY`, Organisation
contract): `lowStockItemCount` (branch-scoped via the branch's own
`org.locations` row — FR-INV-066's existing comparison, now published,
tenant+location scoped, count-only), `waste.recordCount` /
`waste.quantityTotal` / `waste.valueTotal` over a **calendar-day** window on
`waste_records.recordedAt`. Movement summary and COGS/depletion are **NOT
implemented** — see REQUIREMENT_DISPOSITION and KNOWN_DEVIATIONS.

**D. Workforce** (new `ATTENDANCE_SUMMARY_QUERY`): `clockedInCount` (a LIVE
gauge — `status='open'` right now, not window-scoped), `attendanceRecordCount`,
`lateArrivalCount`, `earlyDepartureCount`, `unscheduledCount`,
`outsideGeofenceCount`, `missingClockOutCount` — the last five scoped to a
**calendar-day** window on `clock_in_at`. Overtime and Country Pack labour
rules are explicitly **not** computed (non-negotiable exclusion).

**E. KDS** (new `KDS_SUMMARY_QUERY`): `ticketCount`, `statusCounts` (by the
real `TicketStatus` enum), `measuredPrepDurationCount`,
`averagePrepDurationSeconds` (nullable) — `startedAt → bumpedAt` only, scoped
to the **same business day** as sales/cash (`kitchen.tickets.business_day` is
real). No fulfilment/serving-time metric is computed or implied — `servedAt`
is never populated by any write path in this codebase.

## API_CONTRACT

One new route, mirroring the existing `daily-trading` route's shape and
guard chain exactly:

```
GET /reports/branches/:branchId/overview?businessDay=YYYY-MM-DD
```

- Guards: `JwtAuthGuard` → `TenantContextGuard` → `PermissionGuard`
  (unchanged chain).
- Permission: `@RequirePermission(REPORTING_PERMISSIONS.VIEW_SALES,
  REPORTING_PERMISSIONS.VIEW_FINANCIAL)` — the SAME two codes, AND mode. **No
  new permission code was created.**
- Authorization target: `@AuthorizationTarget(branchFromParam('branchId'))` —
  identical mechanism to `daily-trading`.
- `businessDay` is a REQUIRED query parameter (`YYYY-MM-DD`); any other query
  parameter is rejected with 400 (global `whitelist`/`forbidNonWhitelisted`
  `ValidationPipe`, mirroring `DailyTradingReportQueryDto`'s own pattern).
- `daily-trading` is **unchanged and untouched** — same route, same service,
  same tests, still passing (see REPORTING_EXISTING_REGRESSION).
- Response is structured into `sales` / `cash` / `inventory` / `workforce` /
  `kds` sections, plus top-level `branchId`, `businessDay`, `currency`,
  `currencySource`, `dataAsOf`, `periodStatus`, `branchCurrentBusinessDay`,
  and a `scope.notes` array. Every section additionally carries its own
  `notes` array disclosing its own time model and any deliberately omitted
  metric. Money is a decimal (minor-unit) string on the wire, never a JSON
  number (proven for a value beyond `2^53` in the new E2E suite).
- No tenant-wide consolidated route was added in this slice — see
  MULTI_BRANCH_AUTH and FULL_SRS_REPORTING_REMAINING for the reasoning.

## SOURCE_OF_TRUTH_MATRIX

| METRIC | SRS SOURCE | CURRENT SOURCE DATA | ALREADY CALCULATED? | BRANCH-SAFE? | SHIPPED TONIGHT? |
|---|---|---|---|---|---|
| Gross sales | FR-FIN-022, §19.3 | `sales.orders.grand_total` (completed/partially_refunded/refunded) | Yes (`DAILY_TRADING_SALES_QUERY`) | Yes | YES |
| Net sales | FR-FIN-022 | gross − discounts − refunds − tax | Yes | Yes | YES |
| Completed order count | FR-FIN-022 | order count | Yes | Yes | YES |
| Average ticket (AOV) | §19.3 | netSales ÷ count (HALF_UP) | Yes | Yes | YES |
| Discounts | FR-FIN-022 | `orders.discount_total` | Yes | Yes | YES |
| Comps | FR-FIN-022 | not a separate figure (comp = full-line discount) | Inherited, unchanged | Yes | INHERITED — not newly exposed as its own figure (pre-existing daily-trading behavior) |
| Refunds | FR-FIN-022 | `sales.refunds.amount_minor`, own `refund_business_day` | Yes | Yes | YES |
| Tender breakdown | §19.3 Sales by Tender | `order_payments` by tender | Yes | Yes | YES |
| Business-day/date context | FR-RPT-004 | `dataAsOf`, `businessDay`, `periodStatus` | Yes | Yes | YES |
| Expected cash | FR-FIN-022 | `cash_sessions.expected_cash` (WHOLE_SESSION) | Yes | Yes | YES |
| Declared/actual cash | FR-FIN-022 | `cash_sessions.counted_cash` | Yes | Yes | YES |
| Variance | FR-FIN-022 | `cash_sessions.variance` | Yes | Yes | YES |
| Pay-ins/pay-outs/safe-drops | §19.3 Cash Reconciliation | `cash_movements` grouped by type | Yes | Yes | YES |
| Session state/count | — | `cash_sessions.status` | Yes | Yes | YES |
| Low-stock item count | §19.3, FR-INV-066 | `stock_item_reorder_configs` vs `stock_levels` | Logic existed privately (`ReconciliationService.lowStock`), unpublished, tenant-only | Yes — NEW branch join via `org.locations` | YES (newly published this session) |
| Waste quantity/value | §19.3 Waste Analysis | `waste_records`/`waste_lines` | Logic existed privately (`WasteService.list`), no aggregation/date/branch scope | Yes — NEW | YES (newly published this session) |
| Stock movement summary | §19.3 Stock Movement Ledger | `stock_movements` | No aggregate query anywhere | N/A | NOT IMPLEMENTED — no existing accepted aggregate; deferred (time-box; would need its own small design pass) |
| Inventory depletion / COGS | §19.3 Prime Cost | `SaleDepletionService` (private FIFO/weighted-average kernel) | No form safe to publish tonight | N/A | NOT IMPLEMENTED — non-negotiable "Do NOT invent stock valuation rules"; no existing accepted query logic exposes it |
| Employees clocked in | §19.3 Attendance | `workforce.attendance_records.status='open'` | Flag existed, no summary query | Yes — NEW | YES (newly published this session) |
| Worked attendance duration | FR-HRM-030 (adjacent) | `clock_in_at`/`clock_out_at` present per-record | Derivable, no aggregate | Yes | NOT IMPLEMENTED tonight — omitted for time-box, not exposed as an aggregate (see FULL_SRS_REPORTING_REMAINING) |
| Late arrivals | FR-HRM-022 | `attendance_records.late_arrival` | Yes (flag, set at clock-in) | Yes | YES |
| Early departures | FR-HRM-022 | `attendance_records.early_departure` | Yes (flag, set at clock-out) | Yes | YES |
| Unscheduled attendance | FR-HRM-022 | `attendance_records.unscheduled` | Yes (flag) | Yes | YES |
| Outside-geofence flags | FR-HRM-022 | `attendance_records.outside_geofence` | Yes (flag) | Yes | YES |
| Missing-clock-out count | FR-HRM-022/024 | `attendance_records.missing_clock_out` | Yes (flag; FR-HRM-024 auto-close remains NOT IMPLEMENTED, pre-existing gap) | Yes | YES (counts the flag; auto-detection itself is a separate, still-open requirement) |
| Overtime | explicitly excluded | — | — | — | NOT IMPLEMENTED — non-negotiable exclusion |
| Ticket count | FR-KDS-040/041 | `kitchen.tickets` | Yes | Yes | YES |
| Open/in-progress/completed count | FR-KDS-040 | `tickets.status` | Yes | Yes | YES |
| Average prep duration | FR-KDS-041/042 | `tickets.started_at` → `tickets.bumped_at` | Both persisted; a real measurement | Yes | YES |
| Average fulfilment/serving duration | FR-KDS-041/042 | `tickets.served_at` | **Never written by any code path** | N/A | NOT IMPLEMENTED — omitted rather than fabricated (non-negotiable "Never derive fake prep-time data") |

## MULTI_BRANCH_AUTH

The new `overview` route reuses the identical `@RequirePermission` +
`@AuthorizationTarget(branchFromParam('branchId'))` mechanism the existing
`daily-trading` route already uses — the same primitive MTMB-1 already
proved correct for per-branch reporting isolation. A dedicated
`multi-branch/tenant authorization` E2E test (in the new suite) proves, with
real distinct-per-branch gross-sales figures:

- An A1-only-scoped manager can report A1 (200, correct figures) and cannot
  report A2 (403).
- An A1+A2-scoped manager (two `branch`-scope role assignments on one
  membership) can report both individually (200 for each, correct
  per-branch figures — no aggregation, no cross-branch leakage).
- The tenant owner (tenant-scope grant) can report both.
- A Tenant-B actor addressing Tenant A's `branchId` receives a
  byte-identical 404 (never a 200, never Tenant A's data) — Tenant B never
  appears in Tenant A's results.

**No new tenant-wide consolidated/aggregate route was built in this slice.**
RPT-DEMO-1 §4 makes this conditional ("if implementing tenant consolidated
reporting..."), not mandatory, and the P0 proof list itself (A1-only, A1+A2,
tenant owner, Tenant-B isolation) is fully satisfiable — and was fully
proven — by calling the SAME per-branch route once per branch/actor, exactly
as MTMB-1 already validated `daily-trading`. Building a genuinely safe
tenant-wide aggregate would require a NEW permission-aware "resolve every
branch this caller may access for `report.view.sales`+`report.view.financial`"
primitive — investigated this session and confirmed **not to exist yet**
(`BranchesService.listAccessible`, the only existing bulk-branch-resolve
method, filters only by grant *scope type*, never by permission code, so it
cannot be reused unmodified without a real authorization gap). Building that
primitive correctly, plus its own design gate and tests, was judged out of
scope for tonight's time-box; it is recorded as the first item in
FULL_SRS_REPORTING_REMAINING.

## FINANCIAL_RECONCILIATION

The new route's `sales`/`cash` sections are **not a reimplementation** — they
call the exact same `DAILY_TRADING_SALES_QUERY.facts()` and
`DAILY_CASH_RECONCILIATION_QUERY.forSessions()` contract methods
`DailyTradingReportService` already calls, inside an equivalent
single-transaction orchestration (branch existence → unreviewed-migration
scope review → operative-branch check → future-day check → sales facts →
currency resolution → cash facts → period status). A new E2E test builds one
fixture (large gross sale beyond `2^53`, a discount, cash + pay-in/pay-out/
safe-drop, a same-formula closed cash session) and asserts the new
`overview` route's numbers are **byte-identical** to the existing
`daily-trading` route's numbers for the same branch/day — gross sales, net
sales, completed order count, discounts, refunds, average order value,
tender grand total, and every cash-session field (expected/counted/variance/
pay-in/pay-out/safe-drop). Discount/comp/refund exact-once semantics
themselves are proven by the **existing**, unmodified
`reporting-sales.e2e-spec.ts`/`pos-financial-corrections.e2e-spec.ts` suites
(re-run this session, all passing) — that logic lives entirely inside the
shared Sales contract this new route also calls, so it was not re-derived.

## PERFORMANCE_BOUNDARIES

- Sales/cash: unchanged from `daily-trading` — indexed on
  `(tenant_id, branch_id, business_day)`.
- Inventory: `stockItemReorderConfig`/`stockLevel` queries filtered by
  `tenantId` + `locationId IN (...)` (the branch's own one-or-few
  locations); `wasteRecord` additionally bounded by
  `recordedAt` `[from, to)`. No unbounded historical scan.
- Workforce: `attendanceRecord` queries filtered by `tenantId` + `branchId`
  + `clockInAt` `[from, to)`. No new index was added (no migration
  authorised); existing `@@index([tenantId, branchId, status])` partially
  serves the live `clockedInCount` gauge. Recorded as a candidate index for
  the Full-SRS phase, not added tonight.
- KDS: `ticket` query filtered by `tenantId` + `branchId` + `businessDay`
  (exact match on an indexed, real business-day column).
- All five sections execute inside the SAME single RepeatableRead
  transaction as the top-level branch/scope/future-day gates — no N+1
  fan-out across sections.
- This is DEMO/OPERATIONAL query-time aggregation over the transactional
  primary — identical posture to `daily-trading` (RPT-R2). It will move
  behind read replica / rollups / fact-dimension when that architecture is
  actually built; the service/API boundary (thin `contract/`-token
  injection, one orchestrating service per route) is designed so the
  frontend contract does not need to change when that happens.

## REQUIREMENT_DISPOSITION

Only Reporting requirements this slice actually touched are re-adjudicated
here; every prior classification elsewhere is left exactly as it was.

| Requirement | Disposition after this session | Note |
|---|---|---|
| FR-RPT-004 (data-as-of / completeness) | COMPLETE (unchanged) | Already true for `daily-trading`; the new route independently satisfies it too (own `dataAsOf`), not a new claim. |
| FR-RPT-001/002/003/005 (read replica / rollups / incremental rebuild / SCD2) | NOT IMPLEMENTED (unchanged) | This slice adds query-time aggregation only, per RPT-R2's authorized sequencing — no read replica, no rollup table, no SCD2 dimension, no new migration. |
| FR-RPT-030…034 (dashboards) | NOT IMPLEMENTED (unchanged) | No dashboard UI/config is part of this slice; the new route is a data source a future dashboard could consume. |
| FR-RPT-040/041 (scheduled delivery / morning brief) | NOT IMPLEMENTED (unchanged) | Explicitly excluded by this task's non-negotiables; no scheduler infrastructure exists in this repository (confirmed pre-existing, repo-wide gap). |
| FR-RPT-042 (drill-down) | NOT IMPLEMENTED (unchanged) | Out of scope tonight. |
| FR-RPT-043/044 (export + export audit) | NOT IMPLEMENTED (unchanged) | Out of scope tonight. |
| FR-RPT-045/046 (alerts) | NOT IMPLEMENTED (unchanged) | Out of scope tonight. |
| FR-RPT-047 (NL query) | NOT IMPLEMENTED (unchanged) | Out of scope tonight (non-negotiable exclusion). |
| FR-INV-066 (reorder-point comparison) | Same computation, now additionally exposed branch-scoped via a published contract query | The underlying comparison was already implemented privately (`ReconciliationService.lowStock`); this session did not change that logic, only published a branch-scoped, count-only view of it for Reporting to consume. |
| FR-HRM-022 (five independent attendance flags) | Unchanged; now additionally exposed as branch-scoped counts | Flag-setting logic (`AttendanceService`) untouched; this session added a read-only aggregate over the existing columns. |
| FR-HRM-024 (auto-close missing clock-out) | NOT IMPLEMENTED (unchanged, pre-existing gap) | `missingClockOutCount` counts the existing flag; nothing in this session implements the auto-close job itself. |
| FR-HRM-030…035 (workforce reporting) | Still PARTIAL/NOT IMPLEMENTED overall | This session implements a narrow slice of FR-HRM-030's "attendance"-adjacent surface only (clocked-in/late/early/unscheduled/geofence/missing-clock-out counts); per-employee sales/AOV/upsell/void/discount/cash-variance metrics and kitchen-employee metrics (FR-HRM-031) remain NOT IMPLEMENTED. |
| FR-KDS-040/041 (timestamps, prep time by item/station/hour/employee/order type) | PARTIAL | This session implements branch/business-day ticket counts and a single aggregate average prep duration; per-item/per-station/per-hour/per-employee/per-order-type breakdowns remain NOT IMPLEMENTED. |
| FR-KDS-042 ("ticket time"/"order time" definitions) | PARTIAL | `averagePrepDurationSeconds` (started→bumped) is one real duration measurement; the SRS's specific "ticket time" (bump − fire) and "order time" (last-line-ready − order-open) definitions are not separately computed. |
| FR-KDS-043 (bottleneck station identification) | NOT IMPLEMENTED (unchanged) | Out of scope tonight. |

**Never claimed COMPLETE tonight:** the Full Reporting SRS, any dashboard
requirement, any export/scheduling/alerting/NL-query requirement, Z-report
(`FR-FIN-022/023` — DayClose remains its own, separate, already-deferred
slice), or full FR-HRM-030…035/FR-KDS-040…043.

## TEST_MATRIX

New file: `test/reporting-demo-analytics.e2e-spec.ts` — 8 tests, all
observed passing this session:

| # | Task's proof item | How it's proven |
|---|---|---|
| 1–8 | Sales gross/net/order count; discount reflected once; refund reflected once (0-case); AOV; tender breakdown; cash expected reconciles; pay-in/pay-out/safe-drop correct | ONE test: cross-endpoint byte-identical comparison against `daily-trading` for a shared fixture (incl. a value `> 2^53`) — discount/comp/refund exact-once semantics themselves are additionally covered by the pre-existing, unmodified `reporting-sales.e2e-spec.ts` (7/7) and `pos-financial-corrections.e2e-spec.ts` suites, re-run this session |
| 9 | Inventory branch isolation | `inventory: low-stock count and waste totals...` — Branch A's low-stock count (1) and waste figures are asserted unaffected by Branch B's independent, larger low-stock/waste fixtures on the same tenant |
| 10 | Waste/low-stock metrics correct | Same test — exact `lowStockItemCount`, `waste.recordCount`, `waste.quantityTotal` (`4.5`), `waste.valueTotal` (`1200`) asserted, including a waste record deliberately OUTSIDE the business-day window (excluded) |
| 11 | Workforce attendance metrics correct | `workforce: attendance metrics...` — `clockedInCount`, `attendanceRecordCount`, and all five flag counts asserted against hand-built fixtures, including one record deliberately outside the window (excluded) |
| 12 | Anomaly flag counts correct | Same test — `lateArrivalCount`/`earlyDepartureCount`/`unscheduledCount`/`outsideGeofenceCount`/`missingClockOutCount` each asserted `=== 1` |
| 13 | KDS metric correct | `kds: ticket count, status counts, and average prep duration...` — 4 tickets across 3 statuses, `averagePrepDurationSeconds` hand-computed as `(120+80)/2 = 100` over exactly the 2 measurable tickets; a second test proves a zero-ticket branch returns `null`, never a fabricated `0` |
| 14 | A1 report excludes A2 | `multi-branch/tenant authorization` test — A1-only actor gets 403 reading A2 |
| 15 | A2 report excludes A1 | Same test — by symmetry (A1-only actor never sees A2's `22000` gross figure; A2's own read never sees A1's `11000`) |
| 16 | Multi-branch actor can read both | Same test — an actor with two `branch`-scope assignments (A1, A2) reads both, 200, correct distinct figures |
| 17 | Tenant owner authorized correctly | Same test — the fixture's tenant-scope dashboard user reads both branches, 200 |
| 18 | Tenant B never leaks | Same test — a fully separate Tenant B actor addressing Tenant A's `branchId` gets a byte-identical 404 |
| 19 | Zero-data branch returns valid zero/empty structures | `a branch with zero data of every kind...` — every section's zero/empty/null shape is asserted explicitly (`sessions: []`, `averageOrderValue: null`, `averagePrepDurationSeconds: null`, all counts `0`) |
| 20 | API money serialization safe | Covered inside test #1 — `grossSales === '9007199254740993'` (`2^53 + 1`), asserted as an exact string, never round-tripped through a JS number |
| — | Cheap authorization insurance (not in the numbered list, added defensively) | `403s without report.view.financial; 404s for a foreign/unknown branchId` |

## OPENAPI

`npm run openapi:generate` (built via `nest build`) regenerated
`docs/api/openapi.json`/`.yaml`. The diff is **purely additive** (842
insertions, 0 deletions across both files) — the new
`/reports/branches/{branchId}/overview` path and its response schema only;
every existing path, including `daily-trading`, is byte-identical to before.
These regenerated files are committed with this slice so `npm run
openapi:check` (`generate` + `git diff --exit-code`) is clean going forward.

## LINT

`npm run lint:check` (exact, no `--fix`): **52 errors / 0 warnings** —
identical to the MTMB-1 session's own measured baseline (52/0). Every single
finding is in a file this session never touched
(`treasury/cash-session-close/cash-session-close.service.ts`,
`treasury/cash-sessions/cash-sessions.service.ts`,
`treasury/treasury.controller.ts`,
`test/cash-movements-close-and-payment-concurrency.e2e-spec.ts`,
`test/cash-session-close.e2e-spec.ts`,
`test/tenant-isolation/fixture-overrides.ts`). **Zero new Reporting
findings.** All new/changed files for this slice were individually verified
lint-clean (`npx eslint <files>` → 0 problems) before this run.

## AUDIT

`npm audit --omit=dev --audit-level=high`: **0 vulnerabilities.**

(Separately: `node_modules` in this worktree was missing `prom-client`
— declared in `package.json`/`package-lock.json` but not installed, a
pre-existing install-drift unrelated to Reporting that blocked `tsc` and
every e2e test in the whole repository, not just this slice's. Fixed with a
plain `npm install` against the committed lockfile — no version changed,
`0 vulnerabilities` reported after.)

## KNOWN_DEVIATIONS

- **Movement summary** (Inventory) and **inventory depletion/COGS**: not
  implemented. No existing accepted query/aggregate exists for either, and
  building one — especially COGS, which would need to safely expose
  `SaleDepletionService`'s private FIFO/weighted-average kernel — was judged
  to need its own design pass, not a same-night addition (non-negotiable
  "Do NOT invent stock valuation rules").
- **Worked attendance duration** (Workforce): the raw data
  (`clockInAt`/`clockOutAt`) exists and is derivable, but no aggregate
  duration statistic was added tonight, purely a time-box scope cut.
- **KDS fulfilment/serving duration**: not implemented, and CANNOT be
  implemented truthfully — `Ticket.servedAt` is a schema placeholder column
  that no write path in this codebase ever populates. Documented explicitly
  in the response's own `kds.notes`, never fabricated.
- **No tenant-wide consolidated/aggregate route**: see MULTI_BRANCH_AUTH —
  the P0 proof list is satisfied per-branch; a genuinely safe aggregate route
  needs a new permission-aware bulk branch-resolver that does not exist yet.
- **Inventory branch-scoping crosses a schema boundary via Prisma, not a TS
  import**: the new `BranchLocationsQueryService`
  (`organisation/locations/branch-locations.query.service.ts`) resolves a
  branch's own `org.locations` row and is injected directly by
  `OperationalOverviewService`, which passes the resolved `locationIds` into
  Inventory's `BRANCH_INVENTORY_SNAPSHOT_QUERY` — composition happens at the
  Reporting orchestration layer (exactly the existing `daily-trading`
  pattern: Reporting composes Sales+Treasury facts without either module
  reading the other's tables), never inside Inventory's own contract
  implementation. `module-boundaries.spec.ts` (46/46, unchanged) confirms no
  new private cross-module TS import was introduced anywhere in this slice.
- **Workforce/Inventory time windows are CALENDAR-day, not POS business-day**
  (`attendance_records`/`waste_records` carry no business-day column, and
  none was invented — no migration was authorised or added). This is
  disclosed explicitly in each section's own `notes` array in the API
  response itself, per RPT-DEMO-1 §5's explicit instruction to state this
  rather than pretend the time models agree. KDS, uniquely, DOES use the
  real POS business day (`kitchen.tickets.business_day` genuinely exists).

## FULL_SRS_REPORTING_REMAINING

Still fully open after this session (unchanged from before, except where
explicitly noted above as newly PARTIAL):

- Read replica (FR-RPT-001), pre-aggregated rollups (FR-RPT-002),
  incremental rebuild (FR-RPT-003), star schema / Type-2 dimensions
  (FR-RPT-005) — the entire §19.2 analytics architecture.
- Role-appropriate dashboards (FR-RPT-030…034).
- Scheduled delivery / morning brief (FR-RPT-040/041) — blocked, as before,
  by the repository-wide absence of any scheduler/job-runner infrastructure.
- Drill-down (FR-RPT-042), export + export audit (FR-RPT-043/044), alerts
  (FR-RPT-045/046), NL query interface (FR-RPT-047).
- Z Report / Day Close as an immutable, sequentially-numbered artifact
  (FR-FIN-022/023) — a separate slice with its own design gate, as already
  recorded by the Minimum Operational Reporting acceptance closure; this
  session's `overview` route is a LIVE read, never an immutable close
  artifact.
- Full per-employee workforce reporting (FR-HRM-030…032), payroll export
  (FR-HRM-035), overtime, Country Pack labour rules.
- Per-item/station/hour/employee/order-type KDS prep-time breakdowns
  (FR-KDS-041), formal "ticket time"/"order time" definitions (FR-KDS-042),
  bottleneck-station detection (FR-KDS-043).
- Inventory movement-summary and COGS/depletion reporting.
- A genuinely safe tenant-wide multi-branch consolidated reporting route
  (FR-BRN-005/006/007 reporting dimension) — needs a new permission-aware
  bulk branch-resolver contract (does not exist anywhere in this codebase
  today) plus its own design gate; not attempted tonight.
- CRM/procurement/central-kitchen reporting (explicitly out of scope,
  non-negotiable).

## READY_FOR_FULL_E2E

Not evaluated — full E2E was explicitly not run this session (non-negotiable
"run full E2E" prohibition). The targeted regression set below is the full
evidence for this session.

---

## Evidence — commands actually executed this session, with real results

- `npx prisma validate` → `The schema at prisma/schema.prisma is valid` (no
  schema changes made; confirmed no `reporting` schema/table exists anywhere).
- `npm run typecheck` → clean (0 errors) after `npm install` resolved the
  pre-existing `prom-client` install-drift; before that fix, the ONLY
  pre-existing failure repo-wide was that one missing module, confirmed by
  diffing against files this session never touched.
- `npx jest src/modules/module-boundaries.spec.ts` → **46/46 passed.**
- `npx jest src/modules/authorization-coverage.spec.ts` → **9/9 passed.**
- `npm test -- --ci` (full unit suite) → **83 suites / 1150 tests passed.**
- Targeted E2E (real, disposable Postgres — `ros-postgres-lane-d`, template
  migrated from zero, 44 migrations, per-suite scratch-database cloning via
  the existing `e2e-db-isolation` harness):
  - `test/reporting-demo-analytics.e2e-spec.ts` → **8/8 passed** (new).
  - `test/reporting-sales.e2e-spec.ts` + `reporting-cash-reconciliation.e2e-spec.ts`
    + `reporting-authorization.e2e-spec.ts` → **31/31 passed** (unchanged).
  - `test/multi-tenant-multi-branch.e2e-spec.ts` +
    `pos-financial-corrections.e2e-spec.ts` + `workforce-hr1.e2e-spec.ts` →
    **99/99 passed** (unchanged).
  - **Total targeted E2E: 138/138 passed. Zero regressions.**
- `npm run openapi:check` → the `generate` step produced a purely additive
  842-line diff (the new route only); committed alongside this slice's code
  so the check is clean against the committed state going forward.
- `npm run lint:check` → **52 errors / 0 warnings**, identical to the prior
  MTMB-1 baseline, zero new findings, all pre-existing findings confirmed to
  be in files this session never touched.
- `npm audit --omit=dev --audit-level=high` → **0 vulnerabilities.**
- `git diff --check` → clean (no whitespace errors).
- Migration count: **44** (unchanged) — `prisma/migrations/` was not
  touched; `module-boundaries.spec.ts`'s own "Reporting owns no Prisma model
  and no migration" assertions (unchanged) additionally confirm this
  mechanically.

No test/verification result in this report is reused from a prior session —
every number above was produced by a command run in this session, against
this session's own code.
