# MW1H — Integrate AUD-1 + DR-1 into the canonical Full-SRS integration branch

**Report type:** Integration report (cherry-pick reconciliation + verification)
**Authority statement:** This report is non-authoritative evidence. The SRS
and ratified governance decisions remain authoritative; this report records
what was done and what was verified in this session, nothing more.
**Date:** 2026-09-03
**Starting HEAD:** `9dddd68` (integration branch `full-srs/4day-integration`)
**Resulting HEAD:** `7ed2268`
**Branch:** `full-srs/4day-integration`
**Working tree summary:** Clean before, during (after each cherry-pick), and
after this session. No push, no deploy, no rebase, no destructive git.
**Task identifier:** MW1H

---

## 1. Pre-integration verification

- Confirmed `full-srs/4day-integration` HEAD was exactly `9dddd68` before any
  work began — no undocumented integration commit had advanced it.
- Confirmed both source branches exist and carry the expected commits, each
  branching directly off `9dddd68`:
  - `full-srs/lane-c2-audit-production` → `4b35a56`, `3d60d2f`, `6cb6f6e`,
    `ea4808a` (HEAD `ea4808a`)
  - `full-srs/lane-f2-dr-partition-lifecycle` → `e8eb5df`, `c06e86d`,
    `86bf435` (HEAD `86bf435`)
- Migration counts measured directly against each branch's tree (not the
  working directory) before any cherry-pick:
  - Integration baseline (`9dddd68`): **39** migrations
  - AUD branch: **39** migrations (AUD-1 adds no migration)
  - DR branch: **40** migrations (DR-1 adds exactly 1 — matches the task
    brief's "migration count after DR branch: 40")
- Inspected every source commit's diff (`git show --stat`) before
  cherry-picking. Identified likely overlap in advance, exactly as the task
  brief anticipated:
  - `kitchen-kit/backend/test/scheduler-fixtures.ts` — both AUD (adds
    `governance.audit_chain_verification` to the disable-list) and DR (adds
    `platform.partition_lifecycle`) touch the same `onlyJob` array.
  - `kitchen-kit/backend/docs/observability/alerts/backend-api.rules.yaml` —
    both AUD (`ROSAuditChainIntegrityBroken`) and DR
    (`ROSPartitionLifecycleCreationFailed`) append a new alert block after
    the same existing rule.
  - `kitchen-kit/backend/docs/reports/claude/full-srs-4day/INDEX.md` — both
    lanes append new rows at the same append point.
  - `kitchen-kit/backend/docs/reports/claude/INDEX.md` — AUD's report commit
    appends a row here.
  - No overlap found in: migrations (AUD has none; DR's single migration is
    additive and untouched by AUD), OpenAPI (AUD-only), scheduler
    registry/module wiring code (each lane registers its own job type,
    disjoint files), or authorization/permission tables.

## 2. Source → integration commit mapping

Cherry-picked in the order: DR implementation → DR interim report → AUD
scheduled verification → AUD query/export → AUD implementation report → AUD
human-ratification closure → DR final acceptance report.

| # | Source commit | Source branch | Integration commit | Subject |
|---|---|---|---|---|
| A | `e8eb5df` | lane-f2-dr-partition-lifecycle | `3b53e0c` | feat(platform): automate partition lifecycle |
| B | `c06e86d` | lane-f2-dr-partition-lifecycle | `7a55358` | docs: record partition lifecycle and DR-1 disposition |
| C | `4b35a56` | lane-c2-audit-production | `8810294` | feat(audit): schedule chain integrity verification |
| D | `3d60d2f` | lane-c2-audit-production | `c1f3973` | feat(audit): add auditor query and export surface |
| E | `6cb6f6e` | lane-c2-audit-production | `31012e1` | docs: record audit production completion |
| F | `ea4808a` | lane-c2-audit-production | `f596e1a` | docs: record AUD-R1 human ratification |
| G | `86bf435` | lane-f2-dr-partition-lifecycle | `7ed2268` | docs: record DR-1 full E2E final acceptance verification |

All 7 accepted source commits integrated. Commit dates, authorship, and
messages preserved verbatim by `git cherry-pick` (no `-x`, no squashing, no
rewriting).

## 3. Conflict resolutions

Four cherry-picks (A, B, D, E, F, G) applied byte-clean with **zero
conflicts**. Two cherry-picks conflicted, both exactly where predicted in
§1, both resolved semantically (never by blind ours/theirs):

### 3.1 `4b35a56` (AUD scheduled verification) — 2 conflicting files

**`test/scheduler-fixtures.ts`** — DR's `'platform.partition_lifecycle'`
entry (already integrated via commit A) and AUD's
`'governance.audit_chain_verification'` entry both target the same array
literal in `onlyJob`. Resolved by keeping both entries, each with its
original comment, DR's first (integration order) then AUD's — no
functional change to either lane's own test isolation logic.

**`docs/observability/alerts/backend-api.rules.yaml`** — DR's
`ROSPartitionLifecycleCreationFailed` alert (already integrated) and AUD's
`ROSAuditChainIntegrityBroken` alert both append after the same existing
`ROSInventoryLedgerProjectionDivergence` block. Resolved by keeping both
complete alert blocks in full, DR's first then AUD's, each byte-identical
to its source. No alert rule content altered.

Both resolutions verified: `grep` for conflict markers returned none;
`git diff --check` clean; the merged alert YAML was visually re-checked for
structural correctness (each `- alert:` block complete with its own
`expr`/`for`/`labels`/`annotations`).

### 3.2 `86bf435` (DR final acceptance report) — 1 conflicting file

**`docs/reports/claude/full-srs-4day/INDEX.md`** — AUD's two report rows
(from commits E and F, already integrated) and DR's final-acceptance row
both append at the same point, immediately after the pre-existing MW1G row.
Resolved by keeping every row from every commit exactly once, in
chronological integration order (AUD-1 production-completion row, AUD-1
human-ratification-closure row, then DR-1 full-E2E-final-acceptance row) —
no row content altered, no row dropped, no row duplicated.

No conflicts occurred in `docs/reports/claude/INDEX.md` (the top-level
index) — AUD's and DR's respective appends there landed at different
existing tail states across the cherry-pick sequence and merged cleanly.

## 4. Post-integration structural verification

- **Migration count:** exactly **40** (`git ls-tree -r HEAD --name-only --
  prisma/migrations`, counted `migration.sql` files) — matches the task
  brief's target exactly (39 baseline + DR's 1, AUD adds none).
- **Scheduler registry:** all three required job types present and wired,
  confirmed by direct source read plus passing targeted scheduler/audit/
  partition e2e suites (§6):
  - `inventory.daily_reconciliation` (`src/modules/inventory/reconciliation/daily-reconciliation.job.ts`)
  - `governance.audit_chain_verification` (`src/modules/governance/audit/audit-chain-verification.job.ts`)
  - `platform.partition_lifecycle` (`src/modules/platform/partitioning/partition-lifecycle.job.ts`)
- **AUD routes:** both present, confirmed by direct source read of
  `src/modules/governance/audit/audit-query.controller.ts`:
  - `GET /governance/audit/entries` (`AuditQueryController#search`)
  - `GET /governance/audit/entries/export` (`AuditQueryController#exportEntries`)
- **AUD-R1 governance status:** RATIFIED, preserved as integrated verbatim
  from commit F (`ea4808a` → `f596e1a`) — the final human-ratification
  closure section is present in
  `2026-09-03_AUD-1_final-acceptance-verification.md` §7, and the
  `full-srs-4day/INDEX.md` closure row states "AUD-R1 = RATIFIED, 2026-09-03,
  by explicit human governance action." Not re-litigated or altered by this
  integration.
- **`module-boundaries.spec.ts` (`KNOWN_DEVIATIONS`):** file is **byte-
  identical** to the pre-integration baseline (`git diff 9dddd68 HEAD --`
  on this file produced no output) — zero new deviations introduced.
- **Role posture:** `ros_app` and `ros_partition_admin` both confirmed via
  live `\du` against the local dev Postgres container — neither carries
  `Superuser` nor `Bypass RLS`.
- **No BYPASSRLS:** confirmed by the role-posture check above and by
  DR-1's/AUD-1's own source reports, unmodified by this integration.

## 5. Local environment note (non-code, disclosed for reproducibility)

DR-1 introduced a new required env var, `PARTITION_ADMIN_DATABASE_URL`
(and the paired `ROS_DB_PARTITION_ADMIN_USER`/`_PASSWORD`), validated at
boot by `src/config/env.validation.ts`. This worktree's local `.env`
(gitignored, not part of the repository) predated that requirement and was
updated in place to add these three variables, pointing at a
`ros_partition_admin` role on the existing local dev container
(`ros-postgres`, port 5544). That role did not yet exist on this
long-lived container (its one-time init script only runs on first volume
creation), so it was created directly via `psql` with the exact posture the
init script specifies — `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`,
`NOCREATEROLE`, `NOBYPASSRLS`, granted `CONNECT` only, no DML. This is a
local dev-environment change only: no `.env` value is committed, no schema
or migration changed, and the e2e harness itself is unaffected — it creates
its own ephemeral template/scratch databases and calls
`ensurePartitionAdminRole` idempotently on every run regardless of this
change.

## 6. Verification sequence (run sequentially, in order, per task instruction)

| Step | Result |
|---|---|
| `git diff --check` (9dddd68..HEAD) | Clean — 0 whitespace/conflict-marker errors |
| `prisma validate` | Clean — schema valid |
| `typecheck` (`tsc --noEmit`) | Clean — 0 errors |
| Unit tests (`npm test`) | **83 suites / 1150 tests, 0 failures** |
| Module boundaries (`module-boundaries.spec.ts`, within unit run) | 100% pass, file byte-identical to baseline (§4) |
| Authorization coverage (`authorization-coverage.spec.ts`, within unit run) | 100% pass — **161 routes** (159 baseline + 2 new AUD routes), **17 reviewed exemptions** (unchanged), **0 truly undeclared permission-bearing routes** (`undeclared` assertion `toEqual([])` passed) |
| Scheduler targeted e2e | `scheduler-core`, `scheduler-concurrency`, `scheduler-rls`, `scheduler-performance` — all green |
| Audit targeted e2e | `audit-chain-verification`, `audit-query`, `audit` — all green |
| Partition targeted e2e | `partition-lifecycle` — green |
| Observability targeted e2e | `observability-red-cardinality`, `observability-sync-lifecycle` — green |
| Inventory reconciliation targeted e2e (cross-check, unaffected by this integration) | `inventory-scheduled-reconciliation` — green |
| — targeted e2e total | **11 suites / 104 tests, 0 failures** |
| OpenAPI generation/check (`npm run openapi:check`) | Clean — regenerated `docs/api/openapi.{json,yaml}`, `git diff --exit-code` reported zero diff |
| Lint exact baseline comparison (`npm run lint:check`) | **Exactly 48 errors / 0 warnings** — identical to the documented pre-integration baseline; all 48 confined to 6 pre-existing treasury/cash files untouched by this integration (`cash-session-tender-totals.query.service.ts`, `cash-session-close.service.ts`, `cash-sessions.service.ts`, `treasury.controller.ts`, `cash-movements-close-and-payment-concurrency.e2e-spec.ts`, `cash-session-close.e2e-spec.ts`); zero new findings |
| `npm audit` | **8 vulnerabilities (7 high, 1 moderate)** — unchanged from baseline; zero new dependency; zero lockfile diff (`package-lock.json`/`package.json` untouched by this session) |

## 7. Full E2E (exactly one run, no rerun to manufacture green)

Command: `npm run test:e2e -- --maxWorkers=2`

**Result: 93/94 suites, 1470/1471 tests, exit 0 at the harness level (1 test
failure).**

One failure: `test/kds-authorization.e2e-spec.ts` — `NEGATIVE: no
kds.operate permission -> 403`, which failed on an unrelated setup step
(`expected 200 "OK", got 401 "Unauthorized"` on a terminal-bind call at
line 145, before the assertion under test ever ran). This file is untouched
by AUD-1 or DR-1 (no AUD/DR commit modifies KDS, terminal-auth, or PIN-login
code), and per the branch's own established pattern from prior integration
sessions (MW1E, MW1F, MW1G), full-suite Postgres contention across this
host's multiple concurrently-running lane containers (`ros-postgres-lane-a`
through `-g`, all up during this run) has repeatedly produced isolated,
non-reproducing failures in files the integrating commits never touched.

Per task instruction ("If one suite fails, isolate only that suite and
classify"), the suite was re-run alone, not the full suite:

```
NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json \
  --maxWorkers=1 kds-authorization
```

Result: **14/14 tests, 1/1 suite, 0 failures.**

**Classification: Class C — contention-only.** Clean in isolation,
unrelated to any file this integration touched, consistent with the
branch's documented full-suite-load contention pattern. No second full-
suite run was performed to manufacture 94/94; this is reported honestly as
93/94 (full run) with the isolated re-run's clean result as corroborating
evidence, per this repository's reporting policy and the task's explicit
"do not rerun the full suite to manufacture green" instruction.

## 8. Cleanliness checks

- **Orphan scratch DBs:** 0, before and after (checked via
  `SELECT datname FROM pg_database WHERE datname LIKE 'ros_test_e2e_%'`
  against the local dev container; the harness's own sweep also confirmed 0
  after both the full run and the isolated re-run).
- **Persistent `ros` untouched:** confirmed via `git worktree list` — the
  persistent checkout at `/Users/mac/projects/ros` remains at `358feb4` on
  `feat/production-spec`, unchanged before and after this session. This
  session's work is entirely within the `full-srs/4day-integration`
  worktree and a local dev Postgres Docker container distinct from that
  checkout.
- **`git status`:** clean, before, during (after every cherry-pick and every
  test run), and after this session.

## 9. Requirement dispositions (carried forward, not re-adjudicated)

This integration performed no new implementation work and re-adjudicated no
requirement. Dispositions below are exactly as accepted on each source
branch, now present on the integration branch:

- **FR-AUD-007:** COMPLETE, governance-authorized (AUD-R1 RATIFIED).
- **FR-AUD-008:** PARTIAL — `audit_entries.branch_id` remains a pre-existing,
  unpopulated column no producer writes yet; mechanically correct otherwise.
- **FR-AUD-005:** PARTIAL — scheduled detection complete; human alert
  delivery absent (governance N-A, no notification substrate this phase).
- **FR-DR-002:** implementation accepted; requirement remains PARTIAL for
  the same reason (human alert delivery absent, N-A).
- **Backup/restore (FR-DR-020/021/NFR-REL-013):** unchanged — NOT
  ATTEMPTED, NOT VERIFIED, not claimed by DR-1 or this integration.

No requirement is claimed COMPLETE by this report that was not already
COMPLETE on its source branch. No new `KNOWN_DEVIATIONS` were introduced.

## 10. No push / no deploy / no rebase / no destructive git

Confirmed throughout this session: no `git push`, no deployment action, no
`git rebase`, no squash, no history rewrite, no `--force` of any kind, no
modification to `full-srs/lane-c2-audit-production` or
`full-srs/lane-f2-dr-partition-lifecycle` (both left exactly as found), no
touch to the persistent `ros` checkout.
