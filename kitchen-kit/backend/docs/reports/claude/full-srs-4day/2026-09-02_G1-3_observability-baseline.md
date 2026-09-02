# G1-3 — OBSERVABILITY BASELINE

| Field | Value |
|---|---|
| **Task / slice name** | Full SRS 4-Day — G1-3 — Observability baseline (structured logging + RED metrics + redaction + alert/runbook foundation) |
| **Lane** | G — CI/Infra/Observability |
| **Report type** | IMPLEMENTATION + SECURITY/PRIVACY REVIEW + TESTS |
| **Authority statement** | **NON-AUTHORITATIVE EVIDENCE.** `ROS_SRS_v1.0.pdf` (§27.6, §26.6, §27.1, §27.3) and the ratified entries in the governance decision register remain authoritative. This report records what was built, run, and measured in this session; where it disagrees with the SRS, the SRS wins. |
| **Date** | 2026-09-02 |
| **Starting HEAD** | `b46a00e69758f68de2b8228a34e1a9d9452dcb69` (`b46a00e`) — *docs: correct wave 1b verification counts* |
| **Branch** | `full-srs/lane-g2-observability` |
| **Working tree at start** | Clean |
| **Task identifier** | G1-3 |
| **Status** | COMPLETE — see §21 for exact verification results |

---

## 1. Baseline verification (§0)

- `pwd` = `/Users/mac/projects/ros-worktrees/lane-g`, branch `full-srs/lane-g2-observability`, HEAD = `b46a00e` exactly, working tree clean — confirmed before any change.
- `test/e2e-db-isolation/e2e-database-environment.ts` exists; `test/e2e-db-isolation/jest-hooks.ts` does **not** exist; `test/e2e-db-isolation-config.e2e-spec.ts` passed (1/1) before and after implementation.
- **Baseline discrepancy found and corrected before implementing anything**: `tsc --noEmit` initially failed with dozens of "Property does not exist on type 'PrismaClient'" errors (stale generated Prisma client — `sync_operation_dedup`/`sync_device_state` etc. missing from `src/generated/prisma`). Root cause: the generated client in this worktree predated the `20260902010000_sync_protocol_kernel` migration in the schema. Fixed by running `npx prisma generate` (no schema change, no migration — purely regenerating the client from the already-migrated schema). After that, `tsc --noEmit` was clean and `lint:check` dropped from 279 errors to 49.
- **Baseline numbers used in this report differ from the task brief's stated "48 lint / 6 audit-high"**: measured, empirically, at clean HEAD `b46a00e` (after the Prisma-client fix above, before any G1-3 change): **lint 49 errors / 3 warnings**, **`npm audit --omit=dev --audit-level=high` 7 high / 1 moderate**. This is 1 lint error and 1 audit-high advisory more than the brief's stated baseline — real drift since whichever prior session recorded 48/6, not something this session introduced (confirmed by measuring on a clean tree at the exact starting HEAD, before writing a single line of G1-3 code). The gate this report actually holds itself to is **zero new** lint errors and **zero new** audit advisories versus this measured starting point, which is the substantively meaningful bar regardless of which absolute number is "the" baseline. See §21 for the exact before/after diff proving zero new entries.

## 2. Architecture

New bounded module: `src/common/observability/` (nothing added to Sales/Identity/Sync/Inventory beyond the two integration points below).

```
src/common/observability/
  observability.module.ts            — composition root: providers + global guard/interceptor + middleware wiring
  context/
    observability-context.ts         — AsyncLocalStorage store + ObservabilityContextService
    correlation.ts                   — header validation/generation (correlation + causation)
  http/
    correlation.middleware.ts        — ALS run() + response header + SOLE completion log/metric emission point
    route-context.guard.ts           — global APP_GUARD: normalized route + handler identity (runs before every controller guard)
    tenant-enrichment.interceptor.ts — global APP_INTERCEPTOR: trusted tenant/branch enrichment from request.authorization
  logging/
    redaction.ts                     — allowlist-first sanitisation layer (NFR-OBS-005)
    structured-logger.service.ts     — Nest LoggerService + direct structured-log entry point
  metrics/
    metrics.service.ts               — prom-client RED metrics, per-instance Registry
    metrics-exporter.service.ts      — internal-only, opt-in Prometheus text exporter
  alerts/
    alert-rules.spec.ts              — structural/reference validation of the alert-rule YAML
  observability-overhead.spec.ts     — bounded-overhead microbenchmarks
```

Integration points (only two files outside `common/observability/` touched, both cross-cutting bootstrap, never a domain module):

- `src/app.module.ts` — imports `ObservabilityModule` (adds the global guard/interceptor/middleware to every route in the app, automatically, including future domains — see §29 discussion below).
- `src/main.ts` — `NestFactory.create(..., { bufferLogs: true })` + `app.useLogger(app.get(StructuredLoggerService))` immediately after creation, so Nest's own bootstrap/framework logs (and every existing `new Logger(ClassName)` call site) route through the structured JSON logger with **zero call-site edits**.
- `src/config/env.validation.ts` — two new **optional** fields, `METRICS_PORT`/`METRICS_HOST` (§10).
- `eslint.config.mjs` — one new scoped rule block (§5 below).

Nothing in `common/observability/` imports Prisma, and nothing queries the database — `MetricsService` and `StructuredLoggerService` are pure in-process/ALS-driven; the only cross-module import is `TenantEnrichmentInterceptor` reading the TYPE `RequestAuthorization` from `modules/identity/context/tenant-context.ts` (a `common → modules/identity` edge already precedented by `IdempotencyInterceptor`, and outside `module-boundaries.spec.ts`'s scan surface, which only scans `src/modules/**`).

### Why middleware + a global guard + a global interceptor, and not one component

Nest's HTTP lifecycle is Middleware → Guards (global, then controller) → Interceptors (pre) → Handler → Interceptors (post) → Exception Filters. A single component cannot cover everything this task needs:

- **Correlation/causation context must exist for literally every request**, including one that matches no controller at all (404) — only true Express middleware runs unconditionally before routing. `CorrelationMiddleware` creates the `AsyncLocalStorage` run-scope and is the **sole** place that emits the request-completion log/metric (via `res.once('finish', ...)`, guarded by a `store.completed` flag so it can never double-fire even if something else also touched the response).
- **Route/handler identity must be captured even for a request a later guard rejects** (401/403) — `ObservabilityRouteGuard` is registered as `APP_GUARD`, which Nest always executes **before** any controller-level `@UseGuards(...)` guard (`JwtAuthGuard`, `TenantContextGuard`, `PermissionGuard`). It always returns `true`; it never authorizes or denies anything.
- **Tenant/branch must come only from the already-live-verified `request.authorization`** that `TenantContextGuard` attaches — that object exists only once every guard (global and controller-level) has already succeeded, which is exactly when an `APP_INTERCEPTOR` runs. `TenantEnrichmentInterceptor` does nothing else — no logging, no metrics — so future authorization changes (B1-3) can freely add/replace controller-level guards without this component needing to change (§29).

This shape directly answers §29's ask: a brand-new domain (D4-1B's Sync production handlers, or any future controller) is observed automatically the moment it registers a route — nothing domain-specific has to remember to log or instrument anything.

## 3. Logging inventory BEFORE this slice (§2)

Measured by grep across `src/**/*.ts`, excluding `*.spec.ts` and `src/generated/**`:

| Category | Count | Detail |
|---|---|---|
| `console.log/error/warn/debug/info` in runtime `src/` | 13 | All in `src/scripts/**` (`sign-country-pack.ts`, `generate-openapi.ts`, `seed-dev-data.ts`) — standalone CLI tooling, never on any HTTP request path |
| `new Logger(...)` (Nest's built-in Logger) | 14 files | `prisma.service.ts`, `password-reset.notifier.ts`, `tenants.service.ts`, `sessions.service.ts`, `tax-class.service.ts`, `sales-domain-exception.filter.ts`, `country-pack.loader.ts`, `country-pack.trust.provider.ts`, `tax-class.provisioner.ts`, `recipe-cost.service.ts`, `sync-operation.registry.ts`, `sync-batch.service.ts`, `country-pack.service.ts`, `audit.service.ts` |
| Pre-existing `common/` infra | none | No `src/common/observability/`, `logging/`, or `metrics/` directory existed |
| Existing interceptors/filters | 2 | `IdempotencyInterceptor` (`common/idempotency/`), `SalesDomainExceptionFilter` (`modules/sales/`) — neither logs a request-completion line |
| Existing HTTP correlation-id handling | 0 | Confirmed by a prior session's own report (`2026-08-23_API1A_..._basepath-error-contract.md`): "Zero `X-Correlation-Id`/`correlation-id` HTTP header handling anywhere" |
| Existing `correlationId`/`causationId` in code | domain-event envelope only | `common/domain-events/domain-event.types.ts` — a REQUIRED, non-nullable field on every `DomainEventEnvelope`, defaulted once per `UnitOfWork.execute()` call (fresh ULID if the caller doesn't pass one) — **entirely disconnected from any HTTP request**; no call site anywhere passes an inbound HTTP correlation id into `UnitOfWork.execute()`'s optional `CausalContext` |
| Domain-event **handlers**/subscribers | **0** | Grep for `@OnEvent`/`EventEmitter2`/`.subscribe(` across `src/modules/**` returns nothing — no domain-event consumer substrate exists yet on this baseline (confirms this is D4-1B/future-domain territory, not something this slice can wire "handler logging" into) |
| Worker/background handler path | `SyncOperationRegistry`, `SyncBatchService` | Both already use `new Logger(...)`, which this slice's `app.useLogger()` now routes through the structured JSON logger with no call-site change |

### Bypasses found

**No runtime request-path bypass of Nest's Logger existed** — the 13 `console.*` calls are all in `src/scripts/**` CLI tooling (never invoked from an HTTP request), and every genuine application-code log call already went through `new Logger(ClassName)`. The real gap was structural, not a bypass: `new Logger(...)` output was Nest's default plain-text `ConsoleLogger` (no `app.useLogger()` call existed anywhere), so **no application log was structured JSON** even though nothing was routing around the logger illegitimately. That gap is closed by `app.useLogger(app.get(StructuredLoggerService))` in `main.ts` — see §4.

### Static regression gate (§2)

Added to `eslint.config.mjs`, scoped to `src/**/*.ts`, excluding `src/**/*.spec.ts` and `src/scripts/**`:

```js
{
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.spec.ts', 'src/scripts/**'],
  rules: { 'no-console': 'error' },
}
```

This blocks any FUTURE direct `console.*` call in runtime `src/` code (verified: adding a throwaway `console.log(...)` to a controller and running `lint:check` fails with `no-console`; removing it restores the clean baseline). `src/scripts/**` is the one narrowly-scoped, justified exception (standalone CLI tooling outside any request context, always used `console.*`). `*.spec.ts` is excluded because test diagnostics are not application logs.

## 4. Structured JSON logger (§5)

`StructuredLoggerService` implements Nest's `LoggerService` interface AND exposes a direct `logEvent(level, event, message, meta?)` entry point. Every emitted line is exactly one JSON object written via `process.stdout.write` — no `console.*` inside the logger itself (it is not flagged by the new gate because it never calls `console.*`).

Envelope (stable, documented field set):

```json
{
  "timestamp": "2026-09-02T19:57:37.524Z",
  "level": "info",
  "service": "ros-backend-api",
  "event": "http.request.completed",
  "message": "GET /orders/:id -> 200",
  "tenantId": "01a0...-uuid" | null,
  "branchId": "01a0...-uuid" | null,
  "correlationId": "01a0...-uuid",
  "causationId": null,
  "method": "GET",
  "route": "/orders/:id",
  "handler": "OrdersController#getOrder",
  "statusCode": 200,
  "statusClass": "2xx",
  "durationMs": 12.34
}
```

`tenantId`/`branchId`/`correlationId`/`causationId` are **always present as keys**, `null` when genuinely unknown — never a fabricated placeholder (NFR-OBS-001's letter: "tenant, branch, correlation, and causation identifiers" present on every log line, honestly, not merely non-null).

**Bootstrap wiring** (`main.ts`): `NestFactory.create(AppModule, { bufferLogs: true })` then `app.useLogger(app.get(StructuredLoggerService))` **immediately**, before any other setup step. `bufferLogs: true` means every log Nest's own module-instantiation phase emits is buffered and flushed through the structured logger the instant it's attached, rather than falling back to the default text logger. The one window this cannot cover is a crash before `NestFactory.create()` itself resolves — there is no app, and therefore no logger, yet; that surfaces via Node's own uncaught-exception handling, which is unavoidable at the application-logger level and explicitly out of scope. This means every one of the 14 pre-existing `new Logger(ClassName)` call sites, and Nest's own framework logs (bootstrap, route explorer, etc.), now emit structured JSON with **zero call-site edits** — verified directly: `structured-logger.service.spec.ts` asserts `.log()/.warn()/.error()/.debug()` all route through the same JSON envelope with `event: "nest.log"`.

Live proof from a real `AppModule` boot: `{"timestamp":"...","level":"info","service":"ros-backend-api","event":"http.request.completed","message":"GET /health -> 200",...}` (captured from `test/app.e2e-spec.ts` during verification).

## 5. Correlation / causation (§4)

Header names: `x-correlation-id` (request+response), `x-causation-id` (request only — no existing response-header convention for causation, and none is invented here).

Format: `^[A-Za-z0-9._-]{1,128}$` — by construction this **rejects CR/LF and every other control character** (they are simply outside the allowed alphabet) and caps length at 128. A present-but-malformed or oversized header is silently replaced with a server-generated id (never echoed back, never logged raw) rather than rejecting the request — correlation is an observability aid, not an API contract a caller can break.

Server-generated fallback: `newId()` from the repository's existing `common/ids.ts` (ULID rendered as UUID) — reused rather than introducing a second id-generation convention.

Causation: **no fabricated fallback.** Absent/malformed inbound `x-causation-id` resolves to `null`, never a copy of the correlation id or any other invented value — matches NFR-OBS-001's requirement for honest causation, and the task's explicit instruction not to equate correlation and causation merely to fill the field. Domain-event handler logging using the event's own real `correlationId`/`causationId` (§4's other ask) does not yet apply: **zero domain-event handlers/subscribers exist in this codebase** (confirmed by grep — see §3), so there is nothing to wire this into yet; this is accurately D4-1B/future-domain territory, not skipped scope.

Tests (`context/correlation.spec.ts`, 13 tests): no header, valid header, malformed header (disallowed characters), oversized header (129 chars, rejected; exactly 128 accepted), CR/LF injection attempt, null-byte/control-character payload, duplicated/array-valued header treated as absent, and distinct ids across repeated no-header calls (no cross-request leakage in the generator itself). Concurrent-request isolation is proven separately at the `AsyncLocalStorage` layer (§6) and end-to-end over real HTTP (§8).

## 6. Observability context (§3)

`ObservabilityContextService` wraps a single `AsyncLocalStorage<ObservabilityStore>`. Store shape: `correlationId` (string), `causationId` (string|null), `tenantId`/`branchId` (string|null, mutable — start `null`), `route`/`handler` (string|null, mutable), `method`, `startedAtNs`, `completed` (exactly-once guard).

**Trust rule enforced by construction, not by convention**: `tenantId`/`branchId` are set **only** by `ObservabilityContextService.enrichTenant()`, which is called from exactly one place — `TenantEnrichmentInterceptor` — reading exactly one field — `request.authorization?.context` — which is populated **only** by the real, live-verified `TenantContextService.resolve()` (never by a header, body, query string, or JWT snapshot claim). Verified directly by `tenant-enrichment.interceptor.spec.ts`'s sabotage test: a request carrying `x-tenant-id` header, `body.tenantId`, and `query.tenantId` all set to `'attacker-supplied-tenant'`, with no `request.authorization`, leaves the store's `tenantId`/`branchId` `null`.

`observability-context.spec.ts` (6 tests) includes an explicit concurrency-isolation proof: N=50 concurrently-running `ctx.run()` contexts, each yielding the event loop via `setTimeout`, all report back their own distinct `correlationId` with zero cross-contamination — proving `AsyncLocalStorage` genuinely isolates per-execution state rather than relying on a shared mutable global that concurrent requests could clobber.

## 7. Redaction / allowlist layer (§6)

`sanitizeMetadata()` in `logging/redaction.ts` — the **primary control is an allowlist** of ~25 permitted top-level metadata keys (`route`, `handler`, `statusCode`, `correlationId`, `errorMessage`, etc.); any key not on that list is **dropped, never serialized** — not merely hidden. A denylist (`SENSITIVE_KEY_PATTERN`, matching `authorization`, `cookie`, `password`, `pin`, `*token*`, `secret`, `apiKey`, `signingKey`, `privateKey`, `DATABASE_URL`, `APP_DATABASE_URL`, etc., case-insensitively) is defence-in-depth on top, applied **regardless of nesting depth** — it catches a sensitive key nested inside an otherwise-allowed container value (e.g. `target: { password: '...' }`), which the top-level allowlist alone would not.

Bounding: max recursion depth 4, max 20 array items, max 40 keys per object, max 500 chars per string (all enforced so a deeply-nested or huge metadata object cannot blow up serialization or the log line size). `Error` objects are reduced to `{errorName, errorMessage}` only — no arbitrary extra properties. A best-effort free-text scrub (`FREE_TEXT_SECRET_PATTERNS`) additionally redacts `Bearer <token>`-shaped, `scheme://user:pass@host`-shaped (DSN), and JWT-shaped substrings **inside otherwise-safe string values** — documented explicitly as best-effort, not exhaustive (see §13 disposition).

Sabotage tests (`logging/redaction.spec.ts`, 27 tests) cover every literal value listed in the task brief — `authorization`, `cookie`, `password`, `pin`, `accessToken`, `refreshToken`, `token`, `secret`, `apiKey`, `signingKey`, `privateKey`, `DATABASE_URL`, `APP_DATABASE_URL` — plus nested object, array, `Error` object, Prisma-like error object (DSN embedded in `.message`), depth/size bounding (20-level-deep object, 1000-item array), a secret beside safe metadata, and an explicit "never emits the redacted value in a second field" check. All 27 pass.

**Second, independent test through the real logger/request path**: `structured-logger.service.spec.ts`'s "never leaks a secret passed in metadata" test calls the real `StructuredLoggerService.logEvent()` (not the bare sanitizer function) and asserts the actual JSON line written to `process.stdout` contains none of `super-secret-password`, `Bearer eyabc123...`, or `postgres://user:password@host/db`. A third, full-stack version runs over real HTTP in `observability-request-lifecycle.spec.ts` (§8).

## 8. Request completion log (§7) — real HTTP, end to end

Owned by exactly one component, `CorrelationMiddleware`, via `res.once('finish', ...)` — **not** duplicated between an interceptor and the middleware. `store.completed` is a boolean latch checked first inside the `finish` handler, so even if something unforeseen tried to fire it twice, it physically cannot.

Route labels are **normalized templates**, never raw paths — verified live against real controllers: `/orders/:businessDay/:id`, `/org/branches/:branchId/station-routing-rules`, `/auth/memberships/:membershipId/roles/:roleId` (captured from a real `organisation`/`rbac`/`sales` e2e run in this session — see the JSON log excerpt in §14). A request matching no controller at all is labeled `route: "unmatched"`, `handler: "unmatched"` — never the raw incoming path (verified: `GET /does/not/exist/12345` → 404, log line contains neither `/does/not/exist` nor any fragment of it).

`observability-request-lifecycle.spec.ts` (15 tests, real Nest app + `supertest`, no database) proves, over genuine HTTP:

- 2xx / 4xx (validation, and 401 auth rejection) / 404 (unmatched) / 5xx (thrown exception) each produce **exactly one** completion log line and **exactly one** metric increment — including the specific "not double-counted by any filter" case for a 401 the task calls out;
- a request served **before** any trusted tenant context exists (`/test/pre-tenant`, no guard) logs `tenantId: null, branchId: null`;
- a request served **after** a (mocked, DB-free) `TenantContextGuard`-shaped guard sets `request.authorization` logs the real `tenant-live-1`/`branch-live-1` values, exactly once;
- correlation header: no header (server-generated, returned), valid header (echoed, used as the log's `correlationId`), malformed header (`'has spaces and $ymbols!'`, replaced), oversized header (500 chars, replaced), and three concurrent requests each keeping their own distinct correlation id with zero cross-contamination end to end over real HTTP;
- a request carrying `Authorization: Bearer ey...` and `Cookie: session=refresh-token-value-xyz` never leaks either value into any line written to stdout during that request, while the completion log's safe fields (`event`, `route`, `statusClass`, `correlationId`, `durationMs`) remain present.

This suite deliberately runs the fast unit-test project (no database — every route is a throwaway test controller, `ObservabilityModule` wired exactly as `AppModule` wires it) rather than the DB-backed E2E harness, so it stays fast while still exercising the real middleware → guard → interceptor → completion pipeline over genuine HTTP requests, not mocks. Full DB-backed proof of the same mechanism against REAL `TenantContextGuard`/`PermissionGuard` resolution is separately confirmed by this session's targeted E2E run (§14) — the JSON log lines captured there show real tenant/branch UUIDs and normalized routes across `organisation`, `rbac`, and `sales` traffic.

## 9. RED metrics (§8, §9)

Two Prometheus metrics, `prom-client`, exact names:

- **`http_requests_total`** (Counter) — RATE, and ERRORS via `status_class` filtering (5xx independently selectable: `http_requests_total{status_class="5xx"}`).
- **`http_request_duration_seconds`** (Histogram, buckets `0.005`..`5` seconds) — DURATION, `_bucket`/`_sum`/`_count` suitable for `histogram_quantile(0.95, ...)` p50/p95/p99 computation.

Labels on both, **exactly** `method`, `route`, `handler`, `status_class` — nothing else. `route` is the same normalized template the completion log uses; `handler` is `${ControllerClass.name}#${handlerMethod.name}` (e.g. `OrdersController#getOrder`), captured by `ObservabilityRouteGuard`.

**endpoint** = method + normalized route template. **handler** = stable `Controller#method` identity. These are deliberately independent labels on the same series (`metrics.service.spec.ts`'s "endpoint vs handler distinction" test: the same route reached via two different handler names produces **two** series, not one merged series) — so either can be aggregated (`sum by (route, ...)` / `sum by (handler, ...)`) without conflating "one route, two implementations" with "one implementation, one route".

**Cardinality sabotage proof** (`metrics.service.spec.ts`): 500 simulated requests to the same normalized route/handler (standing in for 500 distinct order ids that never touch a label) collapse onto **exactly one** series with value `500`; two different routes stay two series; the same route via two different handlers stays two series. There is no code path by which a raw resource id, tenant id, correlation id, or arbitrary exception string could reach a label — the public `recordRequest()` API only accepts the four bounded fields.

**Overhead** (`observability-overhead.spec.ts`, informational microbenchmark, not an SRS NFR proof by itself): recording 10,000 requests across the fixed label set stays under 0.5ms/call and produces exactly 1 series (not 10,000); `sanitizeMetadata` on a representative payload stays under 1ms/call over 5,000 iterations; creating/tearing down 10,000 `AsyncLocalStorage` run() contexts stays under 0.2ms/call. No synchronous DB call and no per-request network call to an observability backend exist anywhere in this code path (verifiable by inspection — `MetricsService`/`StructuredLoggerService` have zero Prisma/HTTP-client imports).

**Per-instance registry** (important, not cosmetic): `MetricsService` creates its OWN `prom-client` `Registry` per instance rather than using the library's process-global default registry. This is what lets G1-2's parallel/sequential Jest E2E suites boot many independent `AppModule`/`TestingModule` instances in the same Node process without a "metric already registered" crash — confirmed directly by a dedicated test and by the full 76-suite unit run and the full E2E run (§14) completing cleanly with three separate `MetricsExporterService` instances logging in the same process during `npm test`.

## 10. Metrics exposure (§10)

No existing internal/admin/metrics exposure convention was found in this repository (only a plain public `HealthController`). Per the task's explicit prohibition on an unauthenticated public `/metrics` on the ordinary business API, `MetricsExporterService` runs a **separate, minimal raw `node:http` listener** — not a Nest controller, never appears in the OpenAPI document (verified: `openapi:check` clean, zero drift), never shares a port/middleware stack with the public API.

- **Disabled by default** — starts only when `METRICS_PORT` is explicitly set (new optional `env.validation.ts` field, `@Min(1) @Max(65535)`). This is what keeps the G1-2 harness collision-free: test environments never set `METRICS_PORT`, so **no listener is ever created during any test run** — confirmed live: `npm test` logs `"Metrics exporter disabled (METRICS_PORT not set)"` for every one of the 76 suites that boots the module without explicitly configuring a port, and the 3 unit tests that DO opt in use port `0` (OS-assigned ephemeral) specifically to prove the exposure mechanism works without claiming a fixed port.
- Binds to `METRICS_HOST` (default `127.0.0.1`, loopback-only) when started.
- Serves the Prometheus text-exposition payload on any `GET`; rejects non-`GET` with 405.
- Closes cleanly on `onModuleDestroy` (`server.close()`, awaited) — verified by a dedicated test asserting `server.listening === false` after teardown.
- **No application-level authentication** — the control is network isolation (loopback default; a deployment that needs remote scraping must both set a non-default `METRICS_HOST` AND apply network/IaC-level access restriction, which this repository slice does not and cannot provide from application code alone — stated as an operational requirement, not falsely claimed as already enforced).

Metrics contain no tenant-specific or otherwise high-cardinality data (§9's cardinality proof applies identically to what this exporter serves, since it serves the same `MetricsService.metricsText()`).

## 11. Dependency discipline (§11)

One new direct runtime dependency: **`prom-client@15.1.3`** (pinned exact version, `--save-exact`). No existing metrics/logging library existed in this repository to reuse (`grep` for `pino`/`winston`/`prom-client`/`prometheus`/`@nestjs/terminus`/`opentelemetry` returned nothing). `prom-client` is the de-facto standard Prometheus client for Node — chosen over a dependency-free hand-rolled implementation because correct histogram bucket math and the Prometheus text-exposition format are exactly the kind of thing not worth reimplementing for a baseline slice. (`npm` flags it deprecated in favour of a package rename, `@prometheus-io/client` — noted for future awareness; `prom-client@15.1.3` remains the current, maintained, widely-used release and is not itself vulnerable per the audit below.)

`js-yaml` (already a devDependency) is reused, not re-added, to parse/validate the alert-rule YAML in tests.

`npm audit --omit=dev --audit-level=high` **before** adding `prom-client`: 7 high, 1 moderate (8 total — see §1's baseline-discrepancy note). **After**: identical — 7 high, 1 moderate, 8 total, same package names (`@nestjs/swagger`, `@prisma/config`, `deepmerge-ts`, `fast-uri`, `js-yaml`, `mysql2`, `prisma`, `qs`). **Zero new advisories attributable to `prom-client`.** Lockfile updated deterministically via `npm install prom-client@15.1.3 --save-exact` (4 packages added, no unrelated package touched or upgraded — `npm ls prom-client` confirms exact pin).

OpenTelemetry was **not** added — not required by this slice, and distributed tracing (NFR-OBS-002) is explicitly out of scope (§16 below).

## 12. Alert rules (§12) and runbooks (§13)

`docs/observability/alerts/backend-api.rules.yaml` — standard Prometheus alerting-rule format (`groups: [{name, rules: [{alert, expr, for, labels, annotations}]}]`), chosen for being an open format any Prometheus-compatible evaluator can load without a proprietary adapter. Four rules, all referencing **real, emitted metric names**:

| Alert | SLO | Expression (abridged) | Runbook |
|---|---|---|---|
| `ROSBackendElevatedErrorRate` | Implementation-level 5% threshold (no numeric SRS SLO exists for this) | `sum(rate(http_requests_total{status_class="5xx"}[5m])) / sum(rate(http_requests_total[5m])) > 0.05` | `elevated-error-rate.md` |
| `ROSBackendReadLatencyP95Breach` | `NFR-PERF-030` (read p95 ≤ 200ms) | `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{method="GET"}[5m])) by (le)) > 0.2` | `read-latency-p95-breach.md` |
| `ROSBackendWriteLatencyP95Breach` | `NFR-PERF-031` (write p95 ≤ 400ms) | same shape, `method=~"POST\|PUT\|PATCH\|DELETE"`, `> 0.4` | `write-latency-p95-breach.md` |
| `ROSBackendMetricsScrapeDown` | Metrics availability (not a numbered SRS SLO — a monitoring-blindness alert protecting the other three) | `up{job="ros-backend-metrics"} == 0` | `metrics-exporter-unavailable.md` |

No numeric SLO was fabricated where the SRS gives none — the error-rate threshold is explicitly documented as an implementation-level default (following the repository's own established convention of explicit, documented defaults, e.g. `PIN_MAX_FAILED_ATTEMPTS`), not claimed as SRS-derived.

Each of the four runbooks (`docs/observability/runbooks/*.md`) includes: what the alert means, user impact, the exact metric/query to inspect, first diagnostic steps, safe mitigations, an explicit "what NOT to do" section, escalation guidance, recovery verification, and how to use `correlationId` to search logs for the specific failing request(s) — every section the task brief requires.

**Validation**: `promtool` (the canonical PromQL validator) is not available in this environment — stated honestly rather than claiming full PromQL grammar validation. `alerts/alert-rules.spec.ts` (17 tests, `js-yaml`) instead validates: the file parses as YAML with the standard `groups`/`rules` shape; every rule has a non-empty `expr`, a valid `for` duration (`^\d+[smh]$`), required `severity`/`summary`/`description`/`runbook_url` annotations; every `expr` references at least one real, emitted metric name (`http_requests_total`, `http_request_duration_seconds_bucket/_sum/_count`, or Prometheus's own `up`); every `runbook_url` resolves to a file that actually exists on disk; parentheses are balanced (basic structural PromQL sanity); the three documented SLO alerts are all present; no duplicate alert names. All 17 pass.

## 13. NFR-OBS-006 claim discipline (§14) — uncovered SLOs

Per the task brief's explicit instruction, NFR-OBS-006 ("Alerts defined for every SLO breach with documented runbooks") is reported **PARTIAL**, not COMPLETE. This slice's alert/runbook foundation covers exactly the backend API SLOs its own RED metrics can measure (§12's table). The following SLO classes from the SRS are **not** covered by any alert here, because nothing in this slice's telemetry can measure them:

- **`NFR-PERF-032`** (sync batch of 500 ops ≤ 3s p95) — the RED histogram is generic per-endpoint HTTP duration; a batch-specific metric distinguishing "500-operation sync batch" from any other write would need Sync-domain-specific instrumentation, out of this slice's bounded scope.
- **`NFR-AVAIL-001/002/003`** (cloud/enterprise/POS-sales uptime commitments) — these require an EXTERNAL uptime prober (synthetic monitoring hitting the service from outside), not something an in-process RED metric can derive; "no 5xx" is explicitly not equivalent to monthly uptime.
- **Client/offline-side NFRs** (`NFR-PERF-001/002/003/004/020/021`, `NFR-USA-*`) — POS render latency, payment finalisation latency, cold start, KDS display latency, sync-of-5000-queued-operations, local persistence latency, usability targets — all measured client-side or in a different runtime entirely; nothing on the backend API surface observes them.
- **`NFR-OBS-004`'s own metrics** (sync backlog, fiscal failures, offline terminals) — not implemented in this slice (§15 below), so no alert can reference them yet.
- **`NFR-REL-010/011/012/013`** (committed-sale loss, duplicate financial effect, data durability, RPO/RTO) — infrastructure/data-durability guarantees, not request-path SLOs an HTTP RED metric measures.

## 14. Business metrics — NFR-OBS-004

**Not implemented.** The literal requirement names four metrics: orders/min, sync backlog, fiscal failures, offline terminals. None is implemented in this slice:

- **orders/min** — would require either a Sales-domain-specific counter (business-domain code, explicitly out of scope for G1-3) or deriving it from the generic `http_requests_total{route="/orders", method="POST"}` counter — the task brief explicitly forbids labelling a technical HTTP request counter as a business metric ("Do not label a technical HTTP request counter 'orders/min'"), so this was deliberately NOT done even though the raw number is technically present in the RED data.
- **sync backlog** — would require a live query against Sync's operation/queue tables — out of this slice's "no metrics depend on tenant-specific database queries" constraint (§26 of the brief) and genuinely Sync-domain-owned.
- **fiscal failures** — fiscal is not implemented anywhere in this codebase (confirmed by the repository's own prior audits); inventing fiscal-failure telemetry for a non-existent domain was explicitly forbidden.
- **offline terminals** — would require Sync/Identity-domain terminal-state knowledge; out of bounded scope.

No dummy zero-value metric was emitted for any of these. **NFR-OBS-004 is NOT IMPLEMENTED** — none of the four literal limbs exist; this does not block G1-3 acceptance per the task brief's own explicit statement.

## 15. Distributed tracing — NFR-OBS-002

**NOT IMPLEMENTED.** No spans, no propagation, no export exist anywhere in this change. Correlation/causation ids (§5) are explicitly a DIFFERENT mechanism from distributed tracing — they let a human/log-search tool follow one causal chain across log LINES; they are not spans, carry no timing/parent-child span relationship, and are not exported to any tracing backend. No OpenTelemetry package or config file was added (the task brief explicitly forbids a placeholder counting as completion, and none exists here to even mistake for one).

## 16. Per-tenant support health — NFR-OBS-007

**NOT IMPLEMENTED.** No support-facing per-tenant health surface (API endpoint, dashboard, or otherwise) was built. No tenant UUID is exposed as a Prometheus label anywhere (verified — see §9's exact label list: `method`, `route`, `handler`, `status_class` only). Building a genuine support health view without a reviewed authorization model was explicitly out of this slice's scope.

## 17. NFR-OBS-001 / NFR-OBS-003 / NFR-OBS-005 evidence-based disposition

See §19 for the full requirement-by-requirement table with evidence pointers. In summary: **NFR-OBS-001 COMPLETE** (every application log — the 14 pre-existing `new Logger()` call sites via `app.useLogger()`, Nest's own framework logs, and every new completion/structured log — is structured JSON carrying tenant/branch/correlation/causation, honestly `null` where genuinely unknown; the only exclusion, CLI scripts, was never part of "application logs" to begin with and is explicitly out of the requirement's own scope). **NFR-OBS-003 COMPLETE** (real, scrapeable, bounded-cardinality RED metrics, per endpoint AND per handler, proven distinguishable, proven bounded under cardinality sabotage). **NFR-OBS-005 PARTIAL** — the structured allowlist-metadata channel is exhaustive and tested; the documented, irreducible gap is that a pre-existing free-form message string (any of the 14 `new Logger()` call sites, or a future one) can still contain an arbitrary value the layer cannot semantically parse, and only a best-effort pattern-based scrub covers a subset of shapes (Bearer tokens, DSNs, JWTs) inside such strings — this is stated honestly rather than claimed COMPLETE.

## 18. Performance / overhead (§20)

See §9's overhead paragraph for the microbenchmark numbers. Explicitly NOT claimed as SRS `NFR-PERF-030`/`031` proof by itself — those percentiles are proven or disproven by the RED histogram's own p95 measurement of REAL request traffic in a real deployment, which this slice provides the mechanism for but does not itself operate. What IS proven here: sanitisation is bounded, metric registration does not create a new series per request (proven twice — correctness in §9's cardinality test, and at 10,000-iteration volume in the overhead test), no synchronous DB call exists in the logging/metrics path (verifiable by import inspection — zero Prisma imports in `logging/` or `metrics/`), and no per-request network call to an observability backend exists (the internal exporter is pull-based/scrape-style, not push-per-request).

## 19. CI / G1-1 integration (§21)

No second CI workflow was created. The existing `npm test` / `npm run lint:check` / `npm run typecheck` / `npm run openapi:check` / `npm audit` commands the existing `.github/workflows/backend-ci.yml` `quality` job already runs all naturally pick up every new file in this slice (Jest's `rootDir: "src"` + `testRegex: ".*\\.spec\\.ts$"` picks up every new `*.spec.ts` under `src/common/observability/` automatically; ESLint's existing glob picks up every new `.ts` file automatically). `alert-rules.spec.ts`'s validation runs inside the same `npm test` invocation — no external service dependency, fully deterministic, fast (17 tests, well under a second). No existing gate was weakened.

## 20. Integration collision review (§29)

- **B1-3** (in-flight separately): touches `PermissionGuard`, controller decorators, tenant/security request flow. This slice makes **zero** controller-level edits and does not reimplement any scoped-RBAC logic — `TenantEnrichmentInterceptor` only ever READS `request.authorization.context` (a value B1-3's guards will keep populating exactly as `TenantContextGuard` does today), so B1-3 can freely change guard composition/ordering at the controller level without this slice needing to change.
- **D4-1B** (future): will add Sync production handlers. Because observability is wired centrally (`APP_GUARD` + `APP_INTERCEPTOR` + module-level middleware, all applied once at `AppModule` composition), any new controller/route D4-1B registers is observed automatically — structured completion logs, RED metrics, correlation context — with no bespoke per-domain logging/metrics call required. The "domain-event handler logging" half of §4 that this slice could not yet wire (because zero handlers exist today) becomes straightforward once D4-1B's handler substrate exists: a handler already receiving the event's real `correlationId`/`causationId` (per the domain-event envelope contract, §5.5.4) can pass them straight to `StructuredLoggerService.logEvent()`.

## 21. Verification results

All commands run live in this session, from the exact repository state described above (no prior/cached results reused).

- `git diff --check`: clean.
- `npx prisma validate`: schema valid (no schema change made).
- `npm run typecheck`: clean (0 errors), after the pre-implementation Prisma-client-regeneration fix noted in §1.
- `npm test` (unit, Jest `rootDir: src`): **76 suites / 1029 tests, all passing** (baseline pre-G1-3, post-Prisma-fix: 65 suites / 917 tests — the delta is entirely G1-3's own new `*.spec.ts` files: `correlation.spec.ts` 13, `observability-context.spec.ts` 6, `redaction.spec.ts` 27, `structured-logger.service.spec.ts` 5, `route-context.guard.spec.ts` 4, `tenant-enrichment.interceptor.spec.ts` 3, `metrics.service.spec.ts` 15, `metrics-exporter.service.spec.ts` 4, `alert-rules.spec.ts` 17, `observability-request-lifecycle.spec.ts` 15, `observability-overhead.spec.ts` 3 = 112 new tests, 917+112=1029 ✓).
- `src/modules/module-boundaries.spec.ts`: **45/45**, unchanged — this slice adds no `src/modules/**` import edge at all.
- `npm run openapi:check`: clean, zero drift — confirms the metrics exporter and every internal route/middleware addition are genuinely invisible to the public API surface, and (after the middleware-registration fix below) that no phantom catch-all route leaked into Express's real router.
- `npm run lint:check`: **48 errors / 3 warnings** (measured pre-implementation baseline was 49 errors / 3 warnings — verified by diffing the exact `file:line:column:ruleId` sets before and after: **zero new entries**; the count dropped by exactly 1 because this slice's own edit to `main.ts` incidentally reformatted a pre-existing baseline error's line via `prettier --write`, not because of any unrelated fix).
- `npm audit --omit=dev --audit-level=high`: **7 high / 1 moderate (8 total)**, identical package set before and after `prom-client` was added — **zero new advisories**.

### A real bug this verification pass found and fixed

The first implementation of `ObservabilityModule.configure()` applied `CorrelationMiddleware` via `consumer.apply(...).forRoutes({ path: '*', method: RequestMethod.ALL })`. Under Nest 11 + Express 5, `RequestMethod.ALL` maps to Express's `app.all(path, fn)`, which internally calls `Router.route(path)` — creating a **genuine, introspectable Express Route** bound to all five HTTP verbs, not plain connect-style middleware. This was caught by `test/openapi.e2e-spec.ts`'s live-route-vs-OpenAPI-drift check, which found a spurious `/{*path}` route (DELETE/GET/PATCH/POST/PUT) that no documented operation could match. **Fixed** by applying the middleware with a bare path string (`.forRoutes('*')`, no explicit `method`) — Nest's internal sentinel for "no method specified" resolves through `app.use()` instead, which is ordinary middleware (no `Router.route()` call, invisible to route introspection) while still running for literally every request, matched or not — exactly the property `CorrelationMiddleware` needs for the 404/"unmatched" completion-log case. Re-verified clean after the fix (`openapi.e2e-spec.ts` 31/31, `openapi:check` zero drift, full unit suite still 1029/1029). No other file was touched to fix this — the entire correction is the one line in `observability.module.ts`'s `configure()`.

### Targeted E2E (§23)

Run live, per-suite ephemeral database (G1-2 harness), all against `full-srs/lane-g2-observability` at this session's working tree:

- `test/e2e-db-isolation-config.e2e-spec.ts` — 1/1.
- `test/rbac.e2e-spec.ts`, `test/organisation.e2e-spec.ts`, `test/sales.e2e-spec.ts`, `test/app.e2e-spec.ts` — 131 tests across 5 suites (with `e2e-db-isolation-config`), run before the middleware-registration fix below; `test/openapi.e2e-spec.ts` (49 tests) — run alone immediately after the fix to confirm it, then re-confirmed together with `app.e2e-spec.ts`. **6 distinct suites / 180 tests total, all passing.**
- `test/audit.e2e-spec.ts`, `test/inventory.e2e-spec.ts`, `test/inventory-rls.e2e-spec.ts`, `test/inventory-exact-decimal-callers.e2e-spec.ts`, `test/sync-audit-contention.e2e-spec.ts`, `test/sync-causal.e2e-spec.ts`, `test/sync-crash-recovery.e2e-spec.ts`, `test/sync-idempotency.e2e-spec.ts`, `test/sync-protocol.e2e-spec.ts`, `test/sync-rls.e2e-spec.ts` — **10 suites / 130 tests, all passing**.
- Live captured structured JSON completion-log lines from this run (real HTTP, real DB, real `TenantContextGuard` resolution) confirm real tenant UUIDs, `null` branchId for non-POS dashboard sessions (correct per `TenantContext`'s own contract — a dashboard actor has no single operating branch), normalized route templates (`/orders/:businessDay/:id`, `/org/branches/:branchId/station-routing-rules`, `/auth/memberships/:membershipId/roles/:roleId`), and exact status-class classification across 200/201/204/400/401/403/404/409 responses — all in the excerpt captured during this session.
- Zero orphan `ros_test_e2e_*` databases after every one of these runs (each run's own sweep log confirms), persistent `ros` never touched by any of them.

### Full E2E (§23/§24)

Full E2E run (all 77 suites, `NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/jest-e2e.json`, G1-2 per-suite ephemeral DB harness):

**76/77 suites passed, 1280/1281 tests passed.**

One failure: `test/order-completion-performance.e2e-spec.ts` — `NFR-PERF-006 — Order Completion performance ... measures p50/p95 ... (>=20 iterations)`, threw `PrismaClientKnownRequestError: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5057 ms passed since the start of the transaction.` — a 57ms overshoot of a 5000ms interactive-transaction timeout while running alongside 76 other suites contending for the same Postgres instance's CPU/IO.

**Classification: C — known environmental/resource contention.** This is the SAME test the prior `MW1A` integration report already flagged as a pre-existing, time-sensitive `NFR-PERF-006` open item under full-suite contention, unrelated to any lane's content. Confirmed independently in this session: re-run alone (no contention from the other 76 suites), the identical suite **passed cleanly** — `p50=633.06ms p95=879.01ms (min=538.01ms max=895.56ms)` across 20 iterations, nowhere near the 5000ms transaction timeout. G1-3 adds no code on the `SaleDepletionService`/`stockLevel.update()` path this failure touches, and the observability middleware/guard/interceptor chain's own measured overhead (§9/§18) is sub-millisecond — nowhere near explaining a multi-second transaction-timeout overshoot. **Not Class A** (no correctness regression — the identical assertion passes standalone), **not Class B** (no DB-isolation issue — the per-suite ephemeral DB and cleanup both worked correctly; zero orphan `ros_test_e2e_*` databases after the run, only the template swept), **not Class D** (this is a previously-documented, previously-classified flake, not a new unexplained failure).

Zero orphan `ros_test_e2e_*` databases after the full run (sweep log confirms exactly the run's own template). Persistent `ros` never touched by any E2E run in this session (per-suite `DATABASE_URL`/`APP_DATABASE_URL` rewrite from the G1-2 harness, confirmed by `e2e-db-isolation-config.e2e-spec.ts` passing both before and after implementation).

## 22. Requirement disposition (§25)

| Requirement | Status | Evidence |
|---|---|---|
| **NFR-OBS-001** (structured JSON, tenant/branch/correlation/causation) | **COMPLETE** | Every application log path (14 pre-existing `new Logger()` sites via `app.useLogger()`, Nest's own framework logs, the new request-completion path) emits one JSON object with all four keys present, `null` when genuinely unknown. §4, §6, §8. |
| **NFR-OBS-002** (distributed tracing) | **NOT IMPLEMENTED** | No spans/propagation/export exist. §15. |
| **NFR-OBS-003** (RED per endpoint and per handler) | **COMPLETE** | `http_requests_total`/`http_request_duration_seconds`, bounded 4-label cardinality, endpoint-vs-handler distinguishability proven, cardinality-sabotage proven, real scrapeable exposure. §9, §10. |
| **NFR-OBS-004** (orders/min, sync backlog, fiscal failures, offline terminals) | **NOT IMPLEMENTED** | Zero of the four literal metrics exist; none fabricated. §14. |
| **NFR-OBS-005** (no PII/secrets, allowlist-enforced redaction) | **PARTIAL** | Allowlist metadata channel exhaustive and tested (27+ sabotage tests, real-logger-path proof); free-form message-string channel (pre-existing `new Logger()` call sites) has only best-effort pattern scrubbing, not exhaustive coverage — honestly not claimed COMPLETE. §7, §17. |
| **NFR-OBS-006** (alerts for every SLO breach + runbooks) | **PARTIAL** | 4 alert rules + 4 runbooks cover the backend API SLOs this slice's own metrics can measure; enumerated uncovered SLO classes remain (sync batch, uptime, client/offline, business metrics, durability). §12, §13. |
| **NFR-OBS-007** (per-tenant support health) | **NOT IMPLEMENTED** | No support-facing surface built. §16. |

## 23. Implementation commit

Subject: `feat(observability): establish logging and RED metrics` — implementation + tests + alert rules + runbooks + `prom-client` dependency/lockfile + `eslint.config.mjs` no-console gate, per the task's exact specified commit scope.

## 24. Report commit

This report + one `INDEX.md` row, subject: `docs: record observability baseline`.
