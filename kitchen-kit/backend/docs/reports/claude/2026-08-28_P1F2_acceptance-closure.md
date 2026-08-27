# P1F-2 — Acceptance Closure

**Report type:** Narrow verification/correction pass over the already-implemented P1F-2 (no redesign, no new slice)
**Authority statement:** This report is **non-authoritative evidence**. Authority order is **SRS → ratified governance → accepted design → repository evidence**. The controlling design document remains `docs/reports/claude/2026-08-25_P1F2E-A_inventory-acceptance-correction.md` §L. This report does not create or amend governance and does not redesign P1F-2; it completes the verification matrix the prior implementation report (`2026-08-26_P1F2_order-completion.md`) itself listed as missing, and investigates one open finding.
**Date:** 2026-08-28
**HEAD:** `9aa7a880229938bffd2d5dc0dfcb3d263da060e8` (unchanged throughout — no commit)
**Branch:** `feat/production-spec`
**Working tree at report time:** the pre-existing uncommitted P1F-2 implementation (migrations 28–30, ~20 `src/` files, prior test files, regenerated OpenAPI, `prisma.config.ts`) **plus this session's additions**: one production-contract field + two small `src/` edits (§I below), four new e2e test files (46 new tests), this report, `INDEX.md`. **Nothing committed, nothing pushed.**
**Task identifier:** P1F-2 acceptance closure

> ## VERDICT
> ## **IMPLEMENTATION DEFECT FOUND**
> One genuine, verified implementation defect was found during §I's investigation
> (a modifier ADD effect targeting an unpublished sub-recipe was silently and
> completely forgotten — not preserved as a structural gap anywhere). It has been
> **fixed** within the existing accepted contracts (no migration, no new
> persistence concept, no governance change) and is now tested. Every other
> mandatory verification this closure pass was scoped to cover is now **complete
> and green**: the full 5-scenario × 3-run concurrency matrix, all 5 structural
> FK negative proofs + the service-enforced movement-binding test, all 9 named
> historical-pinning/gap-semantics/modifier-composition tests (A–I), and full
> RLS/append-only/grants verification on all 5 P1F-2 tables (21 tests). 46 new
> tests, all real PostgreSQL, all passing. Migrations remain exactly 30; OpenAPI
> remains exactly 3.1.0/135 with zero drift; `tsc`/`eslint`/`prisma validate`/
> `nest build`/`git diff --check`/module-boundaries are all clean. Full
> regression: **732/732 unit, 793/793 e2e** (747 baseline + 46 new), zero
> regressions. NFR-PERF-006 stays classified **PARTIAL** (not re-measured — this
> pass changed no code on the Completion execution path). The persistent local
> `ros` dev database was never migrated (confirmed unchanged before and after:
> still 26 `_prisma_migrations` rows).

---

## A. STARTING STATE

| Check | Result |
|---|---|
| `git status --short` | Matches the state recorded at task start: `M` on 22 files (P1F-2's own uncommitted work) + several `??` new P1F-2 files (migrations, contract/ dirs, 3 prior test files, 2 prior reports) |
| `git branch --show-current` | `feat/production-spec` |
| `git rev-parse HEAD` | `9aa7a880229938bffd2d5dc0dfcb3d263da060e8` (unchanged throughout this session) |
| `git diff --stat` | 22 files changed, 1822 insertions(+), 247 deletions(-) at report time (grew only via this session's 3 `src/` edits; no line changed in any file this closure pass did not touch) |

All P1F-2 changes from the prior session were preserved exactly as instructed — nothing reverted, reset, stashed, cleaned, discarded, or overwritten. Everything in this report is genuinely new evidence produced in this session, or an explicit re-statement of a fact re-verified in this session (never an old result presented as new).

---

## B. MISSING EVIDENCE FROM THE PRIOR REPORT — WHAT THIS PASS CLOSES

`2026-08-26_P1F2_order-completion.md` §B.4 listed five honest gaps. This pass closes all five:

1. Concurrency matrix — 2 of 5 scenarios built → **now 5 of 5**, each ≥3 clean runs (§C/D/E below; §D and part of §C/E are the 3 new scenarios).
2. Structural FK negative tests — none written → **now 6 tests** (5 negative FK proofs + 1 explicitly-labelled service-enforced test) (§F).
3. The full modifier/pinning/gap test matrix — mechanisms exercised indirectly, no dedicated per-clause tests → **now 10 dedicated tests**, one per named clause A–I plus the §5 finding (§G).
4. `information_schema.role_table_grants` inspection — done only via functional UPDATE-rejection → **now directly queried** for all 5 P1F-2 tables, plus full SELECT/cross-tenant/UPDATE/DELETE/row-survival verification (§I of P1F2E-A's test list; §H below).
5. The modifier sub-recipe gap (`2026-08-26_P1F2_order-completion.md` §H.3) — was reported but not investigated → **investigated exhaustively, classified, and fixed** (§I below).

---

## C. WEIGHTED-AVERAGE CONCURRENCY (BR-INV-003 completion path)

`test/order-completion-concurrency-2.e2e-spec.ts`, scenario A, 3/3 runs green.

Two independent Orders race to complete against the **same** `weighted_average`, **non-batch-tracked** stock item and location (deliberately the *opposite* configuration from the FIFO-batch scenario the prior session already proved, so this is a genuinely distinct code path: `fifo-cost-ledger.lockLayers` finds zero batch rows for this item, so the **sole** race-safety mechanism under test is `SaleDepletionService.writeAllocation`'s atomic `INSERT ... ON CONFLICT DO UPDATE SET quantity_on_hand = quantity_on_hand + EXCLUDED.quantity_on_hand` delta-projection).

Barrier: the existing `CASH_SESSION_FACTS_QUERY` mutual-arrival stub (both Payments release together, well before either reaches its projection write).

Asserted, every run: both Orders complete; `average_cost` is byte-identical to its pre-race value (outbound never changes it); `SUM(stock_movements.quantity) == stock_levels.quantity_on_hand` exactly (BR-INV-003, no lost update); exactly 2 `sale_depletion_allocation` rows, each carrying the **same, unchanged** weighted-average `unit_cost` (never a value from the other order's own in-flight delta); posted COGS on each line uses that same unchanged value.

## D. COMPLETION vs MOVEMENTSSERVICE OUTBOUND CONCURRENCY (C-17)

`test/order-completion-concurrency-2.e2e-spec.ts`, scenario B, 3/3 runs green.

A `waste` movement (via `MovementsService.postStandalone`, **not** the Completion path) races a settling Order Completion on the **same FIFO item/location**, both touching the same shared batch row.

Barrier design (a genuine, cross-connection Postgres lock wait, not app-level serialization):

1. A one-shot gate wraps `RECIPE_COST_RECOMPUTER.recomputeForStockItem` (bound via `.overrideProvider(RECIPE_COST_RECOMPUTER).useFactory(...)`, wrapping the real `RecipeCostService` so **both** `MovementsService.post` and `SalesPaymentService`'s own recompute call reach the same gated instance). `MovementsService.post` calls this **after** its own `lockLayers`/batch/counter mutation but **before COMMIT**, so pausing there holds the `FOR UPDATE` row lock open for the whole pause.
2. The test starts the waste movement, awaits the gate's "lock acquired" signal, then starts the racing Completion.
3. Before releasing the gate, the test polls (never a fixed sleep as the correctness proof) until a **real, distinct Postgres backend** is genuinely blocked — verified via `pg_stat_activity.wait_event_type = 'Lock'` on a backend whose own query text names `stock_batches`.

   **A real finding surfaced building this**: the first implementation polled `pg_locks WHERE NOT granted AND relation = 'stock_batches'::regclass`, which **never fires** — verified empirically with three real concurrent `psql` sessions (§ below) that a backend blocked on a row-level `FOR UPDATE` wait shows up in `pg_locks` as a `transactionid` wait (waiting on the **holder's XID**), with `relation` **NULL**, not a `tuple`/`relation` row scoped to the table. Confirmed directly:

   ```
   locktype       | relation | mode      | granted | pid
   transactionid   |          | ShareLock | f       | <waiter>
   ```

   The polling query was corrected to the unambiguous, relation-free signal above. Documented in the test file itself so a future reader does not repeat the same false start.
4. Only then does the test release the gate; both promises are awaited via `Promise.allSettled`.

Asserted, every run: both operations succeed; final `fifo_cost_quantity_consumed` equals the serial-equivalent result exactly (20 received − 3 waste − 5 sale = 12 remaining physical, 8 consumed on the cost axis); the counter never exceeds `quantity_received` (also DB-guarded by `ck_batch_cost_qty_range`); no layer double-consumed, none skipped; Completion's own allocation sums to exactly the sold quantity (no stale-queue read).

## E. LOCK-ORDER INVERSION (deadlock freedom)

`test/order-completion-concurrency-2.e2e-spec.ts`, scenario C, 3/3 runs green.

Two Orders' **own recipes** reference the same two FIFO stock items (X, Y) in **opposite line sequence** — Order A's recipe lists X then Y; Order B's lists Y then X — exactly the input P1F2E-A §L §H names. Both Orders' Completions are released together via the same mutual barrier as §C, racing to lock both shared batches.

Because `SaleDepletionService` **always** re-sorts its flattened (orderLine, stockItem) triples by `(stockItemId ASC, orderLineId ASC)` before processing — never JS map/array insertion order, and never the recipe's own line sequence — both Orders necessarily acquire the two shared batch locks in the **same** deterministic order regardless of how their own recipes were authored. This is the mechanism that makes a cross-wait cycle (and therefore a Postgres deadlock) structurally impossible, and this test is the first one to exercise it under a genuine simultaneous release rather than relying on the sort alone as an unverified claim.

Asserted, every run: both Orders' Completions succeed (a Postgres deadlock, had one occurred, would present as a rejection carrying SQLSTATE `40P01` on whichever side the deadlock detector picked as victim — none occurred, checked explicitly); both items' physical and cost counters land at the deterministic value (1 unit consumed per order per item, 2 total, on both axes, for both items); `SUM(stock_movements.quantity) == stock_levels.quantity_on_hand` for both items.

---

## F. STRUCTURAL FK NEGATIVE PROOFS (C-20)

`test/order-completion-structural.e2e-spec.ts`, 6/6 tests green.

Five real-PostgreSQL FK **rejection** proofs (each attempts a raw `INSERT` into `inventory.sale_depletion_allocations` under a real, previously-completed effect, and asserts the DB itself raises a foreign-key violation — not a service-level check):

1. `physical_batch_id` → a batch of a **different stock item** → rejected.
2. `physical_batch_id` → a batch at a **different location** → rejected.
3. `cost_basis_batch_id` → a batch of a **different stock item** → rejected.
4. `cost_basis_batch_id` → a batch at a **different location** → rejected.
5. **Cross-tenant**: an allocation row claiming `tenant_id = tenantB` while pointing at tenant A's real `effect_id` → rejected, because no `(tenant_id=tenantB, id=<that effect>, ...)` row exists in `sale_depletion_effects` — the tenant_id column embedded in every composite FK does the work, proven directly rather than inferred.

A sixth test is explicitly labelled and reported as **SERVICE-ENFORCED, NOT a DB-structural proof** (P1F2E-A §G's own conclusion — a 4th unique index on the RANGE-partitioned, highest-volume `stock_movements` table was deliberately rejected as a permanent tax on the hottest write path): it asserts, for every real allocation a genuine Completion writes, that the allocation's `stock_item_id`/`location_id` match its own `stock_movement` row's `stock_item_id`/`location_id` — true only because `SaleDepletionService` writes both from the same in-memory values in the same statement sequence, and the test's own comment says so, not claiming a DB invariant that does not exist.

---

## G. HISTORICAL PINNING / GAP SEMANTICS / MODIFIER COMPOSITION (A–I)

`test/order-completion-pinning.e2e-spec.ts`, 10/10 tests green (A–I plus the §5 finding test).

| Clause | What was proven |
|---|---|
| **A** | A `PUT /modifiers/{id}/recipe-effects`-equivalent edit (via `ModifierRecipeEffectsService.replace`, the supported path) doubling an ADD quantity **after** line capture does not change the already-captured line's depletion — the CAPTURED 0.10, never the edited 0.20. |
| **B** | A `base_unit_id` change (`StockItemsService.changeBaseUnit`, FR-INV-002-legal only while zero movements exist — used a `standard`-costed item so line capture needs no `stock_levels.average_cost`) after capture does not change the completed depletion quantity — still the pinned-factor interpretation (1000), unaffected by the later rename, confirmed the rename itself really took effect. |
| **C** | A live `uom_conversions.factor` mutation after capture does not change the completed depletion — still 1000 (the pinned factor), never the mutated 5. |
| **D** | **VALUATION gap.** A pre-existing line-capture-time cost check (`OrderLinesService.resolveUnitCost` via `RecipeCostService.cost()`) already refuses any **base-recipe** component lacking a valuation/conversion — so a genuine Completion-time `ConsumptionConversionGapError` is reachable only through a path that check never examines: a **modifier ADD** effect (resolveUnitCost prices only the base recipe, never modifiers). Built exactly that: a valid base recipe + a modifier ADD referencing a unit with no conversion anywhere. Line capture **succeeds** (invisible to the pre-existing check); Completion (`planConsumption`) throws and the WHOLE Payment transaction rolls back — proven: order state/version unchanged, `paidTotal = 0`, zero `OrderPayment` rows, zero `sale_depletion_effects`, zero `ORDER_COMPLETED` audit entries. |
| **E** | **STRUCTURAL gap** (`no_components` — a published recipe version with zero lines). The sale **completes** with zero depletion for that component (`posted_cogs_total = 0`, not an error); the gap is retained, findable, in the `ORDER_COMPLETED` audit's `gaps` array (`reason: 'no_components'`) — not silently treated as a clean success. |
| **F** | Same stock item reached via **two recursive paths within one line** (1 unit direct + 1 yield-unit of a sub-recipe contributing another 2 units) aggregates to **exactly one** `sale_depletion_effect` at 3.000000 — not two effects, not double-counted. |
| **G** | The same stock item on **two different order lines** stays independently attributable: two distinct `sale_depletion_effect` rows, each correctly quantified, never merged. |
| **H** | **Substitution**: REMOVE_ALL(beef) + ADD(chicken) in one modifier — beef fully removed (no effect row at all), chicken depleted at the ADD quantity. |
| **I** | **Double modifier scaling**: `effect.quantity (0.10) × order_line_modifier.quantity (2, selection count) × order_line.quantity (3)` = **0.60**, exact. |

---

## H. RLS / APPEND-ONLY / GRANTS (all 5 P1F-2 tables)

`test/order-completion-rls.e2e-spec.ts`, 21/21 tests green, all through the **real** `ros_app` connection (`app.get(PrismaService)`), never the migrator client for the assertions themselves.

Tables: `inventory.sale_depletion_effects`, `inventory.sale_depletion_allocations`, `sales.order_line_recipe_versions`, `sales.order_line_modifier_effects`, `sales.order_line_component_conversions`.

Per table (4 tests each, 20 total):
- **own-tenant SELECT succeeds** (count = 1); **cross-tenant SELECT returns zero rows** (same row id, different tenant context — a genuine filtering proof, not an absence-of-data coincidence: tenant B has its **own** real row from its own completed order, seeded identically).
- **own-tenant INSERT already succeeded via the real `ros_app` connection** — the fixture row's existence *is* the proof: it was written by the real app (`OrderLinesService`/`SalesPaymentService`), which uses the identical `PrismaService` instance this suite injects as its RLS-constrained connection, not a separate positive-control insert.
- **UPDATE is rejected** via the real `ros_app` connection; the row survives, unmodified (re-read after the rejected attempt).
- **DELETE is rejected** via the real `ros_app` connection; the row survives.

One combined test (21st) queries `information_schema.role_table_grants` directly for `ros_app` across all 5 tables: `SELECT` and `INSERT` present, `UPDATE`/`DELETE`/`TRUNCATE` all absent, on every one — the direct grants-catalog inspection P1F2E-A's test list required and the prior report did not do.

---

## I. THE MODIFIER SUB-RECIPE GAP — INVESTIGATION, FINDING, AND FIX

### What happens today (before this session's fix)

`ConsumptionResolutionService.resolveModifierEffects` (`src/modules/production/costing/consumption-resolution.service.ts`), for a modifier ADD effect whose `componentType = 'sub_recipe'`:

```ts
const published = e.subRecipeId ? await this.publishedVersionOf(tx, e.subRecipeId) : null;
if (!published) {
  continue;   // <-- dropped, before this session's fix, with zero trace
}
```

Answering the required questions directly:

- **Does `resolveConsumptionBasis` preserve this as a structural gap?** No. It is `continue`d out of the loop entirely — no gap object, no entry, nothing returned for it.
- **Can `planConsumption` later return `no_published_version` for this case?** No — not for *this* case. `planConsumption`'s `no_published_version` gap fires only when a `PinnedModifierEffectInput` with a non-null `subRecipeVersionId` fails to resolve against `versionsById` (i.e., a sub-recipe that *was* published at capture time, then somehow later became unresolvable). Since the unpublished-at-capture-time effect is never persisted into `sales.order_line_modifier_effects` at all, `planConsumption` never sees it, and this specific code path can never fire for it.
- **Is that gap present in the `ORDER_COMPLETED` audit?** No — `planConsumption`'s `gaps` output, which is what feeds the `ORDER_COMPLETED` audit's `gaps` array, only ever contains gaps `planConsumption` itself discovers; it has no visibility into anything dropped earlier at capture time.
- **Or is the modifier effect completely forgotten?** **Yes — completely forgotten.** Confirmed by direct code trace (above) and by a failing test written before the fix (which asserted zero evidence anywhere; the same test, adapted, is now the passing positive-evidence assertion in §G).

### Classification

**IMPLEMENTATION DEFECT FOUND** — a real, non-hypothetical modifier configuration (an ADD effect targeting a sub-recipe whose only version is `draft`, never published) silently loses all record of the operator's own configured intent, with zero audit trail, zero gap record, and zero test coverage before this session.

### Why the schema genuinely cannot express this as a persisted gap

`sales.order_line_modifier_effects`'s own `ck_olme_component_xor` CHECK requires a **non-null** `sub_recipe_version_id` for any `component_type = 'sub_recipe'` row — there is no way to insert a "this was configured but unresolvable" row into that table without either inventing a sentinel value (which would be a lie: it would claim a specific version was pinned when none was) or relaxing the CHECK (a schema/migration change).

### Fix — within the existing accepted contracts, no migration, no new persistence concept, no governance change

Extended `ResolveConsumptionBasisResult` (`src/modules/production/contract/consumption.contract.ts`) with one new field, `droppedModifierEffects: readonly DroppedModifierEffect[]` (`{modifierId, sequence, reason: 'no_published_version'}`) — an in-memory return value, not a new table or column. `ConsumptionResolutionService.resolveModifierEffects` now populates it at the exact point the effect used to vanish. `OrderLinesService.addLine` (`src/modules/sales/orders/order-lines.service.ts`) records it in the **existing** `ORDER_LINE_ADDED` audit entry's metadata (the same audit entry that already records applied `REMOVE_ALL` operations) — the `audit_entries` table and its arbitrary-JSON `afterState` column already exist and are already used for exactly this kind of "what the system knew at capture time" fact.

This is a genuinely narrow fix: no migration 31, no new table, no new column, no interface consumers broken (verified: `tsc --noEmit` clean, `module-boundaries.spec.ts` 31/31, `KNOWN_DEVIATIONS` unchanged), no schema/governance change. It does **not** convert this STRUCTURAL gap into a VALUATION failure — the sale still proceeds and completes exactly as before; the effect still contributes nothing to depletion. It only makes the drop **visible** at the one moment it is actually knowable (line capture), rather than leaving zero trace anywhere in the system.

### Test

`test/order-completion-pinning.e2e-spec.ts`, "§5 finding" test: creates a modifier ADD effect targeting a sub-recipe with only a `draft` version; asserts zero rows land in `sales.order_line_modifier_effects` for it (confirming the drop still happens, by design — the schema constraint is real); asserts the `ORDER_LINE_ADDED` audit's `droppedModifierEffects` metadata contains exactly one entry, `{modifierId, sequence: 1, reason: 'no_published_version'}`; asserts the sale still completes normally.

---

## J. FULL REGRESSION

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean — only the known pre-existing `access-token.service.spec.ts` baseline error; **zero new** |
| `npx eslint` on every file this session touched/added | Clean after `--fix` (formatting only); zero remaining errors, zero warnings |
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `npm run build` (`nest build`) | Clean |
| `npm run openapi:generate` then diffed against the working tree | **Byte-identical** to what was already on disk — `openapi: 3.1.0`, exactly **135** `operationId` occurrences, zero drift from this session's changes. No `/complete` route (`/catalogue/completeness` is the only near-match). |
| `git diff --check` | Clean (no whitespace-conflict markers) |
| `npx jest src/modules/module-boundaries.spec.ts` | **31/31 passing** — `KNOWN_DEVIATIONS` unchanged |
| Full unit suite (`npx jest`) | **732/732 passing**, 53/53 suites — zero regressions |
| Full e2e suite (`npm run test:e2e --runInBand`) | **793/793 passing**, 41/41 suites (747 baseline + 46 new: 9 concurrency + 6 structural + 10 pinning/gap + 21 RLS) — zero regressions |
| Clean-from-zero migration | A fresh scratch DB (`ros_scratch_closure_<ts>`, dropped after use), `prisma migrate deploy` with both `DATABASE_URL`/`APP_DATABASE_URL` pointed at it: **all 30 migrations applied successfully** |
| Persistent local `ros` DB | Confirmed untouched before and after this entire session: **still 26 `_prisma_migrations` rows**, newest `20260823030000_kitchen_ticket_persistence` |

---

## K. PERFORMANCE STATUS (NFR-PERF-006)

**Not re-measured this session.** Per instruction, the benchmark is rerun only if this closure materially changes the Completion execution path. This session's only `src/` changes are: one new return field on an existing contract method (an in-memory value, computed with a single array push inside an already-executing loop), and one additional field written into an already-existing audit-metadata object at line capture (not on the Completion path at all). Neither adds a database round trip, neither touches `planConsumption`/`depleteForCompletedSale`/`fifo-cost-ledger`. Classification stays **PARTIAL**, at the last measured real numbers: p50 ≈ 1195ms, p95 ≈ 2120ms, target ≤ 200ms (`2026-08-26_P1F2_order-completion.md` §C).

---

## L. MIGRATION / API INVARIANTS

- Migrations: **exactly 30** (28 Sales, 29 Production, 30 Inventory) — no migration 31 created; none was needed.
- OpenAPI: **3.1.0 / 135 operations**, zero drift, no `/complete` route, no new permission, no unrelated API — confirmed by direct regeneration-and-diff (§J).
- Persistent local `ros` DB: never migrated (§J).

---

## M. `prisma.config.ts` — EXACT STATUS

Diff (unchanged from the prior session; **not modified in this pass**):

```diff
-import { defineConfig } from "prisma/config";
+import { defineConfig, env } from "prisma/config";
 ...
   datasource: {
-    url: process.env["DATABASE_URL"],
+    url: env("DATABASE_URL"),
   },
```

This is the fix `2026-08-26_P1F2_order-completion.md` §J.1 already made and justified: `env("DATABASE_URL")` (Prisma's own config-file `env()` helper) is functionally equivalent to the previous `process.env["DATABASE_URL"]` and points the migration CLI at `ros_migrator` (correct — DDL/tenant-scoped-DML-capable), not `ros_app` (`NOBYPASSRLS`, would silently no-op tenant-scoped DML inside a migration with zero error, the exact footgun that report root-caused). Inspected fresh this session; no concrete factual defect was found in it, so per instruction it was left untouched. This file is not one of the three protected files.

---

## N. REQUIREMENT CLASSIFICATIONS (unchanged from the prior report, now with fuller evidence)

| Requirement | Classification | Basis |
|---|---|---|
| FR-INV-012 | COMPLETE for the completion path | Unchanged; strengthened by §C's weighted-average concurrency proof |
| FR-INV-013 | COMPLETE for the completion path; not claimed globally | Unchanged; strengthened by §D/§E's concurrency proofs |
| FR-INV-022/023 | COMPLETE | Unchanged |
| FR-INV-027 [S] | substrate only — reporting NOT IMPLEMENTED | Unchanged; strengthened by §F's structural-FK proofs of the substrate's own integrity |
| FR-INV-030 | COMPLETE for sales | Unchanged |
| BR-INV-003 | COMPLETE for the completion path | Now proven for the weighted-average axis too (§C) — the one axis the prior report's matrix had not exercised |
| FR-CST-001 | COMPLETE (after verification) | Unchanged |
| FR-CST-002 | PARTIAL | Unchanged |
| FR-POS-024 | COMPLETE | Unchanged; strengthened by §G's clauses A/H/I |
| NFR-PERF-006 | PARTIAL | Not re-measured (§K); real numbers unchanged |
| §1.2/UC-POS-01 | PARTIAL | Unchanged |

---

## O. FINAL VERDICT

# **IMPLEMENTATION DEFECT FOUND**

A genuine implementation defect was found (§I) — a modifier ADD effect targeting an unpublished sub-recipe was silently and completely forgotten, with zero trace anywhere in the system. It has been **fixed**, within the existing accepted contracts, with no migration, no new persistence concept, and no governance change, and is now tested. Every other mandatory verification this closure pass was scoped to cover — the full 5-scenario concurrency matrix, all structural FK negative proofs, all named historical-pinning/gap/modifier-composition clauses, and full RLS/grants verification — is now complete and green, with zero regressions across the full unit and e2e suites. Migrations remain 30; OpenAPI remains 3.1.0/135; the persistent local `ros` database was never touched.

---

## Update to INDEX.md

Appended (see `docs/reports/claude/INDEX.md`).
