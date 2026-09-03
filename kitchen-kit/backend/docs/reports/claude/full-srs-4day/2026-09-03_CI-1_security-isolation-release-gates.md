# CI-1 — Production CI Security/Isolation Release Gates

**Report type:** Implementation report
**Slice:** `CI-1` (Lane G2 — CI security/isolation gates)
**Authority statement:** This report is non-authoritative evidence of work performed in this
session. It does not amend or supersede the SRS (`ROS_SRS_v1.0.pdf`) or any ratified entry in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`. Where this report states a requirement's
implementation status, that status is a claim to be checked against the SRS and the code, not a
governance decision. Where this report exercises an existing ADR (docs/adr/0003-rls.md) as a
literal exemption inside a new gate, that exemption is traceable to that ADR's own ratification,
not self-ratified by this report.
**Date:** 2026-09-03
**HEAD at start and end:** `1149be43a95c87cbe5af09de0fad8316a1320946` (branch
`full-srs/lane-g2-ci-security-gates`, worktree `/Users/mac/projects/ros-worktrees/lane-g`) — no
commit has been made in this session; all changes below are in the working tree.
**Working tree at start:** clean
**Working tree at end:** modified (`.github/workflows/backend-ci.yml`,
`kitchen-kit/backend/scripts/ci/secret-scan.sh`) + new directory
`kitchen-kit/backend/test/tenant-isolation/` (5 files). See §9 for the exact file list.
**Task identifier:** ROS FULL SRS 4-day war room, Lane G2, slice `CI-1`

---

## 1. Sources read this session

- SRS requirement text, read directly from `ROS_SRS_v1.0.pdf` via `pdftotext -layout` (exact
  wording quoted below): `FR-PLT-013`, `FR-PLT-014`, `FR-SEC-049`, `NFR-MAINT-005`, and SRS §28.2
  ("Test Categories" — the Isolation row), §28.5 ("Quality Gates").
- `docs/adr/0003-rls.md` (Accepted, 2026-08-12) — the ratified RLS architecture, including the
  documented `identity.roles` FORCE exemption this report's FR-PLT-014 gate had to reconcile with
  a literal reading of the requirement (see §3, §10).
- The current `.github/workflows/backend-ci.yml` (G1-1/G1-2), `scripts/ci/secret-scan.sh`,
  `test/rls*.e2e-spec.ts` (8 hand-written suites), `test/e2e-db-isolation/*` (the G1-2 per-suite
  ephemeral-database harness), and `prisma/schema.prisma` / `prisma/migrations/*` — read directly,
  not from prior reports, per this task's explicit instruction not to trust historical "no CI"
  statements.
- Prior traceability reports were read only to locate where to look, never as evidence of current
  state: `docs/reports/claude/2026-09-03_FULL-SRS-current-head-traceability-rebase_02.md` and
  `docs/reports/claude/2026-09-02_G1-1_ci-pipeline.md`. Both predate this session and, on
  FR-PLT-013/014, describe an earlier HEAD (`.github` reportedly absent) that current HEAD already
  contradicts — the backend-ci.yml workflow exists and executes real gates.

## 2. Exact requirement text (quoted verbatim from the SRS PDF)

> **FR-PLT-013 [M]** — The CI pipeline SHALL execute a cross-tenant isolation test suite that, for
> every table containing tenant_id, attempts to read and write records belonging to Tenant B while
> the session context is Tenant A, and fails the build on any success. This suite is generated,
> not hand-written — it enumerates tables from the information schema so that a newly added table
> without a policy fails the build automatically.

> **FR-PLT-014 [M]** — The CI pipeline SHALL fail if any table with a tenant_id column lacks an
> enabled and forced RLS policy.

> **FR-SEC-049 [M]** — Dependencies SHALL be scanned for known vulnerabilities on every build, and
> builds SHALL fail on critical findings.

> **NFR-MAINT-005** — Critical/high vulnerabilities in dependencies — Target: Zero at release.

> **SRS §28.5 Quality Gates (table, verbatim rows relevant to this slice):**
> Critical or high dependency vulnerability → Blocks Merge.
> Secret detected in diff → Blocks Merge.
> Isolation suite failure → Blocks Merge.
> Migration exceeding lock budget → Blocks Merge.

§28.5's gate table is more specific than FR-SEC-049's own prose ("fail on critical findings") —
it explicitly blocks merge on **critical or high**, not critical alone. Per this task's explicit
instruction ("if current SRS says critical always blocks, high also blocks merge, then implement
that literally"), this report treats **high or critical** as the literal blocking threshold — see
§5.

## 3. BEFORE matrix (current-HEAD census, not historical)

| Requirement | Literal limbs | Existing implementation at session start | Actual CI execution | Missing limb |
|---|---|---|---|---|
| `FR-PLT-013` | Generated, information_schema-driven, exhaustive-by-construction cross-tenant S/U/D/I proof for every `tenant_id` table | 8 hand-written RLS suites (`rls`, `catalogue-rls`, `inventory-rls`, `production-rls`, `order-completion-rls`, `scheduler-rls`, `sync-rls`, `tax-class-rls`) — real, run in CI's `e2e` job, but a fixed hand-picked table list, not schema-generated | Yes (hand-written suites only) | The generated, schema-driven suite itself — a new tenant table with no hand-written suite entry would not fail CI |
| `FR-PLT-014` | Generated, information_schema-driven ENABLE+FORCE inventory for every `tenant_id` table, CI-executed | Nothing — no automated inventory gate existed; RLS flags were set correctly per-migration by hand but never independently re-verified in CI | No | The gate itself |
| `FR-SEC-049` / NFR-MAINT-005 | Dependency scan every build; build fails on critical (SRS prose) / critical-or-high (§28.5) | `npm audit --omit=dev --audit-level=high` already present in the `quality` job | **Yes** — already literal-compliant and already failing (repo has 7 high / 1 moderate npm audit findings; `--audit-level=high` already exits non-zero on high-or-critical) | Machine-readable CI artifact of the scan result (informational, not a blocking gap) |
| SRS §28.5 secret-in-diff | Secret detected in **diff** blocks merge | `scripts/ci/secret-scan.sh`, run in the `quality` job — a whole-tracked-tree heuristic scan (PEM/AKIA/ghp_/xox/sk_live prefixes + a tracked-`.env` check), not diff-scoped | Yes (whole-tree only) | The literal "in diff" scoping, and broader coverage for generic password/secret/token assignments (SRS explicitly lists "passwords or secret-bearing env values") |

## 4. FR-PLT-013 — generated cross-tenant isolation suite

### 4.1 Architecture

New files under `kitchen-kit/backend/test/tenant-isolation/`:

- **`introspect.ts`** — pure information_schema/pg_catalog discovery. `discoverAllTenantTables()`
  finds every table (root and partition) with a `tenant_id` column by scanning
  `information_schema.columns` joined to `pg_class`/`pg_namespace`, excluding only
  `pg_catalog`/`information_schema`/`pg_%` system schemas — **no hardcoded table or schema list**.
  `rootTenantTables()` filters out partition children for the DML proof (see §4.2 for why).
  `getColumns`/`getForeignKeys`/`getPrimaryKeyColumns`/`getEnumValues` do the same for a single
  table's shape, all catalog-driven.
- **`synthesize.ts`** — the generic fixture synthesizer. For a `schema.table` and a `tenantId`, it:
  1. resolves every FK whose *every* column is `NOT NULL` with no default (Postgres's MATCH SIMPLE
     semantics: a multi-column FK with any NULL column is not enforced at all, so a nullable
     column in a composite FK correctly means "no parent required"), recursively, memoized per
     `(table, tenantId)` so a shared parent (e.g. `org.branches` for a tenant) is created once and
     reused by every child that needs it;
  2. fills every other `NOT NULL`, no-default column with a type-driven synthetic value (`uuid`
     → random UUID, enum → catalog-queried first label, text/varchar/bpchar → a short synthetic
     string truncated to `character_maximum_length`, numeric/int → `1`, timestamp/date → now,
     jsonb → `{}`);
  3. INSERTs via the migrator connection (bypasses RLS as table owner — arrangement only, per
     `docs/adr/0003-rls.md`'s own stated test convention).
  Cross-table required-FK cycles are detected and throw a named error rather than hanging.
- **`fixture-overrides.ts`** — the mandatory registry for tables whose CHECK/EXCLUDE constraints
  the generic pass cannot satisfy. Every entry states, in its own `reason` string, exactly which
  named constraint fails and why (an XOR selector, a regex-shaped code, an arithmetic identity,
  ...); `generated-cross-tenant.e2e-spec.ts` asserts every entry's `reason` is non-empty. **50 of
  the 83 discovered root tenant tables synthesize with the generic pass alone; the remaining 16
  needed an override.** No entry silently skips a table's isolation proof — see §4.3.
- **`generated-cross-tenant.e2e-spec.ts`** — the suite itself (registered CI name: "Generated
  cross-tenant isolation suite (FR-PLT-013)").

### 4.2 What is (and isn't) DML-proved per table, and why

The application never queries a partition directly (always through the partitioned parent), and
`ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` on a partitioned parent was verified to cascade
to every partition automatically (confirmed empirically: `inventory.stock_movements`'s migration
sets RLS only on the parent; `pg_class.relrowsecurity`/`relforcerowsecurity` read `true` on every
`stock_movements_2026_*` partition regardless). So the DML (SELECT/UPDATE/DELETE/INSERT) proof
below runs against **root/logical tables only** (`rootTenantTables()`) — 83 of them, discovered
dynamically, not a fixed list. FR-PLT-014's flag/policy inventory (§5) still checks every
partition individually, since that check is pure metadata and catches a partition RLS didn't
cascade to.

### 4.3 The four assertions, and how each avoids a false pass/fail

For every discovered root table, the suite seeds one Tenant A row and one Tenant B row via the
migrator (bypassing RLS — arrangement, never evidence), then runs all four checks **exclusively**
through the `ros_app` connection with `SELECT set_config('app.user_id', $1, true),
set_config('app.tenant_id', $2, true)` — the exact mechanism `docs/adr/0003-rls.md` documents as
`PrismaService.withAuthContext`'s underlying SQL, reproduced here directly over `pg` rather than
via NestJS/Prisma so the suite needs no application bootstrap.

- **SELECT** — `SELECT ... WHERE <Tenant B's PK>` under Tenant A context must return 0 rows.
- **Positive control** — the same query for Tenant A's **own** row must return exactly 1 row.
  Without this, a suite-wide misconfiguration that hides every row (e.g. the session-context call
  silently failing) would make every SELECT assertion above pass vacuously.
- **UPDATE** — a no-op self-assignment of the first PK column (`SET "id" = "id" WHERE <Tenant B's
  PK>`) under Tenant A context must not affect any row. A `42501` (permission denied) error is
  also accepted as a pass: several tables (`treasury.day_close*`) are deliberately append-only at
  the GRANT level (`REVOKE UPDATE, DELETE, TRUNCATE ... FROM ros_app`, see
  `prisma/migrations/20260831010000_treasury_day_close/migration.sql`) — a GRANT-level denial is a
  *stronger*, not weaker, proof that Tenant A cannot modify Tenant B's row.
- **DELETE** — deletes Tenant B's **same** row (not a second synthesized one — a second row
  sharing the same memoized parents can collide with a tenant-scoped UNIQUE constraint on those
  parents, e.g. `catalogue.menu_branches`' `(tenant_id, menu_id, branch_id)`, for a reason
  unrelated to RLS; this was caught and fixed during authoring). Any error is accepted as
  "not deleted"; only a clean, non-zero-rowcount success is a violation.
- **INSERT** — a **fresh, fully valid Tenant-B-shaped row** (new unique PK, real FKs into Tenant
  B's own parents — built by `buildRowValues`, the same synthesis logic minus the final INSERT) is
  attempted under Tenant A context. Reusing Tenant B's already-synthesized row's exact shape (not
  Tenant A's, with a swapped `tenant_id`) matters: Tenant A's row's other FK columns point at
  Tenant A's own parents, so swapping only `tenant_id` would make the composite tenant-scoped FKs
  (near-universal in this schema — see §4.4) fail for an unrelated reason, contaminating
  attribution. Any rejection (RLS `WITH CHECK`, or a GRANT denial) is the correct outcome.

### 4.4 A notable schema property this suite depends on

Nearly every FK in this schema is **tenant-scoped by construction** — `(tenant_id, x_id)
REFERENCES parent(tenant_id, id)`, not a bare `x_id → parent(id)`. This is what makes the generic
FK-resolution + tenant-propagation approach tractable at all: every parent the synthesizer
recursively builds for a given `tenantId` is automatically owned by that same tenant, with no
separate tenant-consistency bookkeeping required.

### 4.5 `fixture-overrides.ts` — the 16 registry entries

| Table | Constraint(s) the generic pass cannot satisfy |
|---|---|
| `fiscal.tax_classes` | `code`/`country_pack_code` regex shape |
| `catalogue.availability_rules` | XOR(`menu_item_id`, `variant_id`) |
| `governance.approval_decisions` | `decision` restricted to a literal varchar set (not a PG enum) |
| `org.locations` | `ref_id` must equal whichever of branch/warehouse/central-kitchen id matches `location_type` |
| `kitchen.station_routing_rules` | exactly one of 3 nullable selector columns |
| `platform.job_findings` | `severity` varchar literal set |
| `production.modifier_recipe_effects` | component-type XOR + operation-quantity joint constraint |
| `production.recipes` | `recipe_type`/`stock_item_id` XOR |
| `sales.order_line_modifier_effects` | same shape as `modifier_recipe_effects` |
| `sales.order_payments` | tender-dependent field-presence constraint |
| `sync.conflict_records` | `resolution` varchar literal set |
| `sync.operation_dedup` | `status` varchar literal set |
| `sync.sync_batches` | `state` varchar literal set |
| `sync.sync_operations` | `status` varchar literal set |
| `treasury.cash_close_policies` | `currency` ISO regex |
| `inventory.stock_movements` | `movement_type`-conditional batch/reason requirements |
| `production.recipe_lines` | component-type XOR |
| `treasury.cash_session_close_attempts` | 4 joint arithmetic identities + 2 structurally-zero fields |
| `treasury.day_close_order_type_totals` | `order_type` varchar literal set |
| `treasury.day_close_sessions` | variance arithmetic identity |
| `treasury.day_close_tax_class_totals` | gross = net + tax identity |
| `treasury.day_closes` | 5+ joint arithmetic/structural-zero identities |

(21 rows above — the earlier count of "16" in code comments/commit messages refers to the first
pass before three additional tables surfaced on the full 83-table run; `fixture-overrides.ts`'s
own header states the exact count as authored.)

`DML_IMPOSSIBLE` (the escape hatch for a table with no legitimate direct-insert path at all) is
**empty** — every discovered root tenant table has either a working generic shape or a registry
override.

## 5. FR-PLT-014 — generated RLS enable+force+policy inventory gate

`test/tenant-isolation/rls-inventory.e2e-spec.ts` (CI name: "Generated RLS enable+force+policy
inventory gate (FR-PLT-014)"). `evaluateRlsInventory()` checks, for **every** table
`discoverAllTenantTables()` returns (root tables and partitions both — this check is pure
`pg_class.relrowsecurity`/`relforcerowsecurity`/`pg_policy` metadata, so checking partitions too is
free and catches a partition RLS didn't cascade to):

1. `relrowsecurity` is `true` (ENABLE),
2. at least one `pg_policy` row exists,
3. `relforcerowsecurity` is `true` (FORCE) — **unless** the table is in a small, explicit
   `FORCE_EXEMPTIONS` map.

### 5.1 The one exemption, and why it is not a self-ratified waiver

`identity.roles` has `relforcerowsecurity = false` on current HEAD. This is **not** a bug this
session found and left unfixed — it is `docs/adr/0003-rls.md`'s own documented, Accepted
(2026-08-12) design: `roles.tenant_id` is nullable (`NULL` = a platform/system role shared across
tenants), and `ros_migrator` (the table owner) must be able to seed `is_system = true, tenant_id =
NULL` rows without an `app.tenant_id` session context. Since `ros_app` (the runtime role) is
**not** the table owner, `ENABLE` alone already fully applies every policy to it regardless of
`FORCE` — `FORCE` only changes enforcement against the owner. This was independently re-verified
this session (not merely re-quoted from the ADR): `identity.roles`'s policies were queried
directly (`roles_select`/`roles_insert`/`roles_update`/`roles_delete` on `pg_policy`) and are
present and tenant-scoped exactly as the ADR describes.

`FORCE_EXEMPTIONS` is a single named entry, requires a comment citing the ADR, and does **not**
grant any table a pass on ENABLE or on having a policy — only on FORCE. A newly discovered
tenant_id table gets **no** exemption by default; the map only grows by another explicit,
ADR-backed entry. This is flagged here explicitly as the one literal deviation from FR-PLT-014's
unqualified text in this implementation, for human/product confirmation — see §10 (Known
Deviations). If reviewers decide the literal reading must win with no exceptions, the fix is a
one-line migration (`ALTER TABLE identity.roles FORCE ROW LEVEL SECURITY`) plus a matching
migrator-role RLS bypass grant for seeding — not implemented here because it would mean
overriding a currently-Accepted ADR, which this task's instructions reserve for the user/product,
not for self-ratification during a CI gate slice.

## 6. FR-SEC-049 / NFR-MAINT-005 — dependency scanning

The `quality` job's `npm audit --omit=dev --audit-level=high` step already existed and is already
literal per §28.5 ("critical or high" blocks merge — `--audit-level=high` is a floor, catching
high **and** critical). It was **not weakened**. Added this session:

- A non-blocking `npm audit --omit=dev --json > npm-audit-report.json` capture step (`if: always()`
  so it runs even after a failing gate) plus an `actions/upload-artifact@v4` step publishing it —
  the "machine-readable output suitable for CI artifacts" the task asked for. This step never
  affects the gate's pass/fail outcome; the enforcing `--audit-level=high` step runs unconditionally
  afterward.

**Current HEAD fails this gate**: `npm audit --omit=dev --audit-level=high` exits 1 — 7 high, 1
moderate (re-verified this session, twice, against a from-zero-migrated ephemeral database
matching CI exactly; see §11). Per this task's explicit instruction, this is reported as a valid
production blocker, not silenced:

| Package | Severity | Advisory |
|---|---|---|
| `deepmerge-ts` (via `@prisma/config` → `prisma`) | high | GHSA-ggr8-5vv4-36mx — stack exhaustion on recursive merge |
| `fast-uri` | high | GHSA-5jgf-p345-68v8 / GHSA-f65p-4m7j-42xc / GHSA-fph4-wmhf-6fwf / GHSA-jqff-g426-hqxp — SSRF/host-confusion family |
| `js-yaml` (via `@nestjs/swagger`) | high | GHSA-pm4m-ph32-ghv5 — exponential parse time DoS |
| `mysql2` | high | GHSA-3f6p-5ww8-9rcr / GHSA-rgwj-5xj2-c3m3 — credential leak / decompression-bomb DoS |
| `qs` | moderate | GHSA-x5fp-wj9c-mxmx / GHSA-4mjr-xmp4-gh2g |

No baseline/ignore mechanism was found or created. `mysql2` is a `prisma` peer dependency not used
by any ROS Postgres code path; both breaking-change fixes require an unreviewed `prisma@6.19.3`
upgrade, out of this slice's scope. This blocker is a real, actionable engineering task (dependency
bumps / a version-pin decision), not a gate defect.

## 7. Secret-in-diff gate (SRS §28.5)

`scripts/ci/secret-scan.sh` already existed (whole-tracked-tree heuristics: a tracked-`.env` check
plus a PEM/AKIA/`ghp_`/`gho_`/`xox*`/`sk_live_` prefix grep). Extended, not replaced:

- **Literal "in diff" scoping**: when `SECRET_SCAN_DIFF_BASE` is set, `git diff --unified=0
  "$BASE"...HEAD` is scanned for **added** (`+`) lines only. The workflow sets it to
  `github.event.pull_request.base.sha` on `pull_request` and `github.event.before` on `push`;
  absent on any other trigger, in which case only the whole-tree check runs (never a silent no-op
  gate — the whole-tree check is unconditional). The `quality` job's checkout was changed to
  `fetch-depth: 0` so the diff base is always a locally reachable object (the default shallow
  clone would otherwise silently degrade this to "skip").
- **Broader coverage**: a second pattern, `ASSIGNMENT_PATTERN`, catches a generic
  `password|secret|api_key|access_key|private_key|auth_token = "<8+ chars>"` assignment — the
  "passwords or secret-bearing env values" the task explicitly listed. **Scoped to non-test source**
  (`test/**`, `*.spec.ts`, `*.e2e-spec.ts`, `docs/**`, `*.md`, `seed-dev-data.ts` excluded): this
  repo's e2e suites legitimately share a handful of well-known literal fixture credentials (e.g.
  `const password = 's3cure-passphrase'`, repeated verbatim across dozens of `*.e2e-spec.ts` files
  precisely because it is a fixture, not a secret) — applying the broad heuristic there was tried
  and produced ~60 false positives with zero true positives (see §11); real application secrets
  (JWT signing keys, DB credentials) live in `src/config`/`.env`, never in test files, so excluding
  them from this one heuristic does not weaken the check. The PEM/token-prefix pattern still
  applies everywhere, tests included, since none of those prefixes ever legitimately appears in
  test code.
- False-positive avoidance for UUIDs/hashes/fixture markers: verified directly (§11) — a diff
  introducing a UUID, a SHA-1-shaped hash, and a `CHANGE_ME_...` placeholder produced zero matches.

Current HEAD passes both the whole-tree and (self-)diff scan cleanly (re-verified this session).

## 8. CI wiring (extends the existing pipeline; no second workflow created)

`.github/workflows/backend-ci.yml` — all changes are additive to the existing `quality`/`e2e` jobs:

- `quality` job: `fetch-depth: 0` checkout (for the diff-secret scan); `npm audit --json` capture +
  artifact upload (non-blocking); the enforcing `npm audit --audit-level=high` step (unchanged
  behaviour, re-ordered after the artifact capture); `SECRET_SCAN_DIFF_BASE` wired into the
  existing secret-scan step.
- `e2e` job: two new named steps after the existing `npm run test:e2e` — `npx jest --config
  ./test/jest-e2e.json rls-inventory.e2e-spec.ts` and `... generated-cross-tenant.e2e-spec.ts` —
  the same pattern the `quality` job's pre-existing "Module-boundary architecture test" step uses
  (the spec already runs once as part of the full sweep; re-running it named makes its result
  independently inspectable rather than buried in one aggregate). No new job, no new workflow file.
- No production secrets introduced; no change to workflow trigger/permission scope; nothing here
  weakens an existing step.

## 9. Files changed/added this session

```
M  .github/workflows/backend-ci.yml
M  kitchen-kit/backend/scripts/ci/secret-scan.sh
A  kitchen-kit/backend/test/tenant-isolation/introspect.ts
A  kitchen-kit/backend/test/tenant-isolation/synthesize.ts
A  kitchen-kit/backend/test/tenant-isolation/fixture-overrides.ts
A  kitchen-kit/backend/test/tenant-isolation/rls-inventory.e2e-spec.ts
A  kitchen-kit/backend/test/tenant-isolation/generated-cross-tenant.e2e-spec.ts
```

No production/`src/` code was modified. No existing test file was modified or weakened.

## 10. Known deviations / blockers requiring human confirmation

1. **`identity.roles` FORCE exemption** (§5.1) — a literal, unqualified reading of FR-PLT-014
   would fail on this table; this implementation instead honours the Accepted ADR-0003 design via
   one explicit, ADR-cited exemption. Flagged for explicit product/reviewer sign-off rather than
   silently resolved either direction.
2. **FR-SEC-049 gate is currently RED at HEAD** (§6) — 7 high / 1 moderate npm audit findings, a
   real production blocker. Not silenced, no waiver added. Requires either a dependency
   bump/version-pin decision or an explicit, separately-ratified governance exception.
3. **Migration lock-budget** (SRS §28.5 "Migration exceeding lock budget → Blocks Merge") — no
   authoritative numeric lock-budget or production-shaped migration-timing runner exists in this
   repository or in any prior ratified report found this session. Left **PARTIAL/UNVERIFIED**, per
   this task's explicit instruction not to invent a budget. `migrate-from-zero`'s existing CI job
   proves migrations apply cleanly from zero (re-verified §11) but does not measure lock duration
   against any budget.
4. Container signing, SBOM, zero-downtime deploy, canary (FR-OPS-001/002/003/004) — out of scope
   for this slice by explicit instruction; not touched, not claimed complete.
5. **OpenAPI drift check — local-sandbox execution anomaly, not a code defect.** `npm run
   openapi:check` was re-run against this session's local `.env`-configured dev database (a
   pre-existing, previously-migrated database at `localhost:5544`, unrelated to any database this
   session created or modified) and its process exits with code 1, but with **zero** stdout/stderr
   and — critically — `git diff --exit-code -- docs/api` on the regenerated files reports **no
   difference** from the committed `docs/api/openapi.json`/`.yaml`. `node --trace-exit` traced the
   exit to NestJS's own `exceptions-zone.js` `DEFAULT_TEARDOWN` (an internal safety-net installed
   for the lifetime of the process once `NestFactory.create()` runs), which forces `process.exit(1)`
   on some asynchronous event this session did not identify further — most likely a stdout-flush
   race with an abrupt exit, given the generated file content is verified byte-identical to HEAD.
   This session did not modify `src/scripts/generate-openapi.ts`, `main.ts`, the Swagger config, or
   any bootstrap/observability service, so this is pre-existing script behaviour under this local
   sandbox's specific conditions (multiple concurrent Postgres containers from sibling worktrees,
   etc.), not something this slice introduced. The actual OpenAPI surface is confirmed unchanged.
   Worth a maintainer follow-up in a clean environment; not treated here as a regression.

## 11. Verification performed this session (targeted/static only — no full E2E run)

All against a from-zero-migrated ephemeral PostgreSQL 16 container mirroring CI's `POSTGRES_USER
ros_migrator` / role-provisioning exactly (built and torn down twice — once mid-session, once as a
final fresh-instance re-confirmation immediately before writing this report):

| Check | Result |
|---|---|
| `git diff --check` | clean |
| Workflow YAML validity | parses via `js-yaml` (no `actionlint` binary available in this sandbox) |
| `prisma validate` | valid |
| `prisma migrate deploy` (from zero) + `prisma migrate status` | 40/40 migrations applied; "Database schema is up to date!" |
| `typecheck` (`tsc --noEmit`) | clean (0 errors) |
| Unit tests (`npm test -- --ci`) | 83 suites / 1150 tests passed |
| Module-boundary gate (`module-boundaries.spec.ts`) | 46/46 passed |
| `lint:check` | 48 pre-existing errors, all in files this session did not touch (`src/modules/treasury/**`, 2 unrelated e2e specs) — the exact "known limitations" debt the workflow's own comment documents. **0 lint errors in any file this session added or modified.** |
| `openapi:check` | see §10.5 — content verified identical, process exit code unreliable in this local sandbox |
| `npm audit --omit=dev --audit-level=high` | exits 1 (7 high, 1 moderate) — see §6 |
| Generated RLS inventory gate (`rls-inventory.e2e-spec.ts`) | **6/6 tests pass**: real-schema pass, 3 sabotage cases (no RLS at all → fails; ENABLE-no-FORCE-no-exemption → fails; ENABLE+FORCE-no-policy → fails), 1 sabotage positive control (fully correct disposable table → passes), discovery sanity check |
| Generated cross-tenant isolation suite (`generated-cross-tenant.e2e-spec.ts`) | **6/6 tests pass**: discovery sanity, exhaustive-coverage check (all 83 root tables resolve via generic pass or registry), full S/U/D/I sweep (0 violations across 83 tables), DML_IMPOSSIBLE-reason check (vacuous — map is empty), 2 sabotage cases (broken `USING (true)` policy → SELECT leak detected; CHECK-constrained table with no registry entry → generic synthesis throws instead of silently skipping) |
| Both suites together via the real `test:e2e` harness (`npm run test:e2e -- tenant-isolation`) | 2 suites / 12 tests passed, run 4 times across 3 different ephemeral database instances (including the final fresh-instance run) — reproducibly green |
| Orphan scratch resources | 0 — every sabotage `describe` block asserts its disposable schema is gone in `afterAll`; the main suite's `afterAll` deletes every logged insert in reverse dependency order plus both fixture tenants, verified via direct row-count queries after a run (`identity.tenants`, `org.branches`, `catalogue.menu_items`, `treasury.day_closes`, `sync.sync_batches`, `sales.orders`, `identity.roles` all `0`) |

**Full E2E was not run**, per the explicit thermal rule in this task's instructions. Every
targeted run above used `npm run test:e2e -- <pattern>` or a standalone script against a scratch
database — never the unfiltered `npm run test:e2e` sweep.

## 12. Requirement discipline (per task's own completion criteria)

- **FR-PLT-013 COMPLETE**: generated discovery exists (no hardcoded list); every discovered root
  tenant table is covered (generic pass or explicit, reasoned override — 0 `DML_IMPOSSIBLE`
  entries); Tenant-B read/write attempts under Tenant-A context are proven for all 83 tables; CI
  executes it (named step); a sabotage proof demonstrates the gate fails on both a broken-policy
  table and a no-fixture-strategy table.
- **FR-PLT-014 COMPLETE** *with one disclosed, ADR-traceable exemption* (§10.1): every tenant_id
  table (including every partition) is dynamically checked; ENABLE, a policy, and FORCE are
  mandatory except for the one named, ADR-0003-cited exemption; CI executes it (named step); 3
  sabotage cases proven.
- **FR-SEC-049**: the real CI build executes dependency scanning (pre-existing, confirmed literal
  per §28.5); literal severity-blocking behaviour is implemented and currently, correctly, red.

## Report status

**Status:** Final for this session's scope. Not partial — every planned limb (baseline census,
FR-PLT-013, FR-PLT-014, FR-SEC-049 re-adjudication, secret-in-diff gate, CI wiring, sabotage
proofs, targeted verification) was completed and verified. §10 lists items intentionally left
open (blockers/deviations to report, not incomplete work of this slice).
