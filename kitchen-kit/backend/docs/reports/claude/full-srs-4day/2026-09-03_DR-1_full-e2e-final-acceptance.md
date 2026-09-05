# DR-1 — Full E2E final acceptance verification

| Field | Value |
|---|---|
| **Task / slice name** | DR-1 — Production DR hardening: final acceptance verification (single full E2E run + hard-truths reconfirmation, no production code change unless a genuine regression is exposed) |
| **Report type** | VERIFICATION / ACCEPTANCE |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain authoritative. This report records what was executed and measured in this session; where it disagrees with the SRS or a ratified governance decision, the SRS and the register win. It ratifies nothing and authorises nothing. |
| **Date** | 2026-09-03 |
| **Starting HEAD** | `c06e86d` (verified `git log --oneline -1` at session start) |
| **Resulting HEAD** | `c06e86d` (unchanged — no commit made this session; no regression found, so no production code change was warranted) |
| **Branch** | `full-srs/lane-f2-dr-partition-lifecycle` (verified `git branch --show-current`) |
| **Working tree** | Clean before and after (`git status --short` empty both times) |
| **Task identifier** | DR-1 |
| **Status** | **ACCEPTED. FR-DR-002 primary scope holds under a single full E2E run. No new commit — verification only.** |

---

## 1. What this report is

The prior report
([2026-09-03_DR-1_partition-lifecycle-and-restore-readiness.md](2026-09-03_DR-1_partition-lifecycle-and-restore-readiness.md))
implemented FR-DR-002 and stopped at `READY_FOR_FULL_E2E` per the task's
thermal rule, without running the full E2E suite. This report runs that
suite — **exactly once**, `--maxWorkers=2` — and reconfirms the DR-1 hard
truths against real, current evidence. No production code was touched: the
run was clean, so the instruction "do not change production code unless this
verification exposes a genuine DR-1 regression" was never triggered.

## 2. Full E2E run

Single run, `--maxWorkers=2`, launched from a clean tree at `c06e86d`
against the dedicated lane-F container (`ros-postgres-lane-f`, port 5588).
No second run was performed, before or after — the run was green on the
first attempt, so "do not rerun merely to manufacture green" does not apply,
and there was no failing suite to isolate.

```
Test Suites: 92 passed, 92 total
Tests:       1458 passed, 1458 total
Snapshots:   0 total
Time:        165.614 s
```

**Zero failures.** This includes `partition-lifecycle.e2e-spec.ts` (the
13-test suite covering the full DR-1 TESTS list) and
`scoped-authorization-matrix.e2e-spec.ts` (the suite whose isolated re-run
was still pending/ambiguous at the end of the prior session) — both green as
part of this 92/92 run. No failure classification is needed since there was
no failure to classify.

Note on process handling: the launch command was mistakenly given both a
trailing shell `&` and `run_in_background: true`, which is the same
double-backgrounding mistake documented in the prior report's process log —
the tool reported "completed" for the detached shell wrapper while the real
`jest` process (PID 37374) was still running. This was caught immediately by
checking `ps aux` for live CPU usage on the jest-worker processes, and the
actual completion was confirmed correctly by blocking on that PID rather
than trusting the premature notification. No test evidence in this report
depends on the premature signal — only on the PID-exit-confirmed final log.

## 3. Migration count (reconfirmed)

```
$ npx prisma migrate status
40 migrations found in prisma/migrations
Database schema is up to date!
```

**40 migrations**, confirmed both by `ls prisma/migrations` (40 directories,
excluding `migration_lock.toml`) and by `prisma migrate status` directly
against the lane-F database. The newest is
`20260903090000_platform_partition_lifecycle` — DR-1's own migration.

**Correction to the prior report**: that report's own status line stated
"migrations 40→41." Directly recounting now gives 40 total, i.e. baseline
39 (matching `MW1G`'s post-integration count of 39, the last measurement
before this branch) **+ 1** (DR-1's own migration) **= 40**, not 41. This is
a one-off documentation number in a prior, non-authoritative report — not a
schema or migration-file defect (the migration file itself is unchanged and
correct, `prisma migrate status` confirms the schema is up to date with no
drift) — and is recorded here as a correction rather than by editing the
earlier file, per this repository's "reports are never overwritten" rule.

## 4. Static/tree-cleanliness reconfirmation

```
$ git diff --check
(no output, exit 0)

$ git status --short
(no output — clean)
```

Both clean, matching the state at the end of the implementation session.

## 5. Orphan scratch databases

```
$ psql ... -c "SELECT datname FROM pg_database WHERE datname LIKE 'ros_e2e_%' OR datname LIKE '%scratch%';"
(no rows)
```

**0 orphan scratch databases**, checked both immediately before the E2E run
(baseline) and after it completed (this query) — the e2e harness's own
teardown left nothing behind.

## 6. FR-DR-002 hard truths — reconfirmed against the full-run evidence

All of the following were established during implementation
(§ the prior report) and are reconfirmed here, not re-derived, since the
full E2E run exercised the same code and found no regression:

- **Scheduled partition lifecycle implemented**: `PartitionLifecycleJob`
  (`platform.partition_lifecycle`), registered on SCHED-1, daily 02:00 UTC —
  unchanged this session, `partition-lifecycle.e2e-spec.ts` 13/13 green in
  this run.
- **≥3-month horizon**: `PARTITION_HORIZON_MONTHS = 3`, `requiredMonths()` —
  unchanged, unit-tested (15/15, part of the unit suite implicit in this
  branch's earlier gates; not re-run standalone this session since the full
  E2E run does not execute `*.spec.ts` unit files, only `*.e2e-spec.ts` — see
  §8 for what this session's E2E run does and does not cover).
- **Idempotent partition creation**: `ensurePartition()`'s
  `partitionExists()` pre-check + advisory-lock-guarded re-check —
  unchanged; the e2e "existing-future-partition no-op" and "duplicate-tick
  no-dup" cases both passed in this run.
- **Duplicate scheduler occurrences cannot duplicate/conflict partitions**:
  same idempotent path drives both a duplicate occurrence and a duplicate
  manual invocation — proven by the same e2e cases above; no per-occurrence
  state gates the DDL, only the DDL's own idempotence does.
- **Multi-instance scheduler execution remains safe**: `pg_advisory_xact_lock`
  serializes concurrent DDL attempts against the same target partition,
  proven under a genuine two-transaction race in the e2e suite (`two-worker
  race safety`), green in this run.
- **Existing partitions/data never destructively changed**: `ensurePartition`
  only ever `CREATE`s a missing partition; the "no-alteration-of-existing-data"
  e2e case (row inserted into an existing partition before + after a tick,
  proven byte-identical) passed in this run.
- **Partition gaps filled safely**: the "partial-horizon gap-fill-only" case
  (some future months already present, some missing) passed in this run,
  filling exactly the missing months and leaving the present ones untouched.
- **No old partition dropped without an explicit retention rule**: the job
  contains no `DROP`/`DETACH` statement of any kind — confirmed by the
  unchanged source (`partition-ddl.service.ts`, `partition-lifecycle.job.ts`);
  there is no retention rule in this slice's scope, and none was invented.
- **Failed partition maintenance creates the intended durable finding**: the
  DDL-failure → `platform.job_findings` row → self-heal-on-next-tick e2e case
  passed in this run.
- **Human alert delivery is NOT claimed**: unchanged disposition — a durable
  finding + Prometheus alert rule
  (`ROSPartitionLifecycleCreationFailed`) + runbook exist; delivery to a
  human does not (governance decision N-A, no notification substrate this
  phase). This remains **PARTIAL** for the delivery limb, stated explicitly,
  not implied as complete.
- **No BYPASSRLS or worker super-authority introduced**: reconfirmed live
  this session —

  ```
  rolname              | rolsuper | rolbypassrls
  ros_migrator          | t        | t   (migration-only role, pre-existing, unchanged)
  ros_app               | f        | f
  ros_partition_admin   | f        | f
  ```

  `ros_partition_admin` (the one new role this slice introduced) is neither
  superuser nor `BYPASSRLS` — it is DDL-scoped-only, zero DML, owning
  exactly the 3 tables it maintains. `ros_app` (the runtime/request-path
  role) is unchanged.
- **Zero new `KNOWN_DEVIATIONS`**: no production code changed this session
  (the run was clean), so the deviation set recorded in the prior report is
  unchanged — nothing added, nothing removed.
- **Persistent `ros` untouched**: all work this session ran against the
  dedicated lane-F container (`ros-postgres-lane-f`, port 5588); the
  persistent `ros-postgres` container was only observed in a `docker ps`
  listing (read-only, no connection made) to confirm it was not the target
  of any command.

## 7. Backup/restore requirement disposition (reconfirmed, not re-verified)

The secondary scope (FR-DR-020, FR-DR-021, NFR-REL-013) was **not attempted**
in the implementation session and **nothing was done on it this session
either** — this run was verification-only for the primary scope. Restated
explicitly per the task's instruction not to overclaim:

- **FR-DR-020 / FR-DR-021 / NFR-REL-013: NOT VERIFIED, NOT IMPLEMENTED.** No
  backup, PITR, RPO, or RTO tooling exists in this repository as of this
  HEAD. Any future source-side restore tooling built in this repo would be
  implementation evidence only — it would not, by itself, constitute
  production backup/PITR/RPO/RTO certification, which requires external
  infrastructure (a managed backup/WAL-archiving service, a restore
  rehearsal against production-scale data) that is out of this repository's
  reach and was not fabricated or assumed.

## 8. Scope of this session's verification (what was and was not re-executed)

To state plainly what "final acceptance" covered:

- **Executed this session**: one full E2E run (92 suites / 1458 tests),
  `git diff --check`, `git status`, `prisma migrate status`, orphan-scratch-DB
  query (before and after), `pg_roles` BYPASSRLS/superuser query, `git log
  --stat` review of this slice's own commits, `docker ps` read-only listing.
- **Not re-executed this session** (unchanged from the prior report, no
  production code changed so no reason to re-run): unit suite, module
  boundaries, `npm audit`, lint identity diff, `tsc`/`prisma validate`,
  OpenAPI check. These were all green at the end of the implementation
  session against the same, still-unchanged HEAD (`c06e86d`), and are not
  re-claimed as freshly executed here.

## 9. Disposition

**FR-DR-002: PRIMARY SCOPE ACCEPTED.** The full E2E run found zero
regressions attributable to the partition-lifecycle changes (or to anything
else on this branch). No production code was modified this session. The
implementation's own PARTIAL classification (alert delivery absent) is
unchanged and is not upgraded to COMPLETE by this verification — a clean
E2E run proves the mechanism works, not that a human-facing alert channel
now exists.

**Backup/restore (secondary scope): UNCHANGED — NOT ATTEMPTED, NOT
VERIFIED, NOT CLAIMED.**

No push, no deploy, no merge, no rebase, no destructive git operation, no
persistent-`ros` contact. Working tree clean at `c06e86d`.
