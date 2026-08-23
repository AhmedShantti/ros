# API-1A — OpenAPI 3.1 + External Base Path + Error Contract Verification

**Date:** 2026-08-23
**Branch:** `feat/production-spec`
**HEAD at start and end (unchanged — no commit made):** `ff589fa6a17297ed7368a844d719a195ff4294a8`
**Slice:** API-1A — NARROW CORRECTION / VERIFICATION ONLY on top of the accepted
Swagger/OpenAPI slice. No Fire, no Payment, no business-behaviour change, no
migration, no commit/push.
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of documentation/verification work
performed in this session. The ROS SRS and ratified governance decisions
remain the sole authority on what the API is *supposed* to be. Everything in
§I is a truthful classification of *current runtime behaviour*, not a claim
that the SRS requirement is satisfied — several are explicitly recorded as
gaps, not silently marked complete.

The prior slice's route inventory (131 operations), request DTO metadata,
success response schemas, bearer auth metadata, Idempotency-Key/If-Match
documentation, ETag documentation, BigInt/Decimal/date wire representations,
bidirectional drift detection, deterministic generation, and absence of
fictional Fire/Payment/Kitchen routes are **accepted and not reopened** —
verified unchanged in §L, not re-derived from scratch.

---

## A. STARTING STATE

- Branch `feat/production-spec`, HEAD `ff589fa` (unchanged throughout).
- Read `docs/reports/claude/2026-08-23_API_swagger-openapi-frontend-contract.md`
  and inspected the actual generated `docs/api/openapi.json`/`.yaml` and
  `src/scripts/generate-openapi.ts`/`src/swagger.config.ts` before making any
  change.
- **Read-only safety checks performed before any other action**:
  `git stash list` → empty. `git status --short` / `git diff --name-status` /
  `git diff --stat` → exactly the 17 files the prior Swagger slice's own
  report already described, no unexpected file. No `git stash`, `reset`,
  `checkout`, `restore`, `clean`, or `rebase` was used anywhere in this
  session (see §J for the one time it was used in the *prior* session).
- 26 migrations, `Database schema is up to date!` (read-only `prisma migrate
  status`, no migration applied — see §K).

---

## B. OPENAPI VERSION VERIFICATION

`docs/api/openapi.json`'s root `openapi` field was **`"3.0.0"`** — the
`@nestjs/swagger` default, never explicitly set by the prior slice.

Inspected whether the installed `@nestjs/swagger@11.4.6` can natively emit
3.1: **yes**. `DocumentBuilder.setOpenAPIVersion(version: string): this`
exists (`node_modules/@nestjs/swagger/dist/document-builder.d.ts`), and the
package internally gates 3.1-specific behaviour (webhooks inclusion) on its
own `isOas31OrLater()` util
(`node_modules/@nestjs/swagger/dist/utils/is-oas31-or-later.util.js`) — this
is first-class, maintained support, not an undocumented side door.

**Action taken**: added `.setOpenAPIVersion('3.1.0')` to the single shared
`buildSwaggerConfig()` in `src/swagger.config.ts` (used by both `main.ts` and
the generator, so they cannot disagree) — no replacement of a literal string
in the generated JSON, no second document. Verified: `docs/api/openapi.json`'s
`openapi` field is now `"3.1.0"`.

**Permanent test added**: `the root openapi value is exactly 3.1.x (SRS
NFR-API-001)` in `test/openapi.e2e-spec.ts`.

---

## C. OPENAPI 3.1 CORRECTION

`setOpenAPIVersion` alone does **not** make the document valid 3.1: it only
changes the `openapi` field and a couple of internal generation branches
(webhooks). It does **not** touch how `@nestjs/swagger`'s CLI plugin or
`@ApiProperty({nullable: true})` express nullability — confirmed by reading
`node_modules/@nestjs/swagger/dist/services/swagger-types-mapper.js`, which
passes `nullable` straight through unconditionally on OAS version. That
correction is §D.

No second, hand-maintained OpenAPI document was created. The correction is a
deterministic structural post-process (`src/common/openapi/oas31.util.ts`,
`finalizeOpenApiDocument()`) applied to the document `SwaggerModule.
createDocument()` already built from real controller/DTO metadata, called
from **both** `main.ts` (live `/docs` UI) and `src/scripts/generate-openapi.ts`
(standalone generator) so they never diverge.

---

## D. NULLABILITY / JSON SCHEMA 2020-12

**Audit**: every `nullable: true` occurrence in the pre-correction document
was enumerated programmatically (not sampled): **330 occurrences**, all
inside inline response schemas built by the prior slice's
`src/common/openapi/schema-helpers.ts` `nullable()` helper (**zero** inside
`components.schemas`, i.e. **zero** came from CLI-plugin-synthesized DTO
metadata). Every single occurrence carried a sibling `type` key (no bare
`nullable`-only schema, no `nullable` combined with `$ref` anywhere in this
document today).

**Structural transformation, not textual regex** — `nullableToJsonSchema2020()`
in `src/common/openapi/oas31.util.ts` walks the parsed document tree
(`components.schemas`, every `paths[...][method].requestBody`/`.responses[...]`
schema, recursively through `properties`/`items`/`allOf`/`oneOf`/`anyOf`) and:

- primitive `{type: 'string', nullable: true}` → `{type: ['string', 'null']}`
- object `{type: 'object', properties: {...}, nullable: true}` →
  `{type: ['object', 'null'], properties: {...}}` (properties preserved
  verbatim — verified on `nextCursor` below)
- array `{type: 'array', ..., nullable: true}` → `{type: ['array', 'null'], ...}`
  (same rule, none exist in the current document but the function handles it
  generically)
- enum `{type: 'string', enum: [...], nullable: true}` → `{type: ['string',
  'null'], enum: [...values, null]}` — `null` is appended to `enum` itself,
  not just the `type` union, because JSON Schema's `enum` is an independent
  restriction that would otherwise still forbid the value `null` even with a
  permissive `type`. Verified on `Modifier.kind` below.
- `$ref` + `nullable` → `{anyOf: [{$ref}, {type: 'null'}]}` (implemented
  defensively; **zero live occurrences** of this combination exist today,
  confirmed by the same audit — recorded so a future DTO property typed
  `SomeClass | null` doesn't silently regress).

All other keys (`description`, `example`, `format`, `pattern`, `enum`
non-null values, `required`, nested `properties`/`items`) are preserved
byte-for-byte; only `nullable` is removed and `type`/`enum` adjusted.

**Verified output, spot-checked on 3 representative fields**:

```jsonc
// primitive: Order.tableId (was {type:"string", format:"uuid", nullable:true})
{ "type": ["string", "null"], "format": "uuid", "example": "3fa85f64-..." }

// enum: Modifier.kind (was {type:"string", enum:[...3 values], nullable:true})
{ "type": ["string", "null"], "enum": ["addition", "removal", "substitution", null],
  "description": "FR-POS-021. null on a legacy modifier..." }

// object-with-properties: ListOrders.nextCursor (was {type:"object", properties:{...}, nullable:true})
{ "type": ["object", "null"], "properties": { "businessDay": {...}, "id": {...} },
  "description": "Pass businessDay as cursorBusinessDay..." }
```

**Post-correction, whole-document grep for the literal string `"nullable"`:
zero matches.**

**Permanent tests added**: "no schema anywhere in the document still uses the
OpenAPI-3.0-only `nullable` keyword" (whole-document regex assertion), "a
nullable primitive field retains its runtime nullability as a JSON Schema
2020-12 type union", "a nullable enum field lists null in its enum values
under the type union".

---

## E. 3.1 VALIDATION

**Dependency decision**: `ajv`/`ajv-formats` were already present
(transitive), but nothing that validates a document *against the OpenAPI 3.1
meta-schema specifically*. Evaluated two candidates
(`@seriousme/openapi-schema-validator` vs `@readme/openapi-parser`) by
`npm view ... dependencies` before choosing — picked
**`@seriousme/openapi-schema-validator@2.9.1`** (5 packages total, all
`ajv`-family) over `@readme/openapi-parser` (7 packages, adds
`@apidevtools/json-schema-ref-parser` + `@readme/better-ajv-errors`) as the
narrower, purpose-built option: it validates against the official OpenAPI
2.0/3.0/3.1/3.2 meta-schemas and exposes `resolveRefs()` for dereferencing,
which is all this slice needs. Installed **dev-only**. `npm audit`'s 5
pre-existing high-severity findings (nested `js-yaml` inside `@nestjs/swagger`,
`deepmerge-ts` inside `@prisma/config`) are unrelated to this addition —
confirmed by diffing which packages the audit blames before and after.

**Proven, in this session, against the final document**:

- `res.valid === true`, `validator.version === '3.1'` — real meta-schema
  validation, JSON **and** YAML both independently validated.
- `validator.resolveRefs()` completes without throwing — an independent
  dereferencing pass, on top of this suite's own regex-based `$ref`
  resolution check (kept — it's simpler and already passing, not replaced).
- JSON/YAML structural equality — `js-yaml.load(yaml) === JSON.parse(json)`
  (`toEqual`).
- No duplicate `operationId`s (131/131 unique — unchanged from the prior
  slice).
- No duplicate parameters, **case-insensitive for headers** — new whole-document
  check (§L confirms zero, matching the prior slice's manual verification of
  the same fact, now a standing test rather than a one-time check).
- **Frontend TypeScript tooling can parse it**: ran
  `npx --yes openapi-typescript docs/api/openapi.json -o <tmp>` (no install,
  no commit) — succeeded in 171.7ms, produced 13,239 lines of real,
  non-empty TypeScript types covering all 131 operations. File deleted
  immediately after inspection; **no SDK generated or committed**, per the
  explicit non-goal.

---

## F. EXTERNAL /v1 BASE-PATH VERIFICATION

Inspected, in this order: `src/main.ts` (no `app.setGlobalPrefix` call
anywhere), whole-`src/` grep for `/v1` (three controller doc-comments
*assert* the deployment claim; zero runtime code implements it; one
pre-existing unit-test fixture literally uses `/v1/orders` as a path string,
unrelated to real routing), `docker-compose.yml` (defines only the local
Postgres `db` service — no app container, no reverse proxy, no nginx), `find
. -iname "*docker*" -o -iname "*nginx*" -o -iname "*proxy*"` (nothing beyond
the one `docker/postgres/init/` script), `README.md` (generic NestJS
boilerplate — Mau/AWS deployment docs, nothing ROS-specific), `.env.example`
and `src/config/env.validation.ts` (no prefix/base-path environment variable
of any kind).

**Classification** (both apply, at different layers):

- **C. /v1 IS NOT IMPLEMENTED TODAY** — at the application layer. No
  `setGlobalPrefix`, no per-controller `/v1` segment, confirmed exhaustively.
- **D. NOT SOURCE/REPOSITORY DECIDABLE** — at the deployment layer. The
  three controller comments' claim that "`/v1` is applied at deployment" is
  an *assertion*, not verifiable infrastructure: this repository contains no
  proxy/gateway/CI-deployment configuration of any kind that could confirm
  or refute it.

**Action taken**: added an explicit `servers` entry to the `DocumentBuilder`
config — `addServer('/', '<explanation>')` — documenting the actually-verified
relative root, **not** a guessed `/v1`. The description explains the SRS
requirement, the confirmed absence of an application-level prefix, and the
repository's inability to confirm a deployment-level one, and tells the
reader to confirm the real base URL with deployment/ops. `docs/api/README.md`
carries the same explanation for a frontend engineer who never reads the
OpenAPI document's `servers[0].description` field. No runtime routing was
changed — `setGlobalPrefix` was **not** added.

**Permanent test added**: "the servers array documents the real, verified
base — not a fabricated /v1" (`servers[0].url === '/'`).

**SRS GAP recorded**: SRS §26.1 URL versioning (`/v1`) is not implemented by
this application. See §I.

---

## G. ERROR BODY RUNTIME AUDIT

**Static audit**: exactly **one** exception filter exists in the entire
codebase — `src/modules/sales/sales-domain-exception.filter.ts`, registered
via `APP_FILTER` (which makes it **application-global**, not Sales-scoped,
despite living in the Sales module — confirmed by reading `sales.module.ts`'s
provider registration, a real Nest behaviour worth flagging explicitly since
it's easy to misread as module-scoped). It `@Catch()`es exactly 6 domain
error classes (`OrderStateError`, `TaxClassUnavailableError`,
`TaxComputationError`, `RecipeCostError`, `CountryPackUnavailableError`,
`BusinessDayError`) and maps `OrderVersionConflictError` → 409, everything
else it catches → 422, via `new HttpException({statusCode, message:
error.message, error: error.name}, status)`. No other filter, no global
response-reshaping interceptor, exists anywhere (`grep -rln "createBody\|
APP_INTERCEPTOR\|implements ExceptionFilter" src/` returns only the
idempotency interceptor — which doesn't touch error bodies — and this one
filter).

**Runtime ground-truth** (a throwaway `test/_probe.e2e-spec.ts` was written,
run once against a live bootstrapped app via `supertest`, and **deleted
immediately after** — confirmed via `git status --short test/` showing only
the legitimate `openapi.e2e-spec.ts`):

| Call | Status | Body |
|---|---|---|
| `POST /auth/login {}` (ValidationPipe) | 400 | `{"message":["email must be...", ...5 strings],"error":"Bad Request","statusCode":400}` |
| `GET /auth/me` no token (`new UnauthorizedException()`, **no message arg**) | 401 | `{"message":"Unauthorized","statusCode":401}` — **no `error` key** |
| `POST /auth/login` wrong password (`new UnauthorizedException('Invalid credentials')`) | 401 | `{"message":"Invalid credentials","error":"Unauthorized","statusCode":401}` |
| `POST /auth/pin` unknown tenant/terminal | 401 | `{"message":"Invalid PIN, terminal or employee.","error":"Unauthorized","statusCode":401}` |

**Finding, confirmed empirically not just by reading source**: the envelope
is **not** perfectly uniform. A bare zero-argument `new
UnauthorizedException()` produces a 2-key body (no `error`); every other
observed exception (1-argument-string constructor — the overwhelming
majority of throw sites across the whole app, plus the domain filter, plus
`ValidationPipe`, plus `ThrottlerException`) produces the 3-key body. This
matches Nest's own `HttpException.createBody` behaviour by construction, not
an ROS-specific inconsistency.

**Classification (§ instructed A/B/C/D)**: **C. Nest default shapes in some
paths** — with the specific, verified irregularity above. Not D (this is not
RFC 7807 anywhere in the live runtime — no `type`/`title`/`detail`/`instance`
fields exist in any observed or read-through-source response). Not A (there
is real variance, not one perfectly stable schema) — but the variance is
narrow and characterizable, not chaotic: `statusCode` and `message` are
**always** present; `error` is **sometimes** absent; `message` is a string
except under `ValidationPipe`, where it's a string array.

---

## H. ERROR SCHEMA DOCUMENTATION

**Design decision**: 162 individual `@Api*Response({description})` call
sites already exist across the 12 controllers (mostly class-level, some
method-level) for the relevant statuses — hand-editing every one to add an
identical `schema:` would be 162 near-duplicate literal edits, directly
against the "prefer reusable component schemas rather than 100 copies"
instruction, and a poor match for how uniform the real shape is (§G). Instead:
a single reusable component, `ErrorResponse`, is registered once in
`components.schemas` by the same `finalizeOpenApiDocument()` post-process
(§C), and every documented 400/401/403/404/409/422/429 response that has **no
existing body content** (verified: none of the 162 sites had one — confirmed
by `grep -A1 "@ApiBadRequestResponse({" | grep schema:` returning nothing
before this change) gets a `content: {'application/json': {schema: {$ref:
'#/components/schemas/ErrorResponse'}}}` filled in automatically. A response
that already carries an explicit `content` is left untouched (none currently
do, but the guard is there for future-proofing).

```json
"ErrorResponse": {
  "type": "object",
  "required": ["statusCode", "message"],
  "properties": {
    "statusCode": {"type": "integer"},
    "message": {"oneOf": [{"type": "string"}, {"type": "array", "items": {"type": "string"}}]},
    "error": {"type": "string", "description": "... Not always present."}
  }
}
```

`message` as `oneOf[string, string[]]` and `error` as **optional** are
deliberate, truthful reflections of §G's findings — not a simplification
that papers over the real variance.

**Coverage, measured on the final document**: 392 of 392 documented
400/401/403/404/409/422/429 responses across the whole document now carry
this schema (401: 129, 403: 120, 404: 87, 409: 29, 400: 19, 429: 6, 422: 2 —
the 422 count reflects how many routes the prior slice's forks had already
annotated with `@ApiUnprocessableEntityResponse`; this slice did not expand
*which* routes document which status, only *what body* an already-documented
status carries).

**Permanent tests added**: representative 400 (on `POST /orders`), 401+403
(on `GET /auth/me` / `POST /orders`), 409+422 (on `POST
/orders/{businessDay}/{id}/lines`) — each asserts the response's schema is
exactly the `ErrorResponse` `$ref`.

---

## I. API PLATFORM SRS GAPS (REPORT ONLY — NOTHING BELOW WAS IMPLEMENTED)

| Requirement | Classification | Evidence |
|---|---|---|
| **NFR-API-001** OpenAPI 3.1 generated from implementation | **COMPLETE** (this slice) | §B–§E |
| **FR-API-001** stable machine-readable error code | **NOT IMPLEMENTED** | Zero source references anywhere. The `error` field in `ErrorResponse` is an HTTP reason phrase or exception class name, inconsistent in presence (§G) — not a documented, stable, per-domain error-code enum. |
| **FR-API-002** error message localisation | **NOT IMPLEMENTED** | Zero source references. Every observed/read error message is a hardcoded English string; no i18n/locale mechanism exists for error bodies anywhere in the codebase. |
| **FR-API-020** Idempotency-Key mandatory on POST/PATCH | **PARTIAL** | 72 live mutating operations (61 POST + 10 PATCH + 1 PUT); exactly **3** enforce `Idempotency-Key` — `POST /orders`, `POST /orders/{businessDay}/{id}/lines`, `POST /cash-sessions`. These 3 ARE the genuinely transactional/financially-significant ones (order open, line capture, cash-drawer open). Not covered, and consequential: `POST /inventory/movements`, `POST /inventory/transfers`, `POST /inventory/counts`, `POST /inventory/waste` (stock-affecting), all `catalogue` price-list/price-entry mutations (pricing configuration), and 60+ others. |
| **FR-API-021** idempotency record retained ≥30 days | **IMPLEMENTED** (for the 3 covered routes) | `idempotency.service.ts` line 6/73, direct retention-window logic. |
| **FR-API-022** replay returns stored response + `Idempotent-Replay` header | **IMPLEMENTED** (for the 3 covered routes) | `idempotency.service.ts`/`idempotency.interceptor.ts`, verified in the prior slice and unchanged here. |
| **FR-API-023** fingerprint mismatch → 409 | **IMPLEMENTED** (for the 3 covered routes) | `idempotency.service.ts` — `ConflictException`, verified. |
| **§26.1 URL /v1 versioning** | **NOT IMPLEMENTED** (app); **NOT REPOSITORY-DECIDABLE** (deployment) | §F. |
| **If-Match / ETag convention** | **PARTIAL** | Implemented and documented on exactly 2 (If-Match) / 4 (ETag) Sales `orders` routes; no other resource in the API carries optimistic-concurrency versioning or an ETag. |
| **X-Correlation-Id convention** | **NOT IMPLEMENTED** (HTTP layer) | Zero `X-Correlation-Id`/`correlation-id` HTTP header handling anywhere (`grep` across `src/`, excluding the internal domain-events system). A `correlationId` field exists, but only inside the internal, non-HTTP domain-event envelope (`src/common/domain-events/domain-event.types.ts`) — a different, unrelated mechanism. |
| **§26.2 RFC 7807 error model** | **NOT IMPLEMENTED** | §G — confirmed empirically via real HTTP responses; the runtime envelope is Nest's default `{statusCode, message, error?}`, not `{type, title, status, detail, instance}`. |
| **Rate-limit headers** | **IMPLEMENTED, but undocumented** | `@nestjs/throttler`'s built-in `X-RateLimit-Limit/-Remaining/-Reset` (default `setHeaders: true`, confirmed in `throttler.guard.js`) fire on every route using `AuthThrottlerGuard` (`auth.controller.ts` login/pin/refresh, `password.controller.ts` change/forgot/reset). Not added to the OpenAPI document in this slice — recording only, per this slice's non-goals; a documentation gap, not an implementation gap. |

No item in this table was implemented, fixed, or "papered over" by this
slice — every PARTIAL/NOT IMPLEMENTED classification is reported as-is.

---

## J. PROCESS DEVIATION — PRIOR GIT STASH

**PREVIOUS SESSION PROCESS DEVIATION: CONFIRMED.**

The prior report
(`2026-08-23_API_swagger-openapi-frontend-contract.md`, §P) states its
TypeScript baseline was verified by "stashing this slice's entire diff and
reproducing the identical error against the unmodified tree" — this is a
direct, literal description of using `git stash` (and, necessarily, `git
stash pop` to restore). The same report's §S separately states "No
destructive git command was run" — a genuine contradiction, exactly as
flagged. `git stash` is not on the destructive-command list this project
already prohibits (`push --force`, `reset --hard`, `checkout .`, `restore .`,
`clean -f`, `branch -D`) but **is** explicitly forbidden by this correction
task's own rules, and the prior session's own §S claim was simply wrong.

**Current, read-only verification** (this session, before any other action):

```
$ git stash list
(empty)
```

**No stash entry exists.** The stash-then-pop in the prior session completed
successfully at the time (its own tool output showed `Dropped
refs/stash@{0}...` and a `git status` matching the pre-stash state) — this
is corroborated, not just assumed, by the fact that `git stash list` is
empty now and the working tree's diff exactly matches what the prior report
describes having produced (§A, §L). No data was lost. This is a confirmed
**process** deviation (a forbidden command was used), not a data-loss
incident, and per this task's explicit instruction it is recorded here, not
undone (there is nothing to undo) and not reconstructed.

---

## K. DATABASE TARGET — PRIOR MIGRATE DEPLOY

**Resolved factually**, without applying any migration in this session:

`prisma.config.ts` reads `DATABASE_URL` from `.env`. Its value (password
redacted): `postgresql://ros_migrator:***@localhost:5544/ros?schema=public`.
`docker-compose.yml` defines exactly one service, `db` (container
`ros-postgres`), publishing container port 5432 to host port **5544** — the
same port in `DATABASE_URL`. This container mounts a **named, persistent**
Docker volume (`ros-pgdata:/var/lib/postgresql/data`), not a `tmpfs` or
per-run ephemeral volume — meaning it survives `docker compose down`/restart
and accumulates state across sessions (independently observed in this same
session: the container reported "Up 7 days" before any action was taken).

**There is no second, separate "scratch" database configured anywhere in
this repository** — no alternate `.env` profile, no test-specific
`DATABASE_URL` override, no `docker-compose.override.yml`. `DATABASE_URL` is
the **only** configured local target, for both the app and `prisma migrate`.

**DATABASE MIGRATED IN PRIOR SWAGGER RUN: local dev** — the prior report's
"scratch DB" label was inaccurate/informal; the 11 migrations `prisma migrate
deploy` applied in that session went onto this same persistent local-dev
Postgres container, not a disposable one. This is recorded here as a prior
process-evidence correction, not undone: the 11 migrations were already
authored and already committed to the repository before that session ran
(none were created by it), `prisma migrate deploy` only applied forward
schema changes already checked in, and no data was mutated or rolled back.

**CURRENT LOCAL DEV MIGRATION STATUS** (read-only, this session):

```
$ npx prisma migrate status
26 migrations found in prisma/migrations
Database schema is up to date!
```

No migration was applied, rolled back, or created in this session. Migration
count: **26**, unchanged.

---

## L. ROUTE / SCHEMA REGRESSION

Confirmed unchanged from the prior slice, measured on the final document:

- **131 operations / 93 paths** — identical count to the prior report.
- **131/131 unique `operationId`s** — no duplicates, unchanged.
- **Zero duplicate parameters**, case-insensitive for headers, across the
  **entire** document — checked programmatically (not just the 3
  idempotency-key/2 if-match routes the prior slice manually verified); now
  a standing test rather than a one-time check.
- **125/131 operations carry security metadata**, same 6 public exceptions
  (`GET /health`, `POST /auth/login`, `POST /auth/pin`, `POST /auth/refresh`,
  `POST /auth/password/forgot`, `POST /auth/password/reset`) — unchanged.
- **119/131 operations carry a response body schema** (91%; the other 12 are
  genuine `204`s) — unchanged.
- `CreateOrderDto`/`PinLoginDto` required fields — unchanged, re-asserted.
- No Fire/Payment/refund/bump/recall/Kitchen path — unchanged, re-asserted
  by regex across the full path set.
- ETag/Idempotency-Key/If-Match documentation on the same 3/2/4 routes
  respectively — unchanged (only their header-name casing and response
  `content` were touched by §D/§H's structural post-process, not their
  presence or the routes they apply to).

No controller's request/response DTO wiring, permission, guard, or business
logic was touched. `git diff --stat` for this slice touches exactly:
`src/swagger.config.ts`, `src/main.ts`, `src/scripts/generate-openapi.ts`,
one new file (`src/common/openapi/oas31.util.ts`), `package.json`/
`package-lock.json` (one new devDependency), `test/openapi.e2e-spec.ts`
(additive), and the two regenerated `docs/api/` artifacts — **zero**
controller files were edited in this correction slice (§C/§D/§H's changes
are all applied by the shared post-process, not by touching per-route
decorators).

---

## M. DETERMINISM

Proven exactly as the prior slice proved it, re-run against the corrected
document:

```
Run 1  openapi.json  sha256: f5f1c24be6d6fe7d5ef76577cc4fdaeb316bfbf1bc7e66fc3d6b20d09404ab2d
Run 2  openapi.json  sha256: f5f1c24be6d6fe7d5ef76577cc4fdaeb316bfbf1bc7e66fc3d6b20d09404ab2d  (identical)
```

(YAML hash matched identically across both runs too; both full `sha256sum`
files diffed empty.) `npm run openapi:check`'s own mechanism was proven
**both directions** in this session: staged the correct, current artifacts
→ `openapi:check` exit **0**; then deliberately staged a corrupted
`{"tampered": true}` in place of `docs/api/openapi.json` and re-ran
`openapi:check` → it regenerated the correct document and `git diff
--exit-code` correctly reported the difference, **exit 1** (verified via a
direct `$?` capture, not through a pipe to `tail`, which had silently
masked the real exit code on a first attempt at this proof) — then restored
the correct file and re-confirmed exit 0. This directly satisfies §11 item
22 ("openapi:check detects artifact drift") as a real, both-directions proof
rather than an assumption.

---

## N. TESTS

`test/openapi.e2e-spec.ts` grew from 17 to **31 tests**, all passing. Mapped
against this task's 22-item list:

1. root `openapi` is 3.1.x — new, §B.
2. document validates as OpenAPI 3.1 (`@seriousme/openapi-schema-validator`) — new, §E.
3. JSON/YAML deep-equal — pre-existing, re-verified.
4. all `$ref`s resolve — pre-existing regex check **plus** new independent validator-based `resolveRefs()` check, §E.
5. no duplicate `operationId`s — pre-existing, re-verified.
6. no duplicate parameters, case-insensitive for headers — **new**, whole-document, §H/§L.
7. every live route is documented — pre-existing drift-detection test, re-verified.
8. every documented route is live — pre-existing drift-detection test, re-verified.
9. no Fire path — pre-existing, re-verified.
10. no Payment path — pre-existing (same test as #9), re-verified.
11. no Kitchen HTTP path — pre-existing, re-verified.
12. protected route metadata correct — pre-existing, re-verified.
13. request required fields correct — pre-existing (`CreateOrderDto`/`PinLoginDto`), re-verified.
14. money-string schema correct — **new**, explicit assertion (`grandTotal` pattern/type), §L.
15. Decimal-string schema correct — **new**, explicit assertion (`quantity` pattern/type).
16. `businessDay` stays `YYYY-MM-DD` — **new**, explicit assertion.
17. nullable schemas retain semantics under 3.1 — **new**, 3 tests (no bare `nullable` keyword; primitive type-union; enum+null).
18. representative 400 error body documented correctly — **new**, §H.
19. representative 401/403 error body documented correctly — **new**, §H.
20. representative 409/422 error body documented correctly — **new**, §H.
21. generation remains deterministic — proven manually (§M), not a per-CI-run test, by design (documented rationale in the test file's own header comment — a `nest build` round-trip inside every `jest` run would be prohibitively slow for a fact that doesn't change between commits).
22. `openapi:check` detects artifact drift — proven manually, both directions (§M).

Additionally re-ran, unchanged from the prior slice: `module-boundaries.spec.ts`
(17/17), full unit suite (**702/702**, 51 suites), `npx tsc --noEmit` (clean
except the pre-existing, unrelated `access-token.service.spec.ts` error —
confirmed still present and still unrelated by direct output inspection),
`npx eslint` on every changed file (zero errors/warnings), `npx prisma
validate` (schema valid). **Full e2e was not re-run in this slice** — no
runtime/business behaviour changed (§L confirms the change surface is
limited to `main.ts`'s Swagger wiring, the generator, one new pure-function
utility module, and test/doc files), consistent with this task's own §12
instruction that full e2e is optional when only Swagger metadata/generation
changes. The prior slice's own full e2e run (630/630) stands as the last
full-suite baseline and is cited, not re-claimed as freshly run.

---

## O. FILES CHANGED (this slice only)

- `src/swagger.config.ts` — `.setOpenAPIVersion('3.1.0')`, `.addServer('/', ...)`.
- `src/main.ts` — wraps `SwaggerModule.createDocument(...)` in `finalizeOpenApiDocument(...)`.
- `src/scripts/generate-openapi.ts` — same wrapping.
- `src/common/openapi/oas31.util.ts` — **new**. Nullable→JSON-Schema-2020-12
  transform, `ErrorResponse` component + auto-fill, `finalizeOpenApiDocument()`.
- `test/openapi.e2e-spec.ts` — 14 new tests (17 → 31), one new helper
  (`responseSchema()`), updated type definitions.
- `docs/api/README.md` — new "Base URL" and "Error response bodies" sections.
- `docs/api/openapi.json` / `openapi.yaml` — regenerated (3.1.0, no
  `nullable` keyword, `ErrorResponse` component + 392 filled references,
  `servers: ['/']`).
- `package.json` / `package-lock.json` — one new devDependency,
  `@seriousme/openapi-schema-validator@^2.9.1`.
- This report; `docs/reports/claude/INDEX.md` updated.

**Zero controller files edited.** Zero DTOs, services, guards, filters, or
permissions touched. Zero migrations created (26 unchanged).

---

## P. EXIT

- OPENAPI 3.1 VALID: **YES**
- LIVE ROUTE COVERAGE: **YES** (131/131 unchanged, verified via bidirectional drift detection)
- ERROR BODY CONTRACT DOCUMENTED: **YES** (truthfully, as Nest's real
  `{statusCode, message, error?}` envelope — **not** RFC 7807, which remains
  NOT IMPLEMENTED at runtime per §I; the documentation accurately reflects
  that gap rather than concealing it)
- EXTERNAL BASE PATH DECIDED: **NOT REPOSITORY-DECIDABLE** (application:
  confirmed NOT implemented; deployment: cannot be confirmed from this
  repository — see §F. The document's `servers` entry documents the
  verified relative root, `/`, honestly)
- FRONTEND-USABLE CONTRACT: **YES** (valid OpenAPI 3.1, all refs resolve,
  parses cleanly under real frontend TypeScript tooling — §E)
- API-1A OVERALL COMPLETE: **YES**

---

## Q. COMMIT READINESS

**COMMIT READY: YES**
**COMMITTED: NO** — no commit or push was performed, per this task's
explicit instructions. `docs/api/openapi.json`/`openapi.yaml` are currently
**staged** (`git add`ed) as a byproduct of proving `openapi:check`'s
drift-detection behaviour in both directions (§M) — this is a non-destructive,
reversible index state, not a commit; no forbidden command (`stash`, `reset`,
`checkout`, `restore`, `clean`, `rebase`) was used to manage it, and none of
those commands were needed to avoid committing.

---

## R. FRONTEND HANDOFF

```
FRONTEND JSON: docs/api/openapi.json
FRONTEND YAML: docs/api/openapi.yaml
GENERATION:    npm run openapi:generate
DRIFT CHECK:   npm run openapi:check
```

**Base URL convention**: the document's `servers` entry is `/` (relative
root, no path prefix). SRS §26.1 specifies `/v1` URL versioning; this
application does not implement it, and this repository has no
deployment/proxy configuration to confirm whether an external layer adds
one. **A frontend integrator must confirm the actual deployed base URL with
deployment/ops** — do not assume `/v1` from the SRS alone, and do not
hard-code it into a generated client. See `docs/api/README.md`'s "Base URL"
section for the same guidance in a place a frontend engineer is more likely
to read it than this report.

---

## Non-goals confirmed respected

Idempotency gaps (§I) were recorded, not fixed. No `/v1` runtime prefix was
added. Global exception handling was not redesigned (`SalesDomainExceptionFilter`
and Nest's defaults are unchanged — only *documented*). RFC 7807 was not
implemented. Correlation-ID middleware was not implemented. Rate-limit
headers were not implemented (they already existed via `@nestjs/throttler`;
this slice did not newly document them either, per scope). Fire/Payment were
not implemented. No migration was created. `git stash` was not used. The dev
database was not mutated (§K — read-only status check only). No commit, no
push.
