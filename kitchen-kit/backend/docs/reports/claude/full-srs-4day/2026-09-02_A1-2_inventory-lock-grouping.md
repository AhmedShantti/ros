# A1-2 — Group FIFO Layer Locking by Distinct Stock Key (P1-PERF, Lane A)

| Field | Value |
|---|---|
| **Task / slice name** | `P1-PERF` / `A1-2` — group `SaleDepletionService`'s FIFO layer locking by distinct `(stockItemId, locationId)` |
| **Lane** | A — Performance + Inventory Concurrency |
| **Report type** | Implementation + tests + performance measurement + report |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries of `docs/governance/GOVERNANCE_DECISION_REGISTER.md` are the **only** authorities. This report records what was implemented and verified **in this session** against the repository at the HEAD below. It ratifies nothing and authorizes no decision beyond recording this slice's own result. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `45ad383b4912f8449e8bfd45e733351f314c7959` — *fix(inventory): preserve exact movement deltas* |
| **Branch** | `full-srs/lane-a-perf-inventory` |
| **Worktree** | `/Users/mac/projects/ros-worktrees/lane-a` |
| **Working tree at start** | Clean, verified via `git status --short --untracked-files=all`. Both A1-1 reports confirmed present. |
| **Task identifier** | A1-2 / full-srs-4day / lane-a |
| **Status** | **A1-2 ACCEPTED** — correctness/grouping requirements all met. `NFR-PERF-006` itself remains **PARTIAL / VERIFIED-FAILING** (p95 > 200 ms) — expected and explicitly not required for A1-2 acceptance. |

---

## 1. Requirements

**Primary:** `NFR-PERF-006` (recipe expansion + inventory depletion for a ≤30-line completed order SHALL complete within 200 ms p95, SHALL execute within the order's transaction) — re-read verbatim from `ROS_SRS_v1.0.pdf` p.61 (`pdftotext -layout`, line 3020-3022) before any edit.

**Preserved, verified unchanged:** `BR-INV-001`, `BR-INV-002`, `BR-INV-003`, `BR-CORE-003`, `FR-INV-012`, `FR-INV-013`, `FR-INV-030`, `FR-INV-014`.

## 2. Before architecture (defect)

`SaleDepletionService.depleteForCompletedSale` processed logical depletion effects (flattened, sorted `(stockItemId, orderLineId)` triples) sequentially. For **every** triple — regardless of whether an earlier triple in the same call already touched the same `(stockItemId, locationId)` — it called `lockLayers()` (a fresh `SELECT … FROM stock_batches … FOR UPDATE`), even though the transaction already held those exact row locks from the first acquisition. This was **not a correctness defect** — Postgres row locks persist for the transaction's lifetime, and a repeated `SELECT … FOR UPDATE` inside the same transaction simply re-reads the current (already-locked, already-mutated-by-prior-effects) state — but it was a pure, avoidable round-trip cost: N `lockLayers` calls for N logical effects, where the number of *distinct* stock/location keys D is typically far smaller than N (e.g. one popular ingredient consumed by many order lines and sub-recipes).

## 3. Grouping implementation

`src/modules/inventory/sale-depletion/sale-depletion.service.ts` — `depleteForCompletedSale`'s main loop now tracks a `currentGroupKey` and a working `lockedLayers: LockedBatchLayer[]` across iterations. Before planning each triple, it checks whether `` `${stockItemId}::${locationId}` `` differs from the previous triple's key; only on a **change** does it call `lockLayers()` again. Everything else in the loop — effect reservation, physical planning, physical batch `UPDATE`, FIFO cost planning, `applyCostConsumption`, carry-forward, the zipper, and per-allocation `writeAllocation` — is **completely unchanged**, both in code and in call count. Only the `lockLayers` call itself is now conditional.

No changes were made to `fifo-cost-ledger.ts`'s public API (`LockedBatchLayer`, `lockLayers`, `planFifoCostConsumption`, `applyCostConsumption`, `findCarryForwardBasis` all retain their exact pre-A1-2 signatures) — so `MovementsService.post`'s own (ungrouped, single-item) use of the same kernel is completely untouched. `CostSlice` was added to `sale-depletion.service.ts`'s existing import from that file (a type-only addition, already publicly exported).

## 4. Global lock order

`triples` was already sorted `(stockItemId ASC, then orderLineId ASC)` **before** this session (P1F2E-A §E, unchanged) — the depletion location is resolved once per call (one branch → one location), so that existing sort already produces the group order the task requires: `stock_item_id` ascending, then `location_id` (constant here, included in the group key for explicitness/generality). Because the sort keeps every triple for one `stockItemId` contiguous, a **simple boundary check** while walking the already-sorted array is sufficient to detect "new group" — no separate grouping/sorting pass was added, and no Map-insertion-order, recipe-traversal-order, or modifier-order ever determines lock sequence. Within a group, the pre-existing `orderLineId ASC` ordering is preserved exactly (untouched).

Verified with real spies (§16 below), including an explicit **input-order-reversed** case: the lock acquisition order is identical regardless of how the caller's raw `lines`/`components` were arranged, because sorting happens before grouping either way.

## 5. Evolving in-memory physical state

New private method `evolvePhysicalState(layers, slices): LockedBatchLayer[]` — pure, returns a new array; for every batch touched by the just-planned `physicalSlices.slices`, decrements that batch's `quantityRemaining` (exact `Rational`, formatted back via `toDecimal6`) by the exact amount just written to the database via the (unchanged) `UPDATE stock_batches SET quantity_remaining = quantity_remaining - …` statement. Called immediately after that `UPDATE`, so the working array is updated at the exact same point the real database is. The next triple in the same group plans (`planPhysicalConsumption`) against this evolved array — never against the group's original snapshot.

## 6. Evolving in-memory accounting state

New private method `evolveAccountingState(layers, slices): LockedBatchLayer[]` — same pattern, for the `fifo_cost_quantity_consumed` counter, called immediately after the (unchanged) `applyCostConsumption` DB write, using the `CostSlice[]` it was just given (never including the separately-appended carry-forward slice, matching `applyCostConsumption`'s own real DB call exactly — carry-forward is a valuation reference, not a fresh consumption, so it correctly does **not** touch this counter, exactly as before).

Both evolution functions are independent: `evolvePhysicalState` never touches `fifoCostQuantityConsumed`; `evolveAccountingState` never touches `quantityRemaining`. Verified directly by the FEFO/FIFO-divergence test (§15).

## 7. Carry-forward treatment

`findCarryForwardBasis` (a real `SELECT … WHERE quantity_received - fifo_cost_quantity_consumed = 0 ORDER BY created_at DESC … LIMIT 1`) was **left completely unmodified** — it already re-queries the database fresh every time it's called, and by the time it's called (always *after* the current effect's own `applyCostConsumption` write, and after any earlier effect in the same group already committed its own real writes), the database already reflects every prior effect's mutations, group or no group. Grouping doesn't change when the *real* DB writes happen — only when the *lock acquisition* happens — so this query needed no optimization to remain correct, and per the task's own instruction ("optimising that query is allowed ONLY if exact semantics/provenance remain identical… do not broaden scope merely to save one query"), it was **not** touched. Verified directly: a dedicated test (§15) has a second effect in one locked group exhaust the sole accounting layer and correctly carry-forward to that same, now-exhausted, batch — proving prior-effect state (from the same group) and the current effect's own just-applied exhaustion are both visible to the unmodified query.

## 8. Reservation / idempotency preservation

Untouched. The `sale_depletion_effects` `INSERT … ON CONFLICT … DO NOTHING` reservation step still runs, unconditionally, **before** any lock-acquisition check or Inventory mutation, for every triple — exactly as before. A conflict still throws `SaleDepletionEffectConflictError` immediately, aborting the whole outer transaction (Postgres rollback), so a losing effect still performs zero Inventory mutation and no earlier effect's mutation survives a later conflict — this property was never touched by the grouping change, since grouping only affects *which triples share a lock acquisition*, not *whether* an effect proceeds.

## 9. Query / lock acquisition reduction

Derived directly from the existing `test/order-completion-performance.e2e-spec.ts` fixture's own source (30 order lines, all sharing one recipe: `itemWA` + `itemStd` + `itemFifoTop` directly, plus a depth-2 sub-recipe resolving to `itemFifoDeep`, plus `itemModAdd` on every other line via a modifier — lines 254-258, 441-444, 500 of that file):

| Metric | Value | Basis |
|---|---|---|
| Distinct `(stockItemId, locationId)` keys | **5** | `itemWA`, `itemStd`, `itemFifoTop`, `itemFifoDeep`, `itemModAdd`, all at the one resolved branch location |
| Logical depletion effects | **135** | 30 lines × 4 base components + 15 lines (every other) × 1 modifier component = 120 + 15 |
| `lockLayers` acquisitions — BEFORE | **135** | one per effect, unconditional |
| `lockLayers` acquisitions — AFTER | **5** | one per distinct key (proven mechanism, §16) |
| Net round trips removed | **130** | 135 − 5 |

These effect/key counts are **derived from the fixture's own source**, not live-instrumented for this specific 30-line run (the benchmark file itself was never modified — the task's own instruction — so no counter was added to it). The **mechanism** producing the before/after `lockLayers` counts (once per effect vs. once per distinct key, in canonical order) **is** instrumented and proven with a real `jest.spyOn` on the exported `lockLayers` function, calling through to the genuine implementation, in three dedicated tests against real Postgres (§16).

**Approximate total SQL statement count** (reasoned, not instrumented — every other query in the loop is unchanged in count): roughly 7-8 statements per effect before (reservation INSERT, `lockLayers` SELECT, ≥1 physical `UPDATE`, cost-axis work, `writeAllocation`'s 4 queries) × 135 effects ≈ **1,000-1,100 total**, consistent with the traceability report's own prior estimate of "~1,050 statements" for this fixture. Removing 130 `lockLayers` calls is roughly a 12-13% reduction in raw statement *count* — disproportionately smaller than the 52-73% *wall-clock* improvement measured (§11-12), which is consistent with `lockLayers`'s sorted, filtered `SELECT … FOR UPDATE` being a materially more expensive statement than the simple indexed point-writes that make up most of the remaining query volume, especially on this session's single, lightly-resourced disposable Postgres container.

## 10. Baseline benchmark (BEFORE, isolated)

Run per the task's explicit sequencing: `test/order-completion-performance.e2e-spec.ts`, **unmodified fixture, unmodified measurement logic**, in complete isolation (no other suite running), against the disposable Lane-A database, **before** any production code was edited this session:

```
NFR-PERF-006: 30 lines, 20 iterations —
p50=2754.39ms p95=4381.62ms (min=1782.93ms max=4523.40ms)
```

(A first implementation pass had already been made before this baseline was captured — caught immediately, corrected by `git stash`-ing the A1-2 diff back to the exact starting HEAD, confirmed via `git status`/`git diff` clean, running the baseline, then `git stash apply` + drop to restore the diff exactly — verified byte-identical by `diff` against a saved copy. The reported baseline numbers are genuinely pre-A1-2.)

20/20 iterations completed within the benchmark's 5000 ms Prisma interactive-transaction timeout in this isolated run (this timeout **does** trip when the benchmark runs concurrently with other e2e suites under parallel-worker load — see §18).

## 11. Post-change benchmark (AFTER, isolated)

Identical benchmark, identical fixture, identical isolation, run immediately after restoring the A1-2 diff:

```
NFR-PERF-006: 30 lines, 20 iterations —
p50=750.45ms p95=2068.60ms (min=600.10ms max=2496.78ms)
```

| Metric | Before | After | Improvement |
|---|---|---|---|
| p50 | 2754.39 ms | 750.45 ms | **72.8%** |
| p95 | 4381.62 ms | 2068.60 ms | **52.8%** |
| min | 1782.93 ms | 600.10 ms | 66.3% |
| max | 4523.40 ms | 2496.78 ms | 44.8% |

## 12. NFR-PERF-006 classification

**PARTIAL / VERIFIED-FAILING** — p95 = 2068.60 ms, still far above the 200 ms bar. This is the expected, task-acknowledged outcome: A1-2 removes exactly one class of round trips (redundant `lockLayers` acquisitions); it does not attempt A1-3's set-oriented rewrite, which is the only path the traceability report's own analysis (§29.10 of the accepted rebase) identifies as capable of reaching ≤200 ms. **A1-2 is not, and is not claimed to be, COMPLETE for NFR-PERF-006.**

## 13. Correctness tests

New file: `test/sale-depletion-lock-grouping.e2e-spec.ts` (real Postgres, disposable Lane-A DB), covering §16 and §17/§10 of the task:

### 13.1 Group-state correctness (§17) — FEFO physical vs. FIFO accounting divergence

One item, two batches: batch1 (received first, later expiry, cost 100), batch2 (received second, **earlier** expiry, cost 200), `batchStrategy: 'fefo'`. Two logical effects in **one** locked group: effect 1 consumes 3 (physical takes from batch2 per FEFO; accounting takes from batch1 per FIFO receipt order — the classic dual-axis divergence); effect 2 consumes 4, **continuing from effect 1's evolved state on both axes independently**:

- Physical: batch2 had 2 remaining (5−3) → take 2 (exhausts it), then 2 more from batch1 (untouched physically, 5 remaining) → take 2.
- Accounting: batch1 had 2 headroom (5−3) → take 2 (exhausts it), then 2 more from batch2 (untouched by accounting until now, full 5 headroom) → take 2.

Asserted exactly (`Prisma.Decimal.equals`, never `Number()`): all 3 allocations' `physicalBatchId`/`costBasisBatchId`/`quantityInBaseUnit`/`unitCost`/`totalCost`; final `quantity_remaining` per batch (batch1=3, batch2=0); final `fifo_cost_quantity_consumed` per batch (batch1=5, batch2=2); every `stock_movements.balance_after` as the true running fold; `stock_levels.quantity_on_hand` equal to that exact fold (−7).

### 13.2 Carry-forward within a group (§10)

One item, one batch (qty 5, cost 300). Effect 1 consumes 3 (batch → 2 remaining, 3 consumed). Effect 2 (same group) consumes 4: physical takes the remaining 2 then records a 2-unit shortfall (`FR-INV-014`); accounting takes the remaining 2 headroom (exhausting the batch, 5/5 consumed) then correctly **carries forward to that same, just-exhausted batch** for the last 2 units — proving the unmodified `findCarryForwardBasis` query sees both the prior effect's state and the current effect's own just-applied exhaustion, correctly, under grouping. Asserted exactly: all 3 allocations (including the physically-null, carry-forward-costed shortfall slice), final batch state, unit cost preserved as the true historical basis (300, never a blended/average figure), exact ledger fold (−7), FR-INV-014 negative-stock recording.

## 14. Concurrency tests

Re-run unmodified (real Postgres, disposable Lane-A DB):

- `test/order-completion-concurrency.e2e-spec.ts`, `test/order-completion-concurrency-2.e2e-spec.ts` — the two-Orders-racing-one-FIFO-item suites — **green**, no changes needed. These races exercise `SaleDepletionService.depleteForCompletedSale` end to end (including the now-grouped lock path) via real barrier-released transactions; the accepted serial-equivalent outcome on both physical and accounting axes is unaffected.
- `test/movements-concurrency.e2e-spec.ts` (A1-1) — **green**, 4/4, unmodified (this session made zero changes to `movements.service.ts`).

## 15. Exact-decimal regression

`test/inventory-exact-decimal-callers.e2e-spec.ts` (A1-1 correction) — **green**, 7/7, unmodified. No `Number()`/`parseFloat()`/JS arithmetic was introduced anywhere in this session's diff; `evolvePhysicalState`/`evolveAccountingState` use only the pre-existing `Rational`/`toDecimal6`/`exact()` primitives already in this file.

## 16. Full regression

| Check | Result |
|---|---|
| `git diff --check` | Clean |
| `npx prisma validate` | Schema valid, zero diff |
| `npx tsc --noEmit -p .` | Clean except the pre-existing, unrelated `access-token.service.spec.ts:28` `TS2322` (untouched, Lane A does not edit Identity) |
| `npm run openapi:check` | Zero diff |
| Unit suite (`npx jest`) | **815/815 passed**, 60/60 suites |
| `module-boundaries.spec.ts` + `costing.spec.ts` | 65/65 passed |
| `test/sale-depletion-lock-grouping.e2e-spec.ts` (**new**) | 5/5 passed; the 3 lock-count tests independently verified to **fail** (3/4/4 acquisitions instead of 1/2/2) when re-run against the pre-A1-2 `sale-depletion.service.ts` (restored via tagged `git stash`); the 2 group-state/carry-forward tests **pass under both** pre- and post-A1-2 code — confirming the pre-existing code was already correct (only wasteful) and that the new evolving state is bit-for-bit equivalent to a fresh re-read |
| `test/inventory.e2e-spec.ts`, `test/inventory-rls.e2e-spec.ts`, `test/order-completion*.e2e-spec.ts`, `test/sales-lines.e2e-spec.ts`, `test/movements-concurrency.e2e-spec.ts`, `test/inventory-exact-decimal-callers.e2e-spec.ts` (batched run) | 167/168 passed — the 1 failure is `order-completion-performance.e2e-spec.ts` timing out under this batch's parallel load (see below); everything else green |
| Full e2e suite (all 67 files, `--maxWorkers=4`) | **1167/1169 passed, 65/67 suites.** Two failures, both confirmed transient parallel-load artifacts, not regressions: (1) `order-completion-performance.e2e-spec.ts` — the same pre-existing `NFR-PERF-006` 5000 ms Prisma transaction timeout (already documented in both A1-1 reports as reproducible under contention, not in isolation — this session's own clean isolated before/after runs, §10-11, are the authoritative benchmark numbers). (2) `kds-amendment.e2e-spec.ts` — `"Unable to start a transaction in the given time"`, a connection-pool/contention symptom in a file this session never touched (KDS ticket amendment, unrelated domain). **Re-run in isolation: 2/2 passed**, confirming it is not a reproducible regression. |

A stray NUL byte was found (and fixed, replaced with `::`) in the `groupKey` template literal during self-review before this report was written — introduced during editing, functionally harmless (a NUL is a valid character inside a JS template-literal string, and the file's own internal string-equality comparison worked identically either way — proven by the fact that all `sale-depletion-lock-grouping` tests already passed both before and after the fix), but not something to commit. Confirmed via `file`/`git diff --check`/`tsc` clean after the fix, and the full targeted suite re-run green.

## 17. Schema / API / OpenAPI status

**No schema, migration, or public contract change — as expected, and verified, not assumed:**

- `npx prisma validate` — zero diff to `prisma/schema.prisma`.
- `npm run openapi:check` — zero diff to `docs/api/openapi.json`/`.yaml`.
- No route, DTO, permission, RBAC, or RLS change. `SaleDepletionCommand`'s public contract (`sale-depletion.contract.ts`) was not touched.
- `fifo-cost-ledger.ts`'s exported surface is unchanged (only a type already exported, `CostSlice`, is now also imported by `sale-depletion.service.ts`).

## 18. Remaining A1-3 work

**NOT STARTED.** No set-oriented movement/allocation writes, no multi-row `INSERT`, no window-function `balance_after`, no `UPDATE … FROM VALUES` batching — every per-allocation persistence call in `writeAllocation` is untouched, still one atomic `stock_levels` delta + one movement `INSERT` + one pointer `UPDATE` + one allocation `INSERT` per zipped slice, exactly as before. The traceability report's own §29.10 design gate for A1-3 (window-function running balances preserving per-movement `balance_after` truthfulness) has not been opened in this session.

## 19. Remaining A1-4 work

**NOT STARTED**, per the task's explicit non-goals: transfer-vs-sale, count-vs-sale (`CT-08`), waste-vs-sale races; the two-concurrent-receipts weighted-average race; the full completion-vs-`MovementsService.post` deadlock-inversion matrix; the daily `BR-INV-003` reconciliation job (`CG-02`). The optional §19 deadlock smoke probe was considered and **deliberately not added** this session — the task marks it explicitly optional, and building it well enough to be meaningful (two completions referencing the same two item/location keys in opposite input order, genuinely non-deadlocking) risks exactly the A1-4-matrix scope creep the task warns against; it is recorded here as deferred, not silently dropped.

## 20. Integration collision risks

- `sale-depletion.service.ts` is imported by `SALE_DEPLETION_COMMAND`'s DI binding only; no other module constructs it directly (confirmed by `module-boundaries.spec.ts`, unchanged, 45/45 passing). No cross-lane import surface was widened.
- `fifo-cost-ledger.ts`'s public functions/types are unchanged in signature; any other lane's work-in-progress against that kernel (if any) is unaffected.
- The `evolvePhysicalState`/`evolveAccountingState` private methods and the `currentGroupKey`/`lockedLayers` loop variables are local to `SaleDepletionService`; nothing new is exported.
- No interaction with Identity, Sales' own tables beyond the pre-existing `sale_depletion_effects`/`stock_movements`/`stock_batches`/`stock_levels` writes this service already made.

## 21. Files changed

- `src/modules/inventory/sale-depletion/sale-depletion.service.ts` — the A1-2 implementation (grouping, two new private evolve-state methods, one new type-only import).
- `test/sale-depletion-lock-grouping.e2e-spec.ts` — **new**: 5 tests (§16 lock-count/order proof ×3, §17 group-state ×1, §10 carry-forward ×1).

No other file touched. No Prisma schema file touched. No migration created.

## 22. Commit

Committed after this report and the INDEX row. Exact subject:

```
perf(inventory): group depletion layer locks
```

Staged explicitly (no `git add .`/`git add -A`): the one `src/` file, the one new `test/` file, this report, and the one `INDEX.md` row.

## 23. Push / deploy status

**NOT PUSHED. NOT DEPLOYED. NOT MERGED. NOT REBASED.**
