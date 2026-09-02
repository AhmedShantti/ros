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
