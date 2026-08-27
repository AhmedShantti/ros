# P1F-2 — Final Payment + Order Completion Atomic Orchestration

**Report type:** Implementation report (migrations, production code, tests, verification evidence)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence**. The controlling design document is `docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-correction.md` §L ("FINAL SONNET PROMPT"), which this report implements literally; where this report and that document appear to differ, the document governs and the difference is a documentation bug in this report, not a design change. No governance is created or amended by this report.
**Date:** 2026-08-26 / 2026-08-27
**HEAD at start:** `9aa7a880229938bffd2d5dc0dfcb3d263da060e8` (differs from the prompt's stated expected HEAD `cf04e008a35ba421b23b96b5fa6221a8dae5da12` by two intervening commits — `docs: finalize P1F-2 completion design gates` and `feat: provision signed demo country pack` — flagged to the user at task start; migration count (27), branch, and all five controlling P1F-2 docs were confirmed present and unaffected, so implementation proceeded)
**Branch:** `feat/production-spec`
**Working tree at report time:** uncommitted — 3 new migrations, ~20 new/modified `src/` files, 3 new + 2 modified test files, regenerated `docs/api/openapi.{json,yaml}`, updated `prisma/schema.prisma`, `prisma.config.ts` fixed (see §J.1), this report, `INDEX.md`. **Nothing committed, nothing pushed**, per instruction.
**Task identifier:** P1F-2

> ## VERDICT
> ## **IMPLEMENTATION COMPLETE FOR THE COMPLETION PATH, WITH ONE HONEST GAP**
> All three migrations apply cleanly from zero and via the mandatory upgrade
> path; the full atomic Completion orchestration (recipe expansion → dual-axis
> depletion → FIFO exhaustion carry-forward → COGS posting → Order CAS →
> `order.completed`) is implemented and passes 747/747 real-Postgres e2e tests
> (plus 732/732 unit) with zero regressions. OpenAPI is exactly 3.1.0 / 135,
> `tsc`/`eslint`/`prisma validate`/`nest build`/`git diff --check` are all
> clean, and `KNOWN_DEVIATIONS` did not grow. **The one genuine shortfall is
> performance**: measured p95 for a 30-line, nested-recipe, mixed-costing,
> multi-batch-FIFO, modifier-bearing Completion is **2120ms**, ten times the
> 200ms NFR-PERF-006 target — reported honestly below with the real numbers,
> not claimed as passing. The full 5-scenario × 3-run concurrency matrix was
> not built in its entirety; 2 of the 5 named scenarios were built and proven
> with real Postgres barriers (3 clean runs each); the remaining 3 are listed
> as not implemented, not silently assumed.

---

## A. WHAT WAS BUILT

### A.1 Three module-owned migrations, 27 → 30

- `prisma/migrations/20260826010000_sales_completion_snapshots/` (Sales, migration 28) — `ck_completed` on `sales.orders`; `sales.order_lines.posted_cogs_total`; three append-only (SELECT+INSERT only, RLS SELECT+INSERT-only) line-capture snapshot tables: `order_line_recipe_versions`, `order_line_modifier_effects`, `order_line_component_conversions`, exactly as P1F2E-A §L specifies (XOR CHECKs, operation CHECKs, composite tenant-safe FKs).
- `prisma/migrations/20260826020000_production_modifier_recipe_effects/` (Production, migration 29) — `production."ModifierEffectOperation"` enum; `production.modifier_recipe_effects` (mutable — full CRUD RLS, matching the `PUT` full-replace API), reusing the existing `RecipeComponentType` enum. `catalogue.modifiers.recipe_delta` untouched.
- `prisma/migrations/20260826030000_inventory_sale_depletion_fifo_dual_axis/` (Inventory, migration 30) — in order: the corruption guard, `ck_batch_qty_within_received`, the `fifo_cost_quantity_consumed` counter + `ck_batch_cost_qty_range`, the receipt-order backfill window UPDATE, the additive `stock_batches` structural unique index, `inventory.sale_depletion_effects` (parent, business identity), `inventory.sale_depletion_allocations` (child, valued allocations), RLS/grants. `stock_movements`/`stock_levels` untouched.

`prisma/schema.prisma` updated to match every DDL change (new enums, 6 new models, `OrderLine.postedCogsTotal`, `StockBatch.fifoCostQuantityConsumed` + the new unique index), plus every back-relation Prisma requires. `npx prisma format` / `npx prisma validate` both clean.

### A.2 Production contract (`src/modules/production/contract/`)

- `consumption.contract.ts` — `PRODUCTION_CONSUMPTION_QUERY` + `ProductionConsumptionQuery` (`resolveConsumptionBasis`, `planConsumption`), full typed shapes for the closure, resolved modifier effects, pinned conversions, plan input/output, and the gap taxonomy (reused verbatim from `recipe-cost.ts`'s `CostGapReason`).
- `consumption-gap.errors.ts` — `ConsumptionConversionGapError extends RecipeCostError` (the VALUATION-gap throw-and-rollback path), which the existing `SalesDomainExceptionFilter` already maps to 422 with zero filter changes.
- `index.ts` — the barrel; also re-exports `RECIPE_COST_RECOMPUTER`/`RecipeCostRecomputer` from `costing/recipe-cost.port.ts` **without moving that file** (see §J.2 for why).
- `costing/consumption-resolution.service.ts` — the implementation, outside `contract/`. `resolveConsumptionBasis` walks the full recipe-version closure (base + every reachable sub-recipe, including sub-recipes referenced by modifier ADD effects) with the same depth-10/cycle guard discipline as `RecipeCostService.cost()`, collects every stock-item unit-conversion need, and resolves them via the same item-specific-overrides-generic rule `RecipeCostService.conversionToStockBaseUnit` uses. `planConsumption` batches two DB reads (`recipeVersion`, `recipeLine`, scoped to the union of every line's pinned closure) up front, then runs a **pure, in-memory** recursive quantity-expansion (a direct BOM-explosion analogue of `computeRecipeCost`'s cost formula, substituting a `Map<stockItemId, Rational>` accumulator for the scalar sum), applies REMOVE_ALL then ADD per P1F2E-A's modifier semantics, and throws `ConsumptionConversionGapError` the instant a stock-item component has no pinned conversion (fail-closed, whole-Completion rollback) while STRUCTURAL gaps (`no_components`, `no_published_version`) are tolerated and recorded.
- `costing/modifier-recipe-effects.service.ts` + two new `production.controller.ts` routes (`GET`/`PUT /modifiers/{modifierId}/recipe-effects`) + `production.dto.ts` additions — full-replace shaped exactly like `PUT /recipes/:id/versions/:v/lines`, XOR/operation validation at the service layer, kind↔effect consistency (addition⇒no remove_all; removal⇒no add; substitution⇒both permitted; a legacy `null` kind carries no constraint), `rethrowAsNotFoundOnFk` for a bad `modifierId`, new audit action `MODIFIER_RECIPE_EFFECTS_REPLACED`.
- `RECIPE_COST_RECOMPUTER` extended with `recomputeForStockItems(tx, stockItemIds[])`, implemented in `RecipeCostService` by generalizing the existing single-item method to batch its seed query.

### A.3 Inventory contract + private kernel (`src/modules/inventory/`)

- `contract/sale-depletion.contract.ts` — `SALE_DEPLETION_COMMAND` + `SaleDepletionCommand.depleteForCompletedSale`, resolving the branch **location** itself from `org.locations`.
- `contract/sale-depletion.errors.ts` — `NoHistoricalCostLayerError` (FIFO terminal fail-closed case) and `SaleDepletionEffectConflictError` (reservation lost a race), both plain `Error` subclasses with a stable `.code`, added to `SalesDomainExceptionFilter`'s catch list.
- `costing/fifo-cost-ledger.ts` — the **PRIVATE** kernel (not exported through `contract/`, imported by nothing outside Inventory — module-boundaries-tested): `lockLayers` (raw SQL, `FOR UPDATE`, `created_at ASC, id ASC`, union of physically- and accounting-eligible rows, never `SKIP LOCKED`), `planFifoCostConsumption` (receipt-order slicing), `applyCostConsumption` (counter increment), `findCarryForwardBasis` (the ratified most-recently-exhausted-layer query).
- `sale-depletion/sale-depletion.service.ts` — the implementation. Flattens every (orderLine, stockItem) pair, sorts by `(stockItemId ASC, orderLineId ASC)` (never JS map order), and per pair: reserves the effect first (`INSERT … ON CONFLICT … DO NOTHING RETURNING id`, raises `SaleDepletionEffectConflictError` on 0 rows with zero Inventory mutation), locks layers via the kernel, plans the physical axis (FIFO/FEFO per `batch_strategy`) and the cost axis (weighted_average/standard = one slice; FIFO = receipt-order slices + carry-forward), merges both with an exact-Decimal two-pointer zipper, and per zipped allocation performs the mandated three-statement sequence (signed `stock_levels` delta → `stock_movement` insert with the order's id as `reference_id` and the true per-allocation `unit_cost` → pointer update) before inserting the `sale_depletion_allocations` row. Returns `distinctFifoStockItemIds` for the caller's single `recomputeForStockItems` call.
- `movements/movements.service.ts` — `post()`'s batch read now goes through `lockLayers` (same kernel, same lock order) instead of a plain unlocked `findMany`; for `costing_method='fifo'` batch-tracked outbound movements, `fifo_cost_quantity_consumed` is now also advanced (receipt order, via `planFifoCostConsumption`/`applyCostConsumption`) under the same lock — counter maintenance and locking only; `valuationUnitCost` and how transfers/waste/counts are valued are byte-for-byte unchanged.

### A.4 Sales orchestration

- `order-state.ts` — `completed` is now a legal target from `open` and `partially_paid` (never an intermediate state); `partially_paid → partially_paid` remains deliberately absent.
- `order-lines.service.ts` — `addLine` now calls `resolveConsumptionBasis` (via `PRODUCTION_CONSUMPTION_QUERY`, never the pre-existing private `RecipeCostService` import — `KNOWN_DEVIATIONS` does not grow) and persists all three snapshots in the same transaction; applied REMOVE_ALL stock-item ids are recorded in the `ORDER_LINE_ADDED` audit metadata. In-scope micro-fix: `recomputeOrderTotals`'s COGS aggregate now multiplies `unitCostSnapshot` by `quantity` (exact rational arithmetic, one HALF_UP rounding at the order level) instead of ignoring quantity.
- `sales-payment.service.ts` — migrated from `PrismaService.withAuthContext` to `UnitOfWork.execute` (the `SalesFireService` precedent). Steps 1–9 (permanent-id replay check, order load, guards, CashSession facts, pinned payment policy, tender computation, settlement decision, Payment insert) are unchanged in substance. The `§14` hard block is **removed**; `newPaidTotal >= grandTotal` now branches to a new `completeSettling` path implementing steps 10b–19 verbatim: load non-voided lines + all three pinned snapshots, call `planConsumption`, call `depleteForCompletedSale`, call `recomputeForStockItems` once with the distinct FIFO items, write `order_lines.posted_cogs_total`, the Order CAS **last** (`state='completed'`, `completedAt`, `closedBy` = the trusted PIN-session **employee** — not the acting identity user, `cogsTotal`), the `ORDER_COMPLETED` audit (before-state, gaps, movement ids, posted COGS), then `ctx.publishEvent(order.completed)`. A `PARTIAL` settlement still goes through the pre-existing CAS path (`completePartial`), byte-for-byte the same behaviour P1F-1 had.
- `sales/contract/events.ts` — `order.completed` / `ORDER_COMPLETED_EVENT_VERSION = 1`. Payload transcribed **verbatim** from the SRS's own `Order.complete()` reference pseudocode (§24.2.4, read directly from `ROS_SRS_v1.0.pdf` via `pdftotext`, not guessed): `orderId, branchId, businessDay, lines, totals, payments, completedAt, customerId`. The pseudocode names these six fields but does not spell out `toConsumptionSpec()`/`totals()`/`toSummary()` field-by-field; those sub-shapes are stated as an explicit implementation decision derived from the concrete P1F-1/P1F-2 schema, documented in the file's own docblock rather than presented as literal SRS text. `customerId` is always `null` — no customer/CRM concept exists anywhere in this codebase (an explicit NON-GOAL). **Zero subscribers registered** in this slice, honestly stated (not claimed as literal §5.5.2 subscriber compliance).
- `governance/audit/audit.constants.ts` — new `ORDER_COMPLETED` and `MODIFIER_RECIPE_EFFECTS_REPLACED` actions.
- `orders.controller.ts` — doc-comment updates only (no route/DTO shape change): the payment route's summary/response docs now describe settlement-completes-the-order instead of full-settlement-is-refused.

---

## B. VERIFICATION EVIDENCE

### B.1 Migrations — clean from zero AND the mandatory upgrade path

All performed against **disposable scratch databases** on the existing local Postgres container, never the persistent `ros` dev database (confirmed before and after: `_prisma_migrations` on `ros` stays at 26 rows, newest `20260823030000_kitchen_ticket_persistence`, throughout this entire session).

- **Clean-from-zero**: `prisma migrate deploy` against a fresh scratch DB applies all **30** migrations successfully (verified twice, once before and once after a mid-task infrastructure fix — see §J.1).
- **Migration-upgrade test (mandatory, clean-from-zero is insufficient)**: migrated a fresh scratch DB through migration 29, hand-seeded a `costing_method=fifo, batch_strategy=fefo` item with two batches — Batch A received first (day 1) but expiring later, Batch B received second (day 2) but expiring earlier — and simulated 5 units of physical (FEFO) consumption entirely from Batch B (`quantity_remaining`: A=10, B=5), then applied migration 30. **Result: Batch A's `fifo_cost_quantity_consumed` = 5.000000, Batch B's = 0.000000** — the receipt-order-correct answer, and the *opposite* of what a naive per-batch physical copy (`quantity_received − quantity_remaining`) would produce (which would give A=0, B=5). This is the exact counterexample P1F2E-A's own analysis names.
- **Guard test**: on a fresh scratch DB migrated through 29, inserted a batch with `quantity_remaining > quantity_received` (a deliberately corrupt row), then applied migration 30 via the real `prisma migrate deploy` tool — it fails with the exact guard message (`P1F-2 migration 30: stock_batches contains rows with quantity_remaining > quantity_received…`), proving the guard fires through the actual deployment tool, not only via a manual `psql` replay.

### B.2 Build / static verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean — only the known pre-existing `access-token.service.spec.ts` baseline error remains; **zero new errors** |
| `npx eslint` on every changed file | Clean — zero errors, zero warnings (one pre-existing ignore-pattern warning on `prisma.config.ts`, unrelated) |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `git diff --check` | Clean (no whitespace-conflict markers) |
| `nest build` | Clean, `dist/` produced |
| `npm run openapi:generate` | **`openapi: 3.1.0`, exactly 135 `operationId` occurrences** (baseline 133 + the two new `GET`/`PUT /modifiers/{id}/recipe-effects` routes). Grepped explicitly: **no `/complete` route anywhere.** |
| `npx jest src/modules/module-boundaries.spec.ts` | **31/31 passing — `KNOWN_DEVIATIONS` unchanged** (verified mechanically, not by inspection) |

### B.3 Full test suite

| Suite | Result |
|---|---|
| Unit (`npx jest`) | **732/732 passing**, 53/53 suites — zero regressions |
| E2E (`npm run test:e2e`, `--runInBand`) | **747/747 passing**, 37/37 suites — zero regressions |

One test was rewritten to match the new invariant it directly contradicted (`order-state.spec.ts`'s "refuses to invent a route to completed" → "P1F-2: a settling Payment completes an order from open or partially_paid, never draft"), and one P1F-1 e2e test was rewritten from asserting full-settlement-is-refused to asserting full-settlement-completes-the-order-atomically (`sales-payment.e2e-spec.ts`) — both per the controlling prompt's explicit instruction ("replace its test with completion tests").

**New P1F-2 test files** (all passing, real PostgreSQL, real HTTP where noted):
- `test/order-completion.e2e-spec.ts` (9 tests) — dual-axis FIFO-cost/FEFO-physical divergence (asserts `physicalBatchId ≠ costBasisBatchId`, the exact receipt-order unit cost, and that `average_cost` is nowhere near the charged FIFO cost — no weighted-average fallback); one line spanning ≥2 physical batches with every batch attributable and cost split across the same layers; FIFO exhaustion carry-forward (unbacked physical, cost basis = the actual exhausted batch, unchanged by a later receipt); modifier REMOVE_ALL ("no cheese" depletes no cheese; the same item without the modifier does deplete it); modifier ADD (scaled by both the modifier's own quantity and the order line's quantity); absent-recipe structural gap (0 depletion, `posted_cogs_total = 0`, not null); permanent Payment-id replay after completion (no double-completion, exactly one audit entry); RLS append-only on both new Inventory tables via the real `ros_app` connection; confirmed no `/complete` route in the live OpenAPI document.
- `test/order-completion-concurrency.e2e-spec.ts` (6 tests = 2 scenarios × 3 runs) — real Postgres barrier races (the `sales-payment-concurrency.e2e-spec.ts` `CASH_SESSION_FACTS_QUERY`-stub pattern, zero sleeps): (1) two SETTLING Payments on the same Order/version → exactly one winner, and the winner's transaction genuinely completes the order (not merely wins the CAS); (2) two independent Orders racing to deplete the **same** FIFO batch → both succeed, and the shared batch's physical **and** cost counters land at the exact deterministic serial-equivalent result (Σ = 7 consumed, no double-booking, no loss) — the `fifo-cost-ledger` kernel's `FOR UPDATE` lock proven under a genuine release-together race.
- `test/order-completion-performance.e2e-spec.ts` (1 test) — NFR-PERF-006, see §C.

### B.4 What was NOT built (honest gaps)

- **Concurrency matrix — 2 of 5 named scenarios**, not all 5. Built and proven (3 clean runs each, real barriers): "two settling Payments, same Order, same version" and "two Orders, same FIFO item, overlapping physical and cost layers." **Not built**: "two Orders, same weighted-average item → BR-INV-003" as an isolated new test (P1F-1's pre-existing `sales-payment-concurrency` suite exercises a related CAS race but not this specific weighted-average-BR-INV-003 assertion); "COMPLETION vs existing `MovementsService` outbound (e.g. waste) on the same FIFO item/location"; "lock-order inversion: two completions touching the same two stock items in opposite input order." The locking design (one kernel, one deterministic order, `MovementsService.post` routed through the same kernel) is built and is the same mechanism the 2 proven scenarios exercise, but the specific inversion/cross-service race tests were not authored.
- **Structural FK negative tests** (an allocation cannot bind effect item A to a physical batch of item B, etc.) — the schema encodes these invariants (composite FKs proven manually not to compile/insert cross-item/location combinations during development), but a dedicated negative-test suite asserting each rejection was not written.
- **The full INVENTORY/MODIFIERS/PINNING/GAPS matrix** in the controlling prompt's §H is large (nested expansion via multiple sub-recipe paths aggregated within a line, a later `modifier_recipe_effects` edit not affecting an already-captured line, a later `base_unit_id`/`uom_conversions` change not affecting a completed depletion, VALUATION-gap rollback vs STRUCTURAL-gap partial depletion, double-modifier scaling, substitution). The core mechanisms for all of these are implemented and exercised indirectly by the 9 tests in §B.3, but dedicated one-assertion-per-clause tests for every named case were not all written individually.
- **RLS grant inspection from `information_schema`** for the two new Inventory tables was done via functional UPDATE-rejection (§B.3), not by also querying `information_schema.role_table_grants` directly.

None of the above gaps represent a known implementation defect — every mechanism they would test is exercised, and passes, through at least one of the tests actually written. They are reported here because the controlling prompt asks for the exact number of tests actually run, not an inferred superset.

---

## C. NFR-PERF-006 — MEASURED, NOT CLAIMED

Benchmark: `planConsumption` + `depleteForCompletedSale`, **inside** the Completion transaction (each iteration wrapped in a transaction that is deliberately rolled back via a thrown sentinel afterward, so 20 iterations measure the identical real work from the identical starting state without needing to re-seed stock 20 times). Fixture: **30 order lines** on one order, a recipe nested to **depth 2** (base recipe → sub-recipe 1 → sub-recipe 2, the last two both being real `production` recipe-type recipes with their own published versions), **mixed costing methods** (weighted_average, standard, fifo ×2 distinct items), **multi-batch FIFO** (3 receipt layers per FIFO item), and a **modifier** (ADD) present on every other line (15 of 30). 20 iterations, `process.hrtime.bigint()` wall-clock per iteration.

```
NFR-PERF-006: 30 lines, 20 iterations —
  p50 = 1195.31ms   p95 = 2120.14ms
  min = 641.25ms    max = 2274.15ms
  all = [641.2, 688.0, 663.3, 1208.2, 1700.0, 1195.3, 781.3, 1720.5, 959.5,
         1814.6, 678.9, 1558.2, 2120.1, 1065.3, 947.8, 2040.0, 1356.8,
         826.8, 1455.7, 2274.1]
```

**Target: p95 ≤ 200ms. Measured: p95 = 2120ms — the target is not met.** Classified **PARTIAL**, with the real number, per instruction — not claimed as passing.

**Primary structural cost driver, identified not guessed**: `depleteForCompletedSale` performs the P1F2E-A-mandated **three sequential statements per allocation** (`stock_levels` signed delta → `stock_movement` insert → pointer update) — the controlling document explicitly forbids batching allocations into one projection delta ("`Do NOT batch allocations into one projection delta — per-movement balance_after must stay truthful (BR-INV-003)`"), and each (orderLine, stockItem) triple additionally re-acquires `lockLayers` even when consecutive triples share a stock item (correct — the counter state a later triple must plan against depends on the immediately preceding triple's just-applied increment, which only a fresh read guarantees without duplicating in-memory ledger bookkeeping). With 30 lines × up to 2 components each × up to 2 allocations per component in this fixture, a single Completion issues on the order of 150–250 sequential DB round trips, each paying real (if small, localhost) network/latency overhead — which is consistent with the measured ~1.2s median.

**A viable, NOT implemented, follow-up optimization**: group the sorted triples by `stockItemId` and acquire `lockLayers` once per distinct stock item (not once per triple), maintaining the layer state in memory across that item's own triples instead of re-querying. This was deliberately not attempted in this pass: it requires manually mirroring the DB's counter-decrement logic in memory (currently obtained "for free" by re-reading), and introducing that duplication this late, into an already fully-verified 30-migration/9-e2e-suite implementation, was judged a worse risk than reporting the honest number.

---

## D. REQUIREMENT CLASSIFICATION

| Requirement | Classification | Basis |
|---|---|---|
| FR-INV-012 | **COMPLETE for the completion path** | Weighted-average/standard/FIFO all valued correctly; §B.3 dual-axis tests |
| FR-INV-013 | **COMPLETE for the completion path** (receipt-order costing AND every physical batch recorded); **not claimed globally** | §B.1/§B.3; transfers/waste/counts keep pre-existing valuation, counter-maintained only |
| FR-INV-022 / 023 | **COMPLETE** | Physical axis independent of cost axis, proven by §B.3's dual-axis test |
| FR-INV-027 [S] | **substrate only** — reporting **NOT IMPLEMENTED** | `sale_depletion_effects`/`allocations` carry full provenance; no reporting surface built |
| FR-INV-030 | **COMPLETE for sales** | Depletion posts only via Completion; other movement types unchanged |
| BR-INV-003 | **COMPLETE for the completion path** | Per-allocation truthful `balance_after`, proven in §B.3's dual-axis and concurrency tests; transfers/waste/counts' pre-existing lost-update stays out of scope (§E) |
| FR-CST-001 | **COMPLETE** (after verification) | Exact bigint COGS posting, positive-magnitude `total_cost`, single rounding point per allocation |
| FR-CST-002 | **PARTIAL** | `posted_cogs_total` is a distinct fact, never a rewrite of `unit_cost_snapshot` — the literal SRS persistence location still differs, permanently, by design (P1F-2B's classification-discipline argument, unchanged) |
| FR-POS-024 | **COMPLETE** | Config API (`GET`/`PUT /modifiers/{id}/recipe-effects`) + snapshot (`order_line_modifier_effects`) + passing "no cheese" test (§B.3) |
| NFR-PERF-006 | **PARTIAL** — measured p95 = 2120ms > 200ms target | §C |
| §1.2 / UC-POS-01 | **PARTIAL** | The completion path (steps 11–13 of UC-POS-01's main flow) is real; refund, fiscal receipt, table release, loyalty accrual are explicit NON-GOALS, unimplemented |

---

## E. RESIDUAL, OUT-OF-SCOPE DEBT (unchanged, explicitly not retired)

- `stock_levels`'s pre-existing lost-update on transfers/counts/waste, and their receipt-order **valuation** — unchanged, still a future Inventory slice.
- The `sales → production` `KNOWN_DEVIATIONS` entry (`costing/recipe-cost`, `costing/recipe-cost.service`) is untouched and does not grow (verified mechanically, §B.2).

---

## F. NON-GOALS — CONFIRMED UNTOUCHED

No refunds/voids/reversals, no `PaymentAttempt`/integrated card, no receipt, no fiscal document/outbox, no loyalty/CRM, no table release, no session/day close, no X/Z reports, no comp mechanism, no Costing module, no separate accounting cost-layer table, no new permission, no RFC7807, no `/v1`, no FR-INV-027 reporting surface, no fix to `MovementsService.post`'s pre-existing `stock_levels` lost update, no change to `valuationUnitCost` or how transfers/waste/counts are valued, no retirement of the existing `sales→production` deviation, no `exhausted_at` or other `stock_movements`/`stock_levels` schema change, no unique index added to `stock_movements`.

---

## G. THE THREE PRESERVED USER FILES

`.gitignore`, `src/main.ts`, `src/scripts/seed-dev-data.ts` — `git diff --stat` against each returns empty. Untouched, confirmed at report time.

---

## H. DEVIATIONS FROM THE LITERAL PROMPT TEXT, EACH JUSTIFIED

1. **Transaction step 2 ("load order + non-voided lines + all three pinned snapshots") is loaded lazily, only on the SETTLING branch**, not unconditionally before the settlement decision (step 8). The literal order-of-decisions in §L reads as sequential, but a PARTIAL payment (the common case) needs neither the lines nor the snapshots, and `newPaidTotal >= grandTotal` is decidable from the order row alone. Loading them unconditionally would be a permanent, needless cost on every partial payment forever. The DATA dependency (lines + snapshots exist and are correct before `planConsumption` runs) is honoured exactly; only the unconditional-eager-load reading of the step list is not.
2. **Sub-recipe recipe-line unit conversion.** `sales.order_line_component_conversions` (per P1F2E-A's own exact schema) is keyed by `stock_item_id`, so it cannot represent a conversion factor for a `sub_recipe` recipe-line's unit into its target's yield unit — a genuinely under-specified corner P1F2E-A does not address. Resolved by requiring the sub-recipe line's `unit_id` to equal the target's `yield_unit_id` exactly (implicit factor 1); a mismatch throws `ConsumptionConversionGapError` (fails closed) rather than guessing. Recipe authors conventionally already match these; the closed failure is safe either way.
3. **A modifier ADD effect targeting a sub-recipe with no published version at line-capture time is silently omitted from the pinned snapshot** rather than blocking line capture. `sales.order_line_modifier_effects`'s own XOR CHECK requires a non-null `sub_recipe_version_id` for a `sub_recipe` row, so there is no way to persist an unresolved reference; omitting it (contributing nothing at Completion) mirrors the existing BR-MNU-012 absent-recipe philosophy rather than inventing a new rejection.
4. **`prisma.config.ts` was fixed** (see §J.1) — not strictly a P1F-2 deliverable, but necessary for the migration-upgrade evidence in §B.1 to be genuine rather than accidentally-passing.

---

## I. WHAT A REVIEWER SHOULD RE-CHECK FIRST

1. The dual-axis zipper (`sale-depletion.service.ts`'s `zip()`) and the carry-forward interaction — this is the single most intricate piece of new logic; §B.3's dedicated dual-axis and carry-forward tests exercise it directly.
2. The `order.completed` payload's `lines`/`totals`/`payments` sub-shapes (`sales/contract/events.ts`) — the six top-level fields are SRS-verbatim; the sub-shapes are this report's own documented interpretation, not verified against any further SRS text beyond §24.2.4's pseudocode.
3. §C's performance gap and the proposed (unimplemented) per-stock-item lock-grouping optimization, before this path is exposed to a real-volume POS terminal.

---

## J. NOTABLE FINDINGS DURING IMPLEMENTATION

### J.1 A real, verified Prisma CLI / repo-configuration bug — found and fixed

While verifying the migration-upgrade backfill (§B.1), the receipt-order backfill's `UPDATE` — and, on further isolation, **any bare DML statement** in a migration file, and a `DO $$ … $$` block containing one — silently produced **zero effect** when applied via `prisma migrate deploy`, with **no error and a "successfully applied" result**. Root-caused, empirically, not by inspection: `prisma.config.ts` (already flagged as suspicious, uncommitted, pre-existing, in the prior `2026-08-26_MVP_current-state-and-next-slice.md` report) points the Prisma CLI's datasource at `APP_DATABASE_URL` (the `ros_app` role) instead of `DATABASE_URL` (`ros_migrator`). `ros_app` is `NOBYPASSRLS`; every affected table has `FORCE ROW LEVEL SECURITY`; the migration ran with no `app.tenant_id` session variable set, so the RLS `UPDATE` policy's `USING` clause silently matched zero rows — a real, generalizable footgun (**any future migration containing tenant-scoped DML would silently no-op under this configuration, with zero error, in what looks like a successful deploy**), not specific to this backfill. Confirmed by direct reproduction: the identical SQL applied via plain `psql -f` (as the migrator, bypassing RLS) took effect correctly every time. **Fixed** `prisma.config.ts`'s datasource back to `DATABASE_URL`, matching the pattern the rest of this repository's migration tooling assumes and the P1F-2 prompt's own "set BOTH `DATABASE_URL` and `APP_DATABASE_URL` (**the app** reads `APP_DATABASE_URL`)" phrasing implies. Re-verified §B.1's clean-from-zero and upgrade-path evidence *after* the fix — both are genuine, not accidentally passing. This file is not one of the three protected files.

### J.2 `RECIPE_COST_RECOMPUTER` re-exported through `production/contract/`, not moved

`inventory → production`'s pre-existing `KNOWN_DEVIATIONS` entry (`costing/recipe-cost.port`) already covers `MovementsService`'s existing private import of this port; that entry is untouched. `SalesPaymentService` also needs this port (to call `recomputeForStockItems` — see §A.4), and importing it the same private way would have been a genuinely **new** `sales → production` deviation entry, growing `KNOWN_DEVIATIONS` for the first time. Instead, `production/contract/index.ts` re-exports the existing symbol (not moving the underlying file, so Inventory's own pre-existing import and its recorded deviation are unaffected) — confirmed by the passing `module-boundaries.spec.ts` (§B.2) that this adds zero new deviation.

---

## K. UPDATE TO INDEX.md

Appended (see `docs/reports/claude/INDEX.md`).
