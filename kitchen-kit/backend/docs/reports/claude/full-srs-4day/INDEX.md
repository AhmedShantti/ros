# ROS Full-SRS 4-Day Execution — Reports Index

Navigation only. Entries are appended chronologically; never rewritten.

## What lives here

This directory holds the **P1 through P20** Full-SRS 4-day execution reports —
one report per implementation, design-gate, verification or acceptance slice.

**P0-REBASE is not here and is not moved.** It remains permanently in the parent
reports directory:

- `../2026-09-02_FULL-SRS-current-head-traceability-rebase.md`
- `../2026-09-02_FULL-SRS-current-head-traceability.csv`
- `../2026-09-02_FULL-SRS-4day-execution-board.csv`

The parent index `../INDEX.md` continues to cover everything up to and including
P0. From P1 onward, every new report for this programme is written here and adds
one row to the table below.

## Authority

**These reports are NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the
ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain
authoritative. Where a report disagrees with the SRS or a ratified governance
decision, the SRS and the register win. A report records what was observed and
measured in its own session — it ratifies nothing and authorises nothing.

## What every report must state

Each report opens with the standard header (task/slice name, report type,
authority statement, date, HEAD, branch, working-tree summary, task identifier)
and must explicitly record:

- **Baseline HEAD** the slice started from;
- **Resulting HEAD** after the slice's commits;
- **Tests and checks actually executed in that session**, with real results —
  never a prior run's numbers re-reported as new;
- **Commit(s) created**, with exact subjects;
- **Push and deploy state**;
- **Unresolved blockers**, with why each is still open.

Reports are never overwritten. A slice interrupted before its report is complete
keeps the partial file marked `PARTIAL`, states exactly where work stopped, and
is either completed in the same run or superseded by a `_02` report in a new one.

## Naming

`YYYY-MM-DD_<SLICE-ID>_<short-description>.md` (kebab-case, no spaces). A second
report for the same slice on the same date appends `_02`, `_03`, and so on.

Examples: `2026-09-02_A1-1_inventory-write-path-correctness.md` ·
`2026-09-02_G1-1_ci-pipeline.md` · `2026-09-02_D1-1_offline-sync-design-gate.md`

## Reports

| Date | Slice | Lane | Type | Baseline | Result Commit | Status | Report |
|---|---|---|---|---|---|---|---|
| 2026-09-02 | A1-1 — Inventory movement write-path correctness | A | Implementation + tests + acceptance | `63d3b7c2` | `fix(inventory): make movement projection atomic` (this commit — see `git log` on this path) | COMPLETE — atomic projection, exact decimal, concurrency + exact-fold regression tests added and verified to fail against the pre-fix code; 815/815 unit, 1156/1157 e2e (1 pre-existing, confirmed-unrelated `NFR-PERF-006` failure, reproduced identically at baseline); zero schema/migration/API/permission change | [2026-09-02_A1-1_inventory-write-path-correctness.md](2026-09-02_A1-1_inventory-write-path-correctness.md) |
| 2026-09-02 | A1-1 acceptance correction — exact persisted movement deltas (Transfers/Counts/Waste) | A | Narrow implementation correction + tests | `eef0f15` | `fix(inventory): preserve exact movement deltas` (this commit — see `git log` on this path) | COMPLETE — every `MovementsService.post` caller now exact end to end (no `Number()`/`Math.abs()`/JS subtraction on a value feeding a persisted `stock_movements.quantity`); 7 new exact-decimal tests, 3 verified to fail against the reintroduced pre-correction arithmetic; 815/815 unit, targeted e2e green; zero schema/migration/API change | [2026-09-02_A1-1_inventory-write-path-acceptance-correction.md](2026-09-02_A1-1_inventory-write-path-acceptance-correction.md) |
| 2026-09-02 | A1-2 — Group FIFO layer locking by distinct (stockItemId, locationId) | A | Implementation + tests + performance measurement | `45ad383` | `perf(inventory): group depletion layer locks` (this commit — see `git log` on this path) | A1-2 ACCEPTED — `SaleDepletionService` locks FIFO layers once per distinct key (135→5 acquisitions on the 30-line benchmark fixture, canonical global order proven with real spies incl. input-order-reversed); evolving in-memory physical/accounting state proven equivalent to a fresh re-read (FEFO-vs-FIFO divergence + carry-forward tests pass under both pre- and post-A1-2 code); isolated benchmark p50 2754→750ms (−72.8%), p95 4382→2069ms (−52.8%); `NFR-PERF-006` remains PARTIAL/VERIFIED-FAILING (p95 still >200ms, A1-3 required); 815/815 unit, 1167/1169 e2e (2 pre-existing/confirmed-transient parallel-load failures, clean in isolation); zero schema/migration/API change | [2026-09-02_A1-2_inventory-lock-grouping.md](2026-09-02_A1-2_inventory-lock-grouping.md) |
| 2026-09-02 | A1-3 — Set-oriented depletion write design gate | A | Design gate + SQL feasibility probes (no implementation) | `897333b` | `docs(inventory): design set-oriented depletion writes` (this commit — see `git log` on this path) | **APPROVE A1-3 IMPLEMENTATION** — measured 895 statements / 2,685 protocol messages per completion tx (all 20 benchmark iterations identical), of which only 119.6ms p50 / 149.6ms p95 is server-side execution against 464.9/608.2ms wall clock, so ~75-80% of the cost is round-trip overhead; proposed design reduces 895 → 28 statements (867 removed, 96.9%). 8 SQL probes executed against the disposable Lane-A DB (all rolled back, cleanup verified): window-function `balance_after` exact and deterministic under explicit `ord`; full statement proven on the real partitioned/RLS-forced schema and re-proven as `ros_app` under FORCE RLS with ledger `UPDATE` still denied; `UPDATE…FROM` multiple-match hazard reproduced and mitigated by mandatory in-statement `GROUP BY`; set-oriented reservation with identity-based conflict detection proven both paths; two-session concurrency proof (T2 blocked 1.58s, saw committed state, chains contiguous) plus the rejected `SELECT`-then-write shape executed and shown to produce a broken ledger; carry-forward staleness reproduced (unit_cost 100 vs 200) driving a mandatory flush rule. `NFR-PERF-006` remains PARTIAL/VERIFIED-FAILING; zero schema/migration/API/product-code change | [2026-09-02_A1-3_set-oriented-depletion-design-gate.md](2026-09-02_A1-3_set-oriented-depletion-design-gate.md) |
| 2026-09-03 | A1-3A — Set-oriented effect reservation + weighted-average cost hoist | A | Implementation + tests + correctness/performance verification | `d0c1c82` | `perf(inventory): batch depletion effect reservation` (this commit — see `git log` on this path) | **A1-3A ACCEPTED** — one `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING` (via `jsonb_to_recordset`, real `JSON.stringify`→`::jsonb` Prisma binding proven) replaces 135 per-effect reservation `INSERT`s; identity-based conflict detection names every missing `(orderLine, stockItem, location)`, not only the first; duplicate in-request identity rejected fail-closed before any SQL (sabotage test); partial-reservation-then-conflict proven to roll back the WHOLE transaction (spy proves zero `lockLayers` calls, snapshots prove zero Inventory mutation survives); weighted-average `current_cost` hoisted 45→1 reads/call (batching + missing-row-default + FIFO/standard-unaffected all proven via real query-event-log counting). Measured on the unmodified 30-line/895-statement fixture: reservation 135→1, avg-cost 45→1, **total 895→717 statements** (exactly the design gate's predicted value), all 20 iterations identical; isolated instrumentation-off perf p50 750.45→369.44ms (−50.8%), p95 2068.60→425.75ms (−79.4%); `NFR-PERF-006` remains PARTIAL/VERIFIED-FAILING (674 A1-3B-scoped statements still dominant) — correctly not claimed COMPLETE. `sale-depletion-lock-grouping.e2e-spec.ts` passes byte-for-byte unmodified (semantic-equivalence proof); 10 new A1-3A-specific tests added; 815/815 unit, module-boundaries 45/45, zero schema/migration/API change, zero new lint; persistent `ros` never touched | [2026-09-03_A1-3A_set-oriented-effect-reservation.md](2026-09-03_A1-3A_set-oriented-effect-reservation.md) |
