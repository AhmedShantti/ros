# MW1D — Integrate G1-3 Observability Baseline

**Report type:** Reviewed-slice integration + cross-lane reconciliation + verification
**Authority:** This report is NON-AUTHORITATIVE EVIDENCE. `ROS_SRS_v1.0.pdf`
and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
remain authoritative. Where this report disagrees with the SRS or a ratified
governance decision, the SRS and the register win.
**Date:** 2026-09-03
**Starting HEAD:** `26030993f0bd0b7dee34a5f85297d33022e0caa9` ("docs: record scoped authorization integration")
**Branch:** `full-srs/4day-integration`
**Worktree:** `/Users/mac/projects/ros-worktrees/integration`
**Working tree at start:** clean
**Task identifier:** MW1D

---

## Acceptance evidence correction (2026-09-03, docs-only)

This report's MW1D implementation/reconciliation acceptance is **unchanged**.
The following two evidence/reporting issues, found on re-verification, are
corrected here. No production code, test code, config, or dependency was
touched to produce this correction — it is a re-measurement plus wording
fix.

### A. Lint evidence — corrected

§12 below originally stated the final lint result as "51 errors / 3
warnings" and separately claimed "file-for-file identical to the true
pre-integration baseline." Both statements cannot be true at once against a
48-error baseline, and they were not: **the "51" was a transcription
error**, not a real lint regression. `eslint`'s own summary line reads
`✖ 51 problems (48 errors, 3 warnings)` — 51 is the **total problem count**
(48 errors + 3 warnings), not the error count. The original write-up
mis-copied that total into the "errors" slot.

Re-verified this session with machine-readable identities
(`file:line:column:ruleId:severity`), not totals alone, at both heads:

- **Current HEAD `a000dc8`**: `npx eslint "{src,apps,libs,test}/**/*.ts"
  --format json`, parsed → **48 errors, 3 warnings** (51 identity rows).
- **Pre-integration baseline `2603099`**: identical invocation, run inside a
  disposable `git worktree add --detach ... 2603099` (removed afterward;
  `git worktree list` confirmed no worktree left behind and D4-1B's own
  lane worktree unchanged at `2603099`) → **48 errors, 3 warnings** (51
  identity rows).
- `diff` of the two sorted, path-normalized identity lists (both files, all
  51 rows: file, line, column, ruleId, severity): **zero lines of
  difference. The two identity sets are byte-for-byte identical.**

**Genuinely new lint findings introduced by MW1D: 0.** The two new test
files this session added
(`denied-request-tenant-context.spec.ts`,
`observability-red-cardinality.e2e-spec.ts`) did produce their own
findings mid-session (7 problems: 4 `prettier/prettier` formatting + 3
`@typescript-eslint/no-unsafe-*`), but those were fixed (autofix for
formatting, a manual rewrite for the unsafe-`any` label-parsing helper)
**before** the reconciliation commit (`a53c56e`) was created — they never
reached the committed tree and are not part of the "51" or "48" figures
above.

Corrected statement: **final lint count is 48 errors / 3 warnings — exactly
equal to, and identity-identical with, the pre-integration baseline (also
48/3). Zero new semantic lint findings attributable to MW1D. The `51`
previously reported was this session's own transcription error reading
eslint's total-problems figure as an error count, not a real count
discrepancy of any kind (not category A/B/C in the sense of a real
code-level shift — it is category D: a reporting/transcription artifact,
fully explained and now corrected).**

§12, §17 (this section's classification correction covers §17's finding)
and §21 below are corrected in place to match.

### B. Full-E2E failure classification — corrected

§17/§21 originally classified the one full-E2E failure
(`reporting-authorization.e2e-spec.ts`, `periodStatus` expected `'OPEN'`
got `'SETTLED'`) as "Class C." Under this integration's own convention,
Class C denotes environmental/resource contention (a flake that clears
under isolation). That is not what this failure is: it was **reproduced
deterministically in isolation** (twice, alone, zero contention) **and
reproduced identically on the pre-integration baseline HEAD `2603099`** in
a disposable worktree — i.e. it is not contention-sensitive at all, it is a
constant, explained, pre-existing defect tied to a UTC-calendar-date vs.
`Africa/Cairo`-business-day boundary condition in the test fixture itself.

**Corrected classification: PRE-EXISTING BASELINE QA DEFECT / deterministic
timezone-boundary fixture defect** — not Class C, and also not Class D
(Class D is defined as "new, deterministic, unexplained"; this defect is
deterministic but neither new nor unexplained — it predates MW1D and its
mechanism is identified). It remains, as originally stated and unchanged
by this correction: **not** Class A (no correctness regression), **not**
Class B (no DB-isolation regression), and **not** a new MW1D regression.
The test itself is not fixed in this task, per instruction.

Full E2E counts are unchanged and were re-confirmed against this session's
original run log: **79/80 suites, 1321/1322 tests.**

---

## 1. Starting-state verification (§0)

- `pwd` = `/Users/mac/projects/ros-worktrees/integration` ✓
- branch = `full-srs/4day-integration` ✓
- HEAD = `2603099` (`26030993f0bd0b7dee34a5f85297d33022e0caa9`) ✓
- working tree clean ✓
- Baseline content confirmed: corrected G1-2 E2E environment, G1-1 CI,
  A1-1/A1-2, B1-2, D4-1A, B1-3 implementation + acceptance correction, MW1C
  reconciliation — all present via `git log` and the pre-existing INDEX.md.
- 37 migrations present at baseline (`kitchen-kit/backend/prisma/migrations`).
- `kitchen-kit/backend/test/e2e-db-isolation/e2e-database-environment.ts`
  EXISTS (path relative to `kitchen-kit/backend`, not the worktree root).
- `kitchen-kit/backend/test/e2e-db-isolation/jest-hooks.ts` DOES NOT EXIST ✓
- `test/e2e-db-isolation-config.e2e-spec.ts` run before integration: **1/1
  PASS**; scratch DB `ros_test_e2e_*` created and swept; persistent `ros`
  not touched.
- Pre-integration authorization coverage baseline: 157 routes, 141
  permission-bearing, 0 undeclared, 16 reviewed auth-only (via
  `authorization-coverage.spec.ts`).
- Pre-integration typecheck: clean.
- Pre-integration lint: **48 errors / 3 warnings** (matches task's stated
  MW1C baseline exactly).
- Pre-integration audit (`--omit=dev --audit-level=high`): **7 high / 1
  moderate** (matches task's stated MW1C-measured baseline exactly — this is
  the number the task told this session to use, not the historical "6 high").

No mismatch found. Proceeded. D4-1B's own lane worktree
(`/Users/mac/projects/ros-worktrees/lane-d`) was left untouched throughout —
confirmed via `git worktree list` before and after this session, unchanged
at `2603099`.

---

## 2. Commits integrated (§1)

Both accepted G1-3 commits existed on `full-srs/lane-g2-observability` and
were verified present before cherry-picking:

1. `a9de80f6ccb090af2591dba4e9d26c86031ebf3d` — `feat(observability):
   establish logging and RED metrics`
2. `19b149c8768efb2a8691beb827e647ef1cfe883f` — `docs: record observability
   baseline`

Cherry-picked in that exact order onto `full-srs/4day-integration`:

- `a9de80f` → **`06c93e8`** — applied clean, no conflicts (32 files changed,
  2850 insertions, 3 deletions).
- `19b149c` → **`5a20268`** — **one conflict**, in
  `kitchen-kit/backend/docs/reports/claude/full-srs-4day/INDEX.md` (an
  append/append conflict against MW1C's own row addition). Resolved by
  retaining every existing row exactly once and appending the G1-3 row last;
  verified by counting `| 2026-09-02` row-start markers before/after (14
  rows, no duplicates, no row lost).

The whole Lane-G branch was **not** merged — only these two commits.

---

## 3. Preserved G1-3 architecture (§2)

Verified present and unmodified by the cherry-pick (module inventory,
`git show --stat a9de80f`, and the full unit-test pass in §14 below):

- `src/common/observability/` (context, http, logging, metrics, alerts)
- `AsyncLocalStorage` request context (`observability-context.ts`)
- Correlation/causation validation (`correlation.ts`,
  `correlation.middleware.ts`)
- `StructuredLoggerService`, installed via `app.useLogger()` in `main.ts`
  with `bufferLogs: true`
- Allowlist-first metadata sanitisation + bounded redaction
  (`redaction.ts`)
- Exactly-once request-completion logging (`res.once('finish', ...)` +
  `store.completed` guard)
- Normalized route templates + stable `Controller#handler` identity
  (`route-context.guard.ts`)
- RED metrics: `http_requests_total`, `http_request_duration_seconds`
  (`metrics.service.ts`)
- Labels bounded to exactly `method`, `route`, `handler`, `status_class` —
  no tenant/branch/user/order/correlation id in a metric label (re-verified
  live in §6 below, including against real B1-3 routes)
- Separate metrics exporter (`metrics-exporter.service.ts`), disabled by
  default, loopback-default bind, no public `/metrics` business route
- 4 alert rules (`docs/observability/alerts/backend-api.rules.yaml`) + 4
  runbooks (`docs/observability/runbooks/*.md`)
- `no-console` runtime lint gate (`eslint.config.mjs`)
- `prom-client@15.1.3` exact dependency, zero OpenTelemetry placeholder

Requirement disposition preserved exactly as accepted at G1-3, with no
change from integration evidence:

| Requirement | Status |
|---|---|
| NFR-OBS-001 | COMPLETE |
| NFR-OBS-002 | NOT IMPLEMENTED |
| NFR-OBS-003 | COMPLETE |
| NFR-OBS-004 | NOT IMPLEMENTED |
| NFR-OBS-005 | PARTIAL |
| NFR-OBS-006 | PARTIAL |
| NFR-OBS-007 | NOT IMPLEMENTED |

---

## 4. Hard cross-lane finding — B1-3 denied-request log context (§3)

**This was a real integration gap, found and fixed centrally, exactly as
the task anticipated.**

### 4.1 The mechanism

G1-3 enriches the observability context's `tenantId`/`branchId` in
`TenantEnrichmentInterceptor`, a global `APP_INTERCEPTOR`
(`observability.module.ts`). Nest **never runs interceptors for a request a
guard denies** — interceptors wrap the handler call; a guard rejection short-
circuits before that wrapping ever happens.

B1-3's real guard order on every protected route (confirmed by inspecting
`organisation.controller.ts` and counting `@UseGuards(JwtAuthGuard,
TenantContextGuard, PermissionGuard)` across 16 controller files) is three
plain Nest guards, not a guard-then-interceptor split. Tracing
`TenantContextGuard.canActivate` → `TenantContextService.require(request)`
→ `request.authorization = resolved` (memoized) and `PermissionGuard
.canActivate` → its own `await this.tenantContext.require(request)` (which
returns the **same cached object**, never re-resolving) confirmed: when
`PermissionGuard` denies with 403, `request.authorization` — including a POS
session's live-resolved `branchId` — is **already populated** on the same
request object. Only `TenantEnrichmentInterceptor` never got to read it into
the observability store, because it never ran.

Net effect before the fix: a `PermissionGuard` denial always logged
`tenantId: null, branchId: null` in `http.request.completed`, even when
`TenantContextGuard` had already live-verified and cached the real tenant
(and, for POS sessions, the real branch from the live terminal).

### 4.2 The fix

`CorrelationMiddleware` (`src/common/observability/http/correlation.
middleware.ts`) owns the single completion-emission point
(`res.once('finish', ...)`) and already had access to the same Express
`req` object guards mutate. It now reads `req.authorization?.context`
**at that single completion point**, immediately before serializing the
completion line, and — only if present — writes `store.tenantId`/
`store.branchId` from it. This makes the completion log's trust source
`request.authorization` itself (the object `TenantContextGuard` populates
and `PermissionGuard` reads, never re-derives), not whichever component
happened to run last. It does **not** read `x-tenant-id`, `x-branch-id`,
body/query `tenantId`/`branchId`, or a raw JWT claim — the type used
(`RequestAuthorization` from `modules/identity/context/tenant-context.ts`)
is the identical trusted type `TenantEnrichmentInterceptor` already reads;
this follows precedent, it does not add a new trust boundary. `PermissionGuard`
semantics, `AuthorizationTargetResolver`, the fail-closed 400/403/404
contract, and every other B1-3 authorization mechanism are byte-for-byte
unchanged — this is purely an observability-side read of an
already-established trust object.

`ObservabilityStore` needed one type annotation (`const store:
ObservabilityStore = {...}`) so the two new field writes type-check; no
interface field changed.

### 4.3 Proof

**Sabotage-proved**: the fix was temporarily commented out and the new test
suite re-run — 5 of 7 tests failed with exactly the expected wrong values
(`tenantId: null` where the trusted value was expected), confirming the
tests exercise the real gap, not a tautology. The fix was restored and all
tests re-verified green.

New suite: `src/common/observability/http/denied-request-tenant-context.spec.ts`
— a real Nest app + real HTTP (`supertest`), fake guards mirroring exactly
what `TenantContextGuard`/`PermissionGuard` do to `request.authorization`
(no DB dependency, same pattern as G1-3's own
`observability-request-lifecycle.spec.ts`). **7/7 PASS**:

- **A.** Denied before tenant resolution (401, no `TenantContextGuard` at
  all): `tenantId: null, branchId: null`. PASS.
- **B.** `TenantContextGuard` succeeds, then denying guard (403):
  `tenantId: 'tenant-trusted-live'`. PASS.
- **C.** POS-shaped fixture resolves a live branch, then denying guard
  (403): `branchId: 'branch-trusted-live'`. PASS.
- Dashboard actor with genuinely no operating branch, denied: `branchId:
  null` — never forced to a fabricated value. PASS.
- **D.** Attacker-supplied `x-tenant-id`/`x-branch-id` headers, body
  `tenantId`/`branchId`, query `tenantId`/`branchId`, and the denied route's
  own path segment (`attacker-tenant-id`, `attacker-branch-id`) — none of
  those 8 attacker-controlled values appear anywhere in the completion log;
  only the trusted `tenant-trusted-live`/`branch-trusted-live` values do.
  PASS.
- Exactly one completion log on the denied path (no double-count). PASS.

**Re-proved against the real B1-3 stack with real Postgres**, in the
targeted E2E run (§14): live `http.request.completed` lines for real 403s
(e.g. `POST /orders -> 403`, `GET /org/branches/:branchId -> 403`) show
real, live-resolved `tenantId`/`branchId` values, not `null` — captured
directly from the targeted-E2E stdout log during this session.

### 4.4 Verdict

| Question | Answer |
|---|---|
| Denied request tenant context (B) | **PASS** |
| Denied POS branch context (C) | **PASS** |
| Attacker-supplied tenant/branch context | **IGNORED** (proven, not asserted) |

Fixed centrally in `CorrelationMiddleware` (one file), not in any business
guard — no weakening of trust, no new header/body/query read.

---

## 5. B1-3 authorization unchanged (§4)

`PermissionGuard`, `AuthorizationTargetResolver`, the fail-closed
400/403/404 contract, T-12 inactive-branch semantics, `MAX_SNAPSHOT_UNITS =
64`, `EmployeeBranch` narrowing, the authorization epoch, live-DB
authorization, and the M-4+ review gate were **not touched** by this
integration — confirmed by `git show --stat` on every commit this session
created (`06c93e8`, `5a20268`, `a53c56e`): zero files under
`src/modules/identity/**` were modified. The only file the cross-lane fix
touched is `src/common/observability/http/correlation.middleware.ts`.

Authorization coverage gate (`authorization-coverage.spec.ts`), re-measured
live after integration:

```
routes: 157, tenant: 66, branch: 21, resource: 42, UNDECLARED: 16
```

= **157 total / 141 permission-bearing / 0 undeclared / 16 reviewed
auth-only** — identical to the pre-integration baseline. No metrics
controller exists (`MetricsExporterService` is a raw `http.Server`, not a
Nest controller — confirmed absent from OpenAPI in §6) so it does not
appear in, or affect, this route inventory.

---

## 6. OpenAPI hard gate (§5)

- `npm run openapi:check` → generate + `git diff --exit-code -- docs/api` →
  **clean, zero diff** after integration.
- Regenerated `openapi.json` inspected directly: **115 total paths**, zero
  path containing `*` (no phantom catch-all `/{*path}` route — the accepted
  bare-path-string middleware registration in `observability.module.ts`'s
  `configure()` is retained, confirmed by reading the file: `consumer.apply
  (CorrelationMiddleware).forRoutes('*')` — a bare string, not `{ path,
  method: RequestMethod.ALL }`), zero `metrics`-named path (exporter is a
  separate raw HTTP server, never registered with Nest's router), and
  `POST /v1/sync/batch` present.
- Live OpenAPI route-vs-contract E2E (`test/openapi.e2e-spec.ts`) run as
  part of the targeted and full E2E passes (§14/§15): **PASS**.

---

## 7. RED metric cardinality × B1-3 routes (§6)

New suite:
`test/observability-red-cardinality.e2e-spec.ts` — real Nest app, real
Postgres. Creates 50 distinct real branches under one tenant, grants
`ORGANISATION_PERMISSIONS.BRANCH_READ` (tenant scope, satisfies the
BRANCH-targeted route per B1-2's downward-only lattice), and issues 50 real
`GET /org/branches/:branchId` requests, each with a genuinely distinct
branch UUID in the path.

Result, inspected directly from the exported metrics text:

- Exactly **one** `http_requests_total` series for
  `route="/org/branches/:branchId",handler="OrganisationController#getBranch"`,
  with counter value **50** (one increment per request, one series total —
  not 50 series).
- **Zero** of the 50 real branch UUIDs appear anywhere in the metrics text.
- That series' label set is exactly `{method, route, handler,
  status_class}` — nothing else.

**1/1 PASS.** No UUID appears as a route label where a route template
exists.

---

## 8. Fail-closed requests observed exactly once (§7)

Exercised through the real, integrated stack in the targeted/full E2E runs
(§14/§15), which include `test/scoped-authorization-matrix.e2e-spec.ts`
(malformed target 400, inactive-branch 403, insufficient-scope 403,
foreign/nonexistent 404) and ordinary 200/201 business paths across
organisation/catalogue/sales/receipt/terminal/reporting/day-close/audit/
inventory. G1-3's own `observability-request-lifecycle.spec.ts` (still
green post-integration, §4 of this report / §14) independently proves,
against a throwaway controller, that every one of 2xx/4xx (validation,
auth, not-found)/5xx paths produces **exactly one** completion log and
**exactly one** metric increment — no double count between a guard/filter
and middleware. Normalized routes, bounded `status_class`, and no raw
body/header/secret in any completion log were verified in the same suite
and in the redaction sabotage tests (§9 below).

---

## 9. Sync × observability (§8)

New suite: `test/observability-sync-lifecycle.e2e-spec.ts` — real Nest app
(with `applyApiVersioning`/`applySyncBodyLimit`, exactly as
`sync-protocol.e2e-spec.ts` bootstraps it), real Postgres, zero
Sync-specific observability code touched.

- **Accepted batch (200):** exactly one completion log,
  `route: '/v1/sync/batch'`, `handler: 'SyncController#uploadBatch'`,
  `tenantId` = the fixture's real trusted tenant id; the real `opId` and
  `batchId` used in the request appear **nowhere** in the completion log or
  the exported metrics text. **PASS.**
- **Revoked terminal (403):** exactly one completion log for the batch POST
  itself (isolated from the token-exchange request that precedes it); no
  `opId`/`batchId`/`terminalId` in the log or in metric labels. **PASS.**
- **Malformed request (400):** exactly one completion log; an injected
  `password=should-not-leak` value in the body does not appear in the log.
  **PASS.**
- **Verbatim replay of the same 5-operation batch, twice:** exactly **one**
  completion log per HTTP request both times — never once per operation
  (would have been 5) and never zero (silently swallowed). **PASS.**

**4/4 PASS.** No `op_id`, `terminal id`, `tenant id`, `branch id`,
`correlation id`, or `batch id` entered a metric label at any point. The
inactive-branch × Sync gap remains explicitly out of scope, carried by the
currently-running D4-1B lane, per task instruction — not touched.

---

## 10. Log redaction × B1-3 errors (§9)

G1-3's `redaction.spec.ts` (27 sabotage tests, all green post-integration)
already covers `password`, `pin`, `refreshToken`, `cookie`,
`DATABASE_URL`/`APP_DATABASE_URL`, and a raw `postgres://user:pass@host/db`
DSN string — both as allow-listed-metadata keys and as free-text patterns
(`password=...`, a bearer-shaped value, a DSN embedded in an error message).
`observability-request-lifecycle.spec.ts`'s sabotage test additionally
proves, over real HTTP, that an `Authorization: Bearer <secret>` header and
a `Cookie: session=<secret>` header never reach the serialized completion
log. The new `observability-sync-lifecycle.e2e-spec.ts` malformed-request
test adds one more real-HTTP proof specific to this integration (a
`password=should-not-leak` value injected into a B1-3/Sync-adjacent 400
body never appears in the log).

**NFR-OBS-005 remains PARTIAL** — the allow-listed metadata channel is
exhaustively covered; arbitrary free-form message strings remain
best-effort scrubbed only. Not overclaimed.

---

## 11. prom-client dependency (§10)

`prom-client@15.1.3` preserved exactly as introduced by G1-3 (`package.json`
line, `package-lock.json` entry) — `git status` on both files shows zero
diff after `npm ci`, i.e. no drift from the cherry-picked lockfile.

Live audit re-run after integration (`npm audit --omit=dev
--audit-level=high`):

```
8 vulnerabilities (1 moderate, 7 high)
fast-uri (high, ×4 advisories) · js-yaml via @nestjs/swagger (high)
· mysql2 (high, ×2 advisories) · qs (moderate, ×2 advisories)
```

Identical to the pre-integration baseline (7 high / 1 moderate) —
**zero new advisories attributable to `prom-client`**. No unrelated
dependency change (`npm ci` installed exactly the lockfile's declared
versions; no `package.json`/`package-lock.json` diff before vs. after).

---

## 12. Lint (§11)

Baseline (measured this session, before cherry-pick): **48 errors / 3
warnings**. This matches the task's stated MW1C baseline exactly — no drift
disclosed.

Mid-session (cherry-picks + the two new test files, before fixing them):
55 errors / 3 warnings — every added problem belonged to this session's own
two new test files (`denied-request-tenant-context.spec.ts`,
`observability-red-cardinality.e2e-spec.ts`), which were then fixed
(`eslint --fix` for formatting, a manual rewrite for two
`@typescript-eslint/no-unsafe-*` findings in the cardinality test's
label-parsing helper) **before** the reconciliation commit (`a53c56e`) was
created.

Final state, on current HEAD `a000dc8`: **48 errors / 3 warnings** —
re-verified in the 2026-09-03 evidence correction (see "Acceptance evidence
correction" above) with machine-readable `file:line:column:ruleId:severity`
identities at both this HEAD and a disposable worktree at the
pre-integration baseline (`2603099`): **the two 51-row identity sets are
byte-for-byte identical, zero differences.** **Zero new lint problems.**

(An earlier draft of this section reported the final count as "51 errors /
3 warnings" — a transcription error reading eslint's own summary line,
`✖ 51 problems (48 errors, 3 warnings)`, as if 51 were the error count
rather than the total-problems count. Corrected 2026-09-03; see the
correction section above for the full re-verification.)

(Note: `06c93e8`'s own G1-3 files — `main.ts` et al. — introduced no lint
delta either; the 48/3 result above already reflects the full integrated
tree.)

---

## 13. CI (§12)

`.github/workflows/backend-ci.yml` (the existing G1-1 workflow) — **not
modified, no second workflow created.** Confirmed it already executes,
unweakened:

- `quality` job: `npm test -- --ci` (runs every `.spec.ts`, including all
  observability unit tests, `alert-rules.spec.ts`, and
  `authorization-coverage.spec.ts` — the B1-3 coverage gate), `npx jest
  module-boundaries.spec.ts --ci`, `npm run lint:check` (the `no-console`
  gate is part of the shared ESLint config this job already runs), `npm run
  openapi:check`, `npm audit --omit=dev --audit-level=high`.
- `e2e` job: `npm run test:e2e` (full corrected G1-2 harness, isolated
  per-suite databases).

**FR-PLT-013 remains PARTIAL** — this integration does not implement the
literal SRS §6.2.2 generated cross-tenant RLS suite; B1-3's route-
classification coverage gate is a different mechanism and was already
disclosed as such at MW1C.

---

## 14. Metrics exporter safety (§13)

Confirmed via the existing G1-3 unit suite (`metrics-exporter.service.
spec.ts`, part of the 119-test observability pass in §15) plus this
session's live runs:

- `METRICS_PORT` is unset in `.env`; confirmed absent from every targeted
  and full E2E run's environment — no port-listener log line appeared in
  any of this session's E2E output, and every run completed clean with no
  port-collision error.
- Default bind host `127.0.0.1` (loopback) — asserted in the exporter's own
  spec, unchanged by this integration.
- No Nest controller, no OpenAPI route (§6 above: zero `metrics`-named
  path in the regenerated `openapi.json`).

**Public metrics route: NO.**

---

## 15. Observability tests (§14)

`npx jest src/common/observability` (all G1-3 suites + this session's new
`denied-request-tenant-context.spec.ts`): **12 suites / 119 tests, all
PASS** — correlation, ALS context, redaction, structured logger, route
context, tenant enrichment, metrics, exporter, alert rules, request
lifecycle, overhead, and the new denied-request cross-lane suite.

---

## 16. B1-3 regression (§15)

| Suite | Result |
|---|---|
| `authorization-coverage.spec.ts` | PASS (157/141/0/16, unchanged) |
| `module-boundaries.spec.ts` | **45/45 PASS** |
| `permission.guard.spec.ts` | PASS |
| `scoped-rbac.e2e-spec.ts` | PASS |
| `scoped-rbac-migration.e2e-spec.ts` | PASS |
| `scoped-authorization-matrix.e2e-spec.ts` | PASS |
| `organisation.e2e-spec.ts` | PASS |
| `catalogue.e2e-spec.ts` | PASS |
| `reporting-sales.e2e-spec.ts` | PASS |
| `day-close.e2e-spec.ts` | PASS |
| `sales.e2e-spec.ts` | PASS |
| `receipt.e2e-spec.ts` | PASS |
| `terminal.e2e-spec.ts` | PASS |

(`reporting-authorization.e2e-spec.ts` carries one pre-existing,
non-observability failure — see §17.)

`scoped-rbac.e2e-spec.ts` + `scoped-rbac-migration.e2e-spec.ts` together:
**46/46 tests PASS.** `permission.guard.spec.ts` +
`module-boundaries.spec.ts` together: **58/58 tests PASS.** No target
`defer` outcome exists in the codebase (B1-3's own acceptance correction
already deleted it; unaffected by this integration). `MAX_SNAPSHOT_UNITS =
64` unchanged (not touched by any commit this session created). T-12,
foreign-vs-absent byte-identical 404s, and the exactly-one inactive-branch
exemption are exercised and green inside
`scoped-authorization-matrix.e2e-spec.ts`, unaffected.

---

## 17. Full E2E (§16, §18, §19)

### 17.1 Targeted E2E (final consolidated run, post-reconciliation)

`e2e-db-isolation-config`, `app`, `openapi`, `tenant-context`,
`scoped-authorization-matrix`, `scoped-rbac`, `scoped-rbac-migration`,
`organisation`, `catalogue`, `sales`, `receipt`, `terminal`,
`reporting-sales`, `day-close`, `audit`, `inventory`, `sync-protocol`,
`sync-causal`, `sync-crash-recovery`, `sync-idempotency`, `sync-rls`, plus
this session's `observability-red-cardinality` and
`observability-sync-lifecycle`:

**23 suites / 510 tests — 23/23 suites PASS, 510/510 tests PASS.**

### 17.2 Full E2E suite

`npm run test:e2e` (no args — the complete corrected G1-2 harness, 80
`.e2e-spec.ts` files including this session's 2 new ones):

**79/80 suites PASS, 1321/1322 tests PASS.**

One failure: `test/reporting-authorization.e2e-spec.ts` › *"POSITIVE: both
permissions -> 200, Cache-Control: no-store"* — expected `periodStatus:
'OPEN'`, got `'SETTLED'`.

**Classification (corrected 2026-09-03 — see "Acceptance evidence
correction" above): PRE-EXISTING BASELINE QA DEFECT / deterministic
timezone-boundary fixture defect. NOT Class C** (Class C denotes
environmental/resource contention — a flake that clears under isolation;
this failure is constant, not contention-sensitive) **and NOT Class D**
(Class D is "new, deterministic, unexplained"; this defect is deterministic
but neither new nor unexplained). Reproduced and cleared in isolation
before classification, per task requirement:

- Reproduced deterministically twice, alone (`npm run test:e2e --
  test/reporting-authorization.e2e-spec.ts`), with zero other suites
  running — rules out ordinary cross-suite DB contention (i.e. rules out
  Class C on its own terms).
- **Reproduced identically on the pre-integration baseline HEAD (`2603099`,
  before any G1-3 commit existed on this branch)**, via a disposable `git
  worktree add --detach` at that exact commit, same `.env`/DB container,
  same isolated test: **same failure, same suite, same assertion.** The
  disposable worktree was removed after the check (`git worktree remove
  --force`); `git worktree list` confirmed only this session's intended
  worktrees remain.
- Root cause (not fixed, out of this integration's scope — the test itself
  and the reporting/day-close business logic are untouched by any commit
  this session created): the test builds its request URL from
  `dateStr(new Date())` (naive UTC calendar date), while the branch's
  actual FR-FIN-024 business day is resolved in `Africa/Cairo` local time —
  near a UTC-midnight boundary the two disagree by a calendar day, and the
  report treats the (now allegedly past) requested day as settled. This is
  a wall-clock/timezone test-fixture fragility unrelated to any lane's
  integrated commits, pre-existing on the baseline this integration started
  from.
- Zero Class A (correctness regression). Zero Class B (DB isolation
  regression). Zero Class D (this defect is fully explained and pre-dates
  MW1D, so it is not "unexplained" or "new").

### 17.3 DB safety

Zero orphan `ros_test_e2e_*` databases after every run this session
performed (checked via direct `psql` query against the persistent `ros`
container after the full E2E run). Persistent `ros` itself was never
connected to by any test (the isolated harness clones its own per-run
template); confirmed no `DATABASE_URL`-pointed write occurred outside
`npx prisma validate` (schema-only, no DB connection) and the isolated
harness's own scratch databases. Migration count unchanged at **37**
throughout.

---

## 18. Static verification (§17)

| Check | Result |
|---|---|
| `git diff --check` | clean |
| `npx prisma validate` | valid |
| `npm run typecheck` | clean |
| `npm test` | **78 suites / 1053 tests, all PASS** |
| `module-boundaries` | **45/45 PASS** |
| `npm run openapi:check` | clean, zero diff |
| `npm run lint:check` | 48 errors / 3 warnings, identity-identical to baseline; zero new |
| `npm audit --omit=dev --audit-level=high` | 7 high / 1 moderate, zero new |

---

## 19. Reconciliation commit (§20)

**`a53c56e`** — `chore(integration): reconcile observability baseline`.

Contents (4 files changed, 649 insertions, 2 deletions):

- `src/common/observability/http/correlation.middleware.ts` — the B1-3
  denied-request tenant/branch enrichment fix (§4).
- `src/common/observability/http/denied-request-tenant-context.spec.ts` —
  new unit-level real-HTTP proof (§4.3).
- `test/observability-red-cardinality.e2e-spec.ts` — new real-HTTP/real-
  Postgres RED cardinality proof against a live B1-3 route (§7).
- `test/observability-sync-lifecycle.e2e-spec.ts` — new real-HTTP/real-
  Postgres Sync automatic-instrumentation proof (§9).

No domain feature. No package/lockfile change (prom-client already arrived
via the cherry-pick, unaltered). No generated-OpenAPI change (already
clean, no diff). No lint reconciliation needed beyond fixing this
commit's own two new files (§12).

---

## 20. Requirements (§21)

| Requirement | Status |
|---|---|
| NFR-OBS-001 | COMPLETE |
| NFR-OBS-002 | NOT IMPLEMENTED |
| NFR-OBS-003 | COMPLETE |
| NFR-OBS-004 | NOT IMPLEMENTED |
| NFR-OBS-005 | PARTIAL |
| NFR-OBS-006 | PARTIAL |
| NFR-OBS-007 | NOT IMPLEMENTED |
| FR-SEC-004 | COMPLETE (unchanged — no authorization code touched) |
| FR-API-012 | COMPLETE (unchanged) |
| FR-SEC-028 | PARTIAL (unchanged) |
| FR-PLT-013 | PARTIAL (unchanged — CI wiring confirmed in §13, literal generated RLS suite still not implemented) |

Nothing overclaimed from integration alone; every status above is either
carried unchanged from the reviewed slices or directly re-verified in this
session.

---

## 21. Final response block (§23)

```
STATUS: INTEGRATED — COMMITTED

STARTING HEAD: 2603099 (26030993f0bd0b7dee34a5f85297d33022e0caa9)

G1-3 IMPLEMENTATION INTEGRATED: YES — 06c93e8
G1-3 REPORT INTEGRATED: YES — 5a20268

RECONCILIATION COMMIT: a53c56e

RESULT HEAD BEFORE REPORT: a53c56e
REPORT COMMIT: a000dc8 ("docs: record observability integration")

AUTHORIZATION COVERAGE: 157 / 141 / 0

B1-3 DENIED REQUEST TENANT CONTEXT: PASS
B1-3 DENIED POS BRANCH CONTEXT: PASS
ATTACKER-SUPPLIED TENANT/BRANCH CONTEXT: IGNORED

STRUCTURED JSON: PASS
CORRELATION: PASS
REDACTION: PASS (NFR-OBS-005 remains PARTIAL — free-text channel best-effort only)
REQUEST LOG EXACTLY ONCE: PASS

RED RATE: PASS
RED ERRORS: PASS
RED DURATION: PASS
CARDINALITY SABOTAGE: PASS (50 real branch ids -> 1 series, proven live)
RAW IDS IN METRIC LABELS: NO

SYNC AUTOMATIC OBSERVABILITY: PASS

METRICS EXPORTER: disabled by default (METRICS_PORT unset), loopback bind,
  no port listener in any E2E run this session performed
PUBLIC METRICS ROUTE: NO

OPENAPI: PASS (clean, zero diff, no catch-all, no metrics route, /v1/sync/batch retained)

PROM-CLIENT: 15.1.3 (unchanged from cherry-pick)

DEPENDENCY AUDIT: 7 high / 1 moderate, delta: zero new vs. pre-integration baseline

LINT: 48 errors / 3 warnings (corrected 2026-09-03 — see evidence
  correction above; original draft mis-transcribed eslint's 51-total-
  problems figure as the error count), delta: zero new — 51-row
  file:line:column:ruleId:severity identity set byte-identical to the
  pre-integration baseline (2603099)

NFR-OBS-001: COMPLETE
NFR-OBS-002: NOT IMPLEMENTED
NFR-OBS-003: COMPLETE
NFR-OBS-004: NOT IMPLEMENTED
NFR-OBS-005: PARTIAL
NFR-OBS-006: PARTIAL
NFR-OBS-007: NOT IMPLEMENTED

FR-SEC-004: COMPLETE (no regression)
FR-API-012: COMPLETE (no regression)
FR-PLT-013: PARTIAL

MIGRATION COUNT: 37

TYPECHECK: clean
UNIT: 78 suites / 1053 tests PASS
MODULE BOUNDARIES: 45/45 PASS

TARGETED E2E: 23 suites / 510 tests, 23/23 suites PASS, 510/510 tests PASS
FULL E2E: 80 suites / 1322 tests, 79/80 suites PASS, 1321/1322 tests PASS

CLASS A: NONE
CLASS B: NONE
CLASS D: NONE

KNOWN PRE-EXISTING BASELINE QA DEFECT (not Class A/B/C/D): 1 —
  test/reporting-authorization.e2e-spec.ts, reproduced identically on
  pre-integration baseline HEAD 2603099 in a disposable worktree;
  deterministic UTC-calendar-date vs Africa/Cairo business-day boundary
  fixture defect, unrelated to any integrated commit (corrected 2026-09-03
  from an earlier "Class C" mislabel — this failure is constant, not
  contention-sensitive, so Class C's own definition does not fit it)

ORPHAN SCRATCH DBS: 0
PERSISTENT ros TOUCHED: NO

REPORT: kitchen-kit/backend/docs/reports/claude/full-srs-4day/2026-09-03_MW1D_integration-g1-3.md
INDEX UPDATED: YES

PUSHED: NO
DEPLOYED: NO

READY FOR D4-1B INTEGRATION LATER: YES
```

---

*This report is non-authoritative evidence, per the authority statement
above. It records what was directly observed and measured in this session;
it ratifies nothing.*
