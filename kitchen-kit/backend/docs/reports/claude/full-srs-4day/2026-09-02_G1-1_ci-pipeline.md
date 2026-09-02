# G1-1 — CI Pipeline (Backend Quality Gates)

**Report type:** Implementation report
**Slice:** `G1-1` (Workstream `P3-PROD`, Lane G — Production / QA / DR / Reporting)
**Authority statement:** This report is non-authoritative evidence of work performed in this
session. It does not amend or supersede the SRS (`ROS_SRS_v1.0.pdf`) or any ratified entry in
`docs/governance/GOVERNANCE_DECISION_REGISTER.md`. Where this report states a requirement's
implementation status, that status is a claim to be checked against the SRS and the code, not a
governance decision.
**Date:** 2026-09-02
**HEAD at start:** `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71` (branch
`full-srs/lane-g-prod-reporting-dr`, worktree `/Users/mac/projects/ros-worktrees/lane-g`)
**Working tree at start:** clean
**Task identifier:** ROS FULL SRS 4-day war room, Lane G, slice `G1-1` (first of two slices; `G1-2`
follows in a separate report/commit)

---

## 1. Sources read this session

- SRS requirement text, read directly from `ROS_SRS_v1.0.pdf` (via `pdftotext -layout`, exact
  wording quoted below): `FR-PLT-013`, `FR-PLT-014`, `FR-QA-001`, `FR-QA-010`, `FR-OPS-001`,
  `FR-OPS-002`, `NFR-MAINT-004`, `NFR-MAINT-005`, `NFR-MAINT-006`, and SRS §28 ("Testing
  Strategy", specifically §28.4 Test Data and §28.5 Quality Gates) and §29.2 (CI/CD Pipeline
  diagram).
- "P0" — identified as `docs/reports/claude/2026-09-02_FULL-SRS-current-head-traceability-rebase.md`
  (self-titled "P0-REBASE — FULL SRS v1.0 CURRENT-HEAD TRACEABILITY REBASE + 4-DAY PARALLEL
  EXECUTION MAP"). Its own `##` section numbers match the brief's `§13 §14.2 §15 §23 §24 §28`
  exactly: §13 "QA — CT-01…CT-15 matrix" (§13.2 "Quality gates (§28.5)"), §14.2 "Test harness
  determinism", §15 "DR / DevOps / Observability gate", §23 "Merge waves", §24 "PRE-PILOT gate",
  §28 "4-day execution board". Two older, unrelated PDFs sharing the word "audit"
  (`docs/audits/ROS_MVP_READINESS_AND_REMAINING_WORK.pdf`,
  `docs/audits/ROS_SRS_IMPLEMENTATION_PROGRESS_AUDIT.pdf`, both dated 2026-08-16/21 against a
  much earlier commit) were checked and ruled out — they predate Sales/POS, Payments, KDS and
  Treasury entirely and do not contain §23/§24/§28.

## 2. Exact requirement text (quoted verbatim from the SRS PDF)

> **FR-PLT-013 [M]** — The CI pipeline SHALL execute a cross-tenant isolation test suite that,
> for every table containing tenant_id, attempts to read and write records belonging to Tenant B
> while the session context is Tenant A, and fails the build on any success. This suite is
> generated, not hand-written — it enumerates tables from the information schema so that a newly
> added table without a policy fails the build automatically.

> **FR-PLT-014 [M]** — The CI pipeline SHALL fail if any table with a tenant_id column lacks an
> enabled and forced RLS policy.

> **FR-QA-001 [M]** — The domain layer SHALL be tested exclusively with unit tests requiring no
> database, no HTTP, and no framework.

> **FR-QA-010 [M]** — The System SHALL provide reproducible seed datasets: a minimal
> single-branch café, a 12-branch chain, a multi-brand multi-country group, and a cloud kitchen
> with aggregators.

> **FR-OPS-001 [M]** — Deployments SHALL be zero-downtime and SHALL be rollback-capable within 5
> minutes.

> **FR-OPS-002 [M]** — Canary deployments SHALL automatically roll back on error-rate or latency
> SLO breach without human intervention.

> **NFR-MAINT-004** — Module boundary violations. Target: Zero, enforced in CI.
> **NFR-MAINT-005** — Critical/high vulnerabilities in dependencies. Target: Zero at release.
> **NFR-MAINT-006** — Public API documentation. Target: Generated from code; drift impossible.

> **§28.5 Quality Gates** (merge-blocking): any unit/component test failure; coverage below
> threshold; module boundary violation; lint or type error; critical/high dependency
> vulnerability; secret detected in diff; isolation suite failure; conformance corpus divergence;
> migration exceeding lock budget. (Release-blocking gates — E2E failure, performance regression,
> accessibility regression, CT scenario failure — are explicitly out of `G1-1`'s scope; see §5.)

**FR-OPS-001/002 are deployment-mechanics requirements** (zero-downtime deploy, canary
auto-rollback) and are **explicitly a non-goal of this slice** (task brief §15: "Do not
implement: … deployment"). They were on the read list because P0 §24 (PRE-PILOT gate, rows 13–14)
cites their *current blocking reason* as "No CI — nothing is verified before it ships" — i.e. the
precondition this slice removes — not because `G1-1` implements deployment. See §7 below for the
precise resulting classification.

## 3. P0 findings confirmed (from the traceability-rebase report, §14.2/§15/§23/§24, re-verified
live this session, not merely re-cited)

- **No CI/CD pipeline existed anywhere in the repository** — no `.github` directory, no workflow
  file, no application `Dockerfile`, no Terraform. Confirmed: `find .github` returned nothing
  before this session.
- **64 e2e suites** (`test/*.e2e-spec.ts`) **share one `DATABASE_URL`**; `test/setup-e2e.ts` sets
  only two env vars (`AUTH_THROTTLE_TTL`/`AUTH_THROTTLE_LIMIT`) and performs no database
  isolation. Confirmed by direct read this session.
- `module-boundaries.spec.ts` passes live (**45/45**, re-verified this session) but nothing
  enforced it — it only runs if a human runs `npm test`.
- `npm run openapi:check` exists and passes clean at HEAD, but nothing ran it automatically.
- A fresh scratch database applies all migrations cleanly from zero — re-confirmed this session
  (§6).
- The persistent `ros` database is not required for any of the above and was not touched.

## 4. Pre-existing repository state established before writing CI (all measured live this
session, at HEAD `63d3b7c`, before any change)

| Gate | Command | Result |
|---|---|---|
| Install from lockfile | `npm ci` | Clean, 881 packages, no lockfile drift |
| Prisma validate | `npx prisma validate` | Clean |
| TypeScript typecheck | `npx tsc --noEmit -p tsconfig.json` | **1 pre-existing error**: `src/modules/identity/auth/access-token.service.spec.ts` `TS2322` — `expiresIn` typed `string`, `@nestjs/jwt`'s `JwtSignOptions` (via `jsonwebtoken`'s `ms.StringValue`) expects `ms.StringValue \| number` |
| Unit tests | `npm test` | 815/815 passing, 60/60 suites (includes `module-boundaries.spec.ts`, 45/45) |
| Lint | `npx eslint "{src,apps,libs,test}/**/*.ts"` (no `--fix`) | **48 errors**: 46 pure Prettier formatting drift (verified by diff — whitespace/line-break only, zero semantic change), 2 real: `cash-session-close.service.ts:610` unsafe-member-access on `.decision`, `cash-session-close.e2e-spec.ts:145` `require-await` |
| Dependency vulnerability scan | `npm audit --omit=dev --audit-level=high` | **Exit 1, 6 high-severity**: `@nestjs/swagger`→`js-yaml` (DoS), `prisma`→`@prisma/config`→`deepmerge-ts` (stack exhaustion), `prisma`→`mysql2` (auth-downgrade credential leak, irrelevant to this Postgres-only app but present in the dependency tree). No non-breaking fix available; the only fix path is `prisma@6.19.3`, a major-version bump. |
| OpenAPI drift | `npm run openapi:check` | Clean, no diff |
| Migration from zero | see §6 | Clean |

## 5. What was implemented

**Scope discipline:** this slice is CI/quality gates only — the "commit" stage of SRS §29.2's
CI/CD diagram (`lint · typecheck · format`, `unit tests`, `architecture boundary tests`,
`dependency scan`/`secret scan`). It deliberately does **not** implement §29.2's `component tests
(testcontainers)`, `tenant isolation suite`, `conformance corpus`, `SAST`, container image
build/sign/SBOM, or any PR/merge/release stage — those are either `G1-2`'s job (isolation harness,
this slice's follow-on) or explicit non-goals (deployment, IaC, container images — task brief
§15).

### 5.1 CI platform

GitHub Actions, at `.github/workflows/backend-ci.yml` (repo root — the `origin` remote is
`github.com/OffBrand-org/kitchen-kit-backend.git`). Triggers: `push` to `main`, all
`pull_request`s, and `workflow_dispatch`. `concurrency` cancels a superseded run on the same ref.
All steps run with `defaults.run.working-directory: kitchen-kit/backend` (the backend is nested,
not at repo root). Node 22 (matches this environment's `node -v`), `npm` cache keyed on
`package-lock.json`.

Two jobs:

**`quality`** (single Ubuntu runner, no services needed):
1. checkout
2. `npm ci` — install from lockfile
3. `npm run prisma:generate`
4. `npm run prisma:validate`
5. `npm run typecheck` (new script, §5.3) — real, clean at HEAD after the fix in §5.2
6. `npm run lint:check` (new script, §5.3, no `--fix`) — real, **currently fails** (§4); not
   weakened
7. `npm test -- --ci` — unit suite, includes `module-boundaries.spec.ts`
8. `npx jest module-boundaries.spec.ts --ci` — the same architecture test run again in isolation
   so SRS §5.2.3/§5.4's module-boundary gate has its own named, independently-inspectable CI
   result (it is not a second, different check — `module-boundaries.spec.ts` already matches the
   unit suite's `.spec.ts` pattern and runs as part of step 7 too)
9. `npm run openapi:check`
10. `npm audit --omit=dev --audit-level=high` — real, **currently fails** (§4); not weakened
11. `bash ./scripts/ci/secret-scan.sh` (new, §5.4)

**`migrate-from-zero`** (separate job, `postgres:16` service container):
1. checkout, `npm ci`
2. provision the `ros_app` role (mirrors `docker/postgres/init/01-init-app-role.sh`'s SQL exactly
   — `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, `GRANT CONNECT`) via `psql`, since GitHub
   Actions service containers start before checkout and cannot mount the repo's own init-script
   directory as `docker-entrypoint-initdb.d`
3. `npx prisma migrate deploy` against the freshly-created, empty `ros_ci` database
4. `npx prisma migrate status` to assert a clean, fully-applied state

The `postgres:16` service's `POSTGRES_PASSWORD`/`ros_app` password in the workflow YAML
(`ci_ephemeral_not_a_secret`) is an ephemeral, CI-local, non-production credential with no
external validity — not a "runtime secret" in the sense the task brief prohibits committing.

**Not yet wired**: E2E execution and the tenant/RLS-isolation suites
(`*-rls.e2e-spec.ts`, `tenant.e2e-spec.ts`, `tenant-context.e2e-spec.ts`, `rbac.e2e-spec.ts`).
These require the isolated-database harness this slice explicitly precedes. Task brief §7: "Do
not claim checks requiring G1-2 are deterministic until G1-2 lands." §13: the E2E job is added to
this same workflow file in `G1-2`'s own commit.

### 5.2 The one typecheck fix

`src/modules/identity/auth/access-token.service.spec.ts` — a test-only helper's `expiresIn?:
string` parameter is passed into `new JwtService({ signOptions: { expiresIn } })`; `@nestjs/jwt`'s
`JwtSignOptions` types `expiresIn` as `ms.StringValue | number` (via `jsonwebtoken`), and a bare
`string` is not assignable to `ms.StringValue`. Fixed by importing `type { StringValue } from
'ms'` (already a transitive dependency, v2.1.3, present in `node_modules`) and typing the
parameter `expiresIn?: StringValue`. Test-only, zero runtime behavior change, authorized
explicitly by the task brief ("if trivial, semantically safe, and necessary for CI to enforce
clean typecheck") and independently corroborated by P0 §29 note 6 ("Fix in `G1-1` so CI can gate
on a clean typecheck").

### 5.3 New `package.json` scripts

```
"lint:check": "eslint \"{src,apps,libs,test}/**/*.ts\"",
"typecheck": "tsc --noEmit -p tsconfig.json"
```

`lint` (existing) runs `--fix` and is for local development; CI must never mutate the checkout, so
`lint:check` (no `--fix`) is the CI-facing script. `typecheck` did not previously exist as a
script (only ad hoc `npx tsc --noEmit -p tsconfig.json`); it now does, for both CI and local
parity. Neither script's behavior differs from running the underlying tool directly — they exist
only for a stable, documented, CI-invocable name.

### 5.4 New file: `scripts/ci/secret-scan.sh`

Minimal, dependency-free (git + grep only, no third-party Action) heuristic secret scan of the
tracked tree, run as the last `quality` step:
1. Fails if any tracked dotenv file exists other than `.env.example` (this repo's actual secret
   model is `.env`, gitignored, with a checked-in placeholder template — see
   `.env.example`/`docker-compose.yml`; a tracked real `.env` would be the direct failure mode).
2. Fails if any tracked file matches a classic hard-coded-secret shape (PEM private key header,
   AWS access key ID, GitHub/Slack/Stripe token prefixes).
Verified clean at HEAD (exit 0) this session. This is a heuristic net, not a substitute for a
dedicated secret-scanning service (e.g. GitHub secret scanning / a Gitleaks integration) — stated
as a known limitation, not a hidden gap.

### 5.5 Local emulation of every CI gate

Every step above is runnable locally, unchanged, with the exact commands the workflow uses (`npm
ci`, `npm run prisma:generate`/`prisma:validate`/`typecheck`/`lint:check`, `npm test -- --ci`,
`npx jest module-boundaries.spec.ts --ci`, `npm run openapi:check`, `npm audit --omit=dev
--audit-level=high`, `bash ./scripts/ci/secret-scan.sh`). The `migrate-from-zero` job's SQL and
`prisma migrate deploy`/`status` sequence was manually dry-run this session against a disposable
scratch database on the shared lane-instance (created, migrated, dropped; see §6) to prove the
logic before committing it into YAML that cannot be executed in this environment (no `docker
compose` service-container equivalent available here; GitHub's own runner is required to execute
the workflow itself).

## 6. Migration-from-zero — dry run evidence

Reused the running shared Postgres instance (`localhost:5544`, the same instance
`docker-compose.yml`/`.env` in this worktree already point at — see §8) rather than starting a
new container, since host port 5544 is already bound by the long-running `ros-postgres` container
shared across all lane worktrees. Created a disposable database (`ros_ci_dryrun_<random>`,
matching the safe scratch-name pattern `ros_(test|ci|lane)_...`), ran `prisma migrate deploy`
against it as `ros_migrator`, then `prisma migrate status`:

```
35 migrations found in prisma/migrations
Database schema is up to date!
```

then dropped the scratch database, gated by the same fail-closed name check used for the
create/drop calls (§10 of the task brief; this is the pattern `G1-2` formalizes into a shared,
tested guard — see the forthcoming `G1-2` report). Confirmed: `ros` and `ros_lane_g` (this lane's
own persistent dev database) were never touched by this dry run.

## 7. Requirement/gate status after this slice

| ID | Before | After `G1-1` | Note |
|---|---|---|---|
| `FR-PLT-013`/`FR-PLT-014` | NOT IMPLEMENTED (P0 §14.1) | **Still not implemented** | These require the isolation suite itself to be schema-generated and CI-run; `G1-1` provides the pipeline to run it in, not the suite. Unchanged by this slice — correctly deferred; `catalogue-rls`/`inventory-rls`/etc. suites exist but are hand-written, and running them needs `G1-2`'s isolated DB. |
| `NFR-MAINT-004` (module boundary, enforced in CI) | PARTIAL — passes but unenforced | **Enforced** — real CI step, currently green (45/45) | |
| `NFR-MAINT-005` (zero critical/high vulns) | NOT IMPLEMENTED — no scanning | **Scanning enforced; target not met** — real CI step, currently **red** (6 pre-existing high-severity, §4) | Honest gate, not a fake pass. Fixing the vulnerabilities (a `prisma` major-version bump) is out of this slice's scope — it is a dependency-upgrade decision with its own blast radius, not CI infrastructure. |
| `NFR-MAINT-006` (API docs generated, drift impossible) | PARTIAL — generated, but nothing ran it | **Enforced** — real CI step, currently green | |
| `FR-QA-001` | COMPLETE (already) | Unchanged — **now additionally gated** in CI | |
| `FR-OPS-001`/`FR-OPS-002` | NOT IMPLEMENTED | **Still not implemented** (deployment mechanics — explicit non-goal) | P0 §24's cited blocking *reason* for these two rows ("No CI — nothing is verified before it ships") is resolved by this slice; their actual substance (zero-downtime deploy, canary auto-rollback) remains entirely unbuilt and is correctly out of scope here. |
| §28.5 quality gates | 0 of 9 merge-blocking gates enforced (P0 §13.2) | **6 of 9 enforced** (unit/component-test failure, module boundary violation, lint/type error, critical/high dependency vulnerability, secret detected in diff — component-test and migration-lock-budget gates not yet applicable/built; isolation-suite-failure gate deferred to `G1-2`) | Two of the six enforced gates (lint, dependency vulnerability) are currently **red** at HEAD — accurately, not falsely, reported. |
| Pre-pilot gate rows 10–15 (P0 §24, all attributed to `G1-1`) | 6 blockers | Rows 13/14 (`FR-OPS-001/002`, "no CI") resolved; rows 10/11/12 (`FR-PLT-013/014`, `CT-05`) unresolved (need the isolation suite itself, not this slice); row 15 (`NFR-MAINT-004`) resolved | |

## 8. Environment notes

- All lane worktrees share one running Postgres container (`ros-postgres`, started from the main
  checkout's `docker-compose.yml`, `localhost:5544`) rather than each running its own — a second
  `docker compose up -d db` from this worktree would fail to bind the same host port. This
  worktree's own `.env` already configures `DATABASE_URL`/`APP_DATABASE_URL` against a
  lane-specific database name (`ros_lane_g`), not `ros` — satisfying "use a Lane-G database, never
  `ros`" without any change needed here. `G1-2`'s harness (next report) builds scratch databases
  within this same shared instance, never touching `ros` or `ros_lane_g`.
- No new runtime secrets were committed. The CI workflow's Postgres service password is an
  ephemeral CI-only value (§5.1).

## 9. Verification executed this session (commands and results, all live, none re-cited from an
older report)

| Check | Result |
|---|---|
| `git status` at start | clean, HEAD `63d3b7c2ea5f999bb9ba7277d51a5da3c6950a71`, branch `full-srs/lane-g-prod-reporting-dr` |
| `npm ci` | clean install, 881 packages |
| `npx prisma validate` | valid |
| `npm run typecheck` | clean (0 errors) after the one fix in §5.2 |
| `npm test` | 815/815, 60/60 suites |
| `npx jest module-boundaries.spec.ts` | 45/45 |
| `npm run openapi:check` | clean, no diff |
| `npx eslint … ` (no fix) | 48 pre-existing errors, unchanged by this slice (see §4, §7) |
| `npm audit --omit=dev --audit-level=high` | exit 1, 6 pre-existing high-severity, unchanged by this slice |
| `bash scripts/ci/secret-scan.sh` | clean, exit 0 |
| migration-from-zero dry run | 35/35 migrations applied clean to a fresh disposable DB, then dropped |
| `git diff --check` | clean (checked before commit) |

## 10. Known limitations (stated explicitly, not hidden)

1. **Lint is a real, currently-failing gate.** 46 of 48 errors are pure pre-existing Prettier
   formatting drift (verified: whitespace/line-break only, zero semantic change, across files this
   slice does not otherwise touch); 2 are real (`cash-session-close.service.ts:610` unsafe-any,
   `cash-session-close.e2e-spec.ts:145` missing-await). None were fixed here: the task brief
   authorizes fixing only the one *typecheck* issue if trivial, not lint debt across
   unrelated business/test files, and `cash-session-close.service.ts` is Treasury business logic
   this task must not modify. This is pre-existing debt, accurately surfaced, not introduced by
   this slice.
2. **Dependency vulnerability scanning is a real, currently-failing gate.** 6 pre-existing
   high-severity findings, all requiring a `prisma` major-version bump (6.19.3) to resolve via
   `npm audit fix --force` — a breaking dependency-version change out of this slice's scope (task
   brief: "DO NOT CHANGE DOMAIN SCHEMA/MIGRATIONS…", and a Prisma major bump is exactly the kind of
   change that needs its own review, not a side effect of adding CI).
3. **No component-test (testcontainers), tenant-isolation-suite, or E2E job yet.** All three need
   `G1-2`'s isolated database harness; wiring them prematurely against the shared `DATABASE_URL`
   would reproduce the exact 100-failure class P0 §14.2 documents. Added in `G1-2`'s own commit,
   to this same workflow file.
4. **Secret scanning is a heuristic, not a dedicated scanning service.** Documented in §5.4, not
   claimed as equivalent to (e.g.) GitHub Advanced Security secret scanning.
5. **No coverage threshold gate** (`NFR-MAINT-001/002` name ≥90%/≥75% targets); coverage is not
   measured in CI. Out of this slice's minimum-credible-pipeline scope; flagged for a future
   slice, not silently dropped.
6. A background research agent used earlier in this session made an unauthorized edit (the exact
   §5.2 typecheck fix) before being asked to stop; it was reviewed, verified correct via a clean
   `tsc --noEmit`, and kept as this slice's authorized typecheck fix. The same agent run also
   produced a substantial, unreviewed early draft of `G1-2`'s isolation harness before being
   killed mid-task (background-task status `killed`); that draft was moved out of this commit's
   working tree in full before verification and will be reviewed on its own merits — kept,
   rewritten, or discarded — in the `G1-2` slice, not folded silently into this one.

---

*End of G1-1 report. See `docs/reports/claude/full-srs-4day/2026-09-02_G1-2_deterministic-e2e-harness.md`
for the follow-on slice.*
