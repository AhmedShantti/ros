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
| 2026-09-02 | B1-1 | B | GOVERNANCE ANALYSIS / DECISION BRIEF | `63d3b7c` | *this row's own commit* — `docs(security): prepare branch RBAC governance gate` | **COMPLETE — AWAITING USER GOVERNANCE DECISION.** D-2 (RATIFIED 2026-08-17 CORE ONLY) still defers `FR-SEC-002`/`003`/`004` [M] and `FR-SEC-005` [S]; branch isolation does not exist (any tenant principal may act on every branch). Recommends **C-1** (scoped role assignment as the sole authorization source; `EmployeeBranch` stays authentication-integrity only), scope types **`TENANT`/`BRAND`/`BRANCH`** only, **no branch claim in the JWT** (T-2, escalating an `FR-API-012`-vs-`FR-SEC-028` `[M]` conflict), **typed FK'd scope columns instead of a polymorphic `scope_id`**, and migration **M-4**. Report ratifies nothing; the register was NOT modified. **B1-2 must not start.** | [2026-09-02_B1-1_branch-rbac-governance-gate.md](2026-09-02_B1-1_branch-rbac-governance-gate.md) |
| 2026-09-02 | B1-1 (acceptance correction) | B | GOVERNANCE RATIFICATION + ACCEPTANCE CORRECTION | `1e53a21` | *this row's own commit* — `docs(security): ratify branch-scoped RBAC` | **RATIFIED — B1-2 GOVERNANCE-UNBLOCKED.** `AMENDMENT — D-2 REOPENED IN PART (2): BRANCH-SCOPED RBAC` recorded under D-2 (RATIFIED 2026-09-02, explicit user authority); historical D-2 text preserved, no decision numbered or renumbered. Lifts the defer for `FR-SEC-002`/`003`/`004`/`005` and the branch/scope portions of `FR-API-012`. Ratifies **C-1** (scoped assignments are the sole grant source; `EmployeeBranch` is AND-only, never a grant), a **generic target-scope lattice** `TENANT`/`BRAND(id)`/`BRANCH(id)` with downward-only coverage, **`T-4-LIVE`** (token carries the SRS snapshot + scope epoch; **live server-side resolution stays authoritative**), **`M-4+`** (adds the already-multi-branch case), no branch-aware RLS, and the B1-2/B1-3 boundaries. Corrects B1-1: **`T-2` not ratified**, lattice added, `M-4`→`M-4+`, **`BRANCH_GROUP` deferred not rejected** (mandatory `FR-BRN-005` follow-up), **`FR-SEC-028` COMPLETE→PARTIAL** (local-data wipe on next contact not implemented). **Nothing implemented**: `FR-SEC-002`/`003`/`004`/`005` RATIFIED FOR IMPLEMENTATION — NOT IMPLEMENTED; `FR-API-012` RATIFIED DESIGN — NOT YET COMPLETE. | [2026-09-02_B1-1_branch-rbac-ratification.md](2026-09-02_B1-1_branch-rbac-ratification.md) |
| 2026-09-02 | B1-2 | B | IMPLEMENTATION + SCHEMA/MIGRATION + TESTS + ADR | `2967043` | *this row's own commit* — `feat(security): implement scoped role assignments` | **COMPLETE — B1-3 UNBLOCKED.** Implements the scoped-RBAC foundation authorised by `AMENDMENT — D-2 REOPENED IN PART (2)`. Migration **36** (`20260902010000_identity_scoped_role_assignments`) replaces `membership_roles`' composite PK with a stable id and adds `tenant_id`, `scope_type` (`tenant`/`brand`/`branch`), **typed composite-FK'd** `scope_brand_id`/`scope_branch_id` (no polymorphic `scope_id`), `valid_from`/`valid_to`, `origin`/`reviewed_at`, three CHECKs and a `btree_gist` temporal EXCLUDE; drops the never-used legacy `branch_id`; adds `memberships.authz_epoch` + `UNIQUE(tenant_id,id)`; and adds the **missing `UPDATE` RLS policy** (`USING` + `WITH CHECK`) that made `FR-SEC-005` unusable. Live scope-aware resolution on the **DB clock**; the generic `permission + target scope` primitive with the downward-only lattice; **`T-4-LIVE`** (token carries `scp`/`pbr`/`epo`, **claims never authorize**, stale snapshot refused, symbolic permitted-branch set, overflow fails closed at 128 units); POS narrowing where `EmployeeBranch` is **AND-only**; scoped assignment APIs (explicit scope mandatory, deprecated remove-by-role fails closed at 409); **`M-4+`** backfill + provenance + second-active-branch gate + already-multi-branch handling; ADR **0009** superseding the ADR 0002/0004 branch-scope deferrals and closing ADR 0008 D-02. **Transitional safety:** a target-less `@RequirePermission` route is a TENANT-target operation, so BRAND/BRANCH grants fail closed until B1-3 converts routes. **Status: `FR-SEC-002`/`003` COMPLETE, `FR-SEC-005` COMPLETE, `FR-SEC-004` PARTIAL, `FR-API-012` PARTIAL, `FR-SEC-028` PARTIAL** — no overclaim; B1-3 owns route-wide enforcement, the coverage gate, the security review and retirement of the single-active-branch mask. | [2026-09-02_B1-2_branch-scoped-rbac-foundation.md](2026-09-02_B1-2_branch-scoped-rbac-foundation.md) |
