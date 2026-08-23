# API — Swagger / OpenAPI Frontend Contract

**Date:** 2026-08-23
**Branch:** `feat/production-spec`
**HEAD at start and end (unchanged — no commit made):** `ff589fa6a17297ed7368a844d719a195ff4294a8`
**Slice:** API CONTRACT / SWAGGER / OPENAPI AUDIT + GENERATION — documentation-only (no business feature, no Fire, no Payment, no schema change, no commit)
**Report author:** Claude (Sonnet 5), per the repository's `CLAUDE.md` reporting policy

This report is non-authoritative evidence of documentation work performed in
this session. The ROS SRS and ratified governance decisions remain the sole
authority on what the API is *supposed* to be; this report and the generated
`docs/api/openapi.json`/`openapi.yaml` describe only what the API *currently
is*, mechanically derived from `@nestjs/swagger` metadata on the live
controllers in this repository. Nothing here elevates, supersedes, or
substitutes for the SRS.

---

## A. STARTING STATE / SCOPE

- Branch `feat/production-spec`, HEAD `ff589fa` (unchanged throughout — no
  commit made in this slice).
- Prior state: `@nestjs/swagger@^11.4.6` was already a dependency and already
  wired in `src/main.ts` (`SwaggerModule.setup('docs', ...)`, live at
  `/docs`), but with a stale `DocumentBuilder` (`title: 'ROS Identity API'`,
  a description mentioning only auth) — a leftover from an earlier,
  identity-only phase of the project — and with **no** `@nestjs/swagger` CLI
  plugin configured in `nest-cli.json`, **no** standalone generation script,
  and **no** exported `docs/api/` artifacts.
- Task: produce frontend-consumable `openapi.json`/`openapi.yaml` for
  **exactly** the live/implemented HTTP surface of this repository — no
  Fire, Payment, Completion, or KDS bump/recall routes (none exist), no
  invented endpoints, no behavior change — plus a repeatable generation
  command, full documentation coverage, drift-detection tests, and this
  report. 26 migrations, 702 unit / 630 e2e tests passing at the start
  (confirmed against a freshly-migrated scratch DB during this session —
  see §P).

---

## B. EXISTING SWAGGER AUDIT (BASELINE FINDINGS)

Before adding anything, every controller was audited for existing `@Api*`
decoration (`grep -c "@Api"` per file). Finding: **every one of the 12
controllers already carried class-level `@ApiTags(...)`**, and most also
carried `@ApiBearerAuth()` + `@ApiUnauthorizedResponse`/`@ApiForbiddenResponse`/
`@ApiNotFoundResponse` at the class level — an already-established, consistent
prior-session convention, not something this slice needed to add from
scratch. The actual gap was narrower than a cold-start audit would assume:

- Per-method `@ApiOperation` summaries — partially present as bare
  `description:` strings inside existing `@ApiOkResponse`s, mostly absent.
- Response **body schemas** (`schema:`/`type:`) — absent everywhere; only
  bare human-readable descriptions existed.
- Explicit header docs for the 3 idempotent + 2 If-Match routes — absent.
- `POST /auth/pin` had **zero** `@Api*` decorators at all — the one clear,
  specific, fully-undocumented route in the whole API. Fixed in this slice.

---

## C. LIVE ROUTE INVENTORY

12 controllers, 93 distinct paths, 131 HTTP operations, verified by reading
every controller file (not inferred from the SRS):

| Tag | Controller | Operations |
|---|---|---|
| `catalogue` | `catalogue.controller.ts` (`/catalogue`) | 38 |
| `organisation` | `organisation.controller.ts` (`/org`) | 31 |
| `inventory` | `inventory.controller.ts` (`/inventory`) | 22 |
| `production` | `production.controller.ts` (no prefix — `/recipes`, `/substitute-groups`) | 10 |
| `terminals` | `terminal.controller.ts` (`/auth`) | 6 |
| `rbac` | `rbac.controller.ts` (`/auth`) | 6 |
| `auth` | `auth.controller.ts` (`/auth`) | 5 |
| `sales` | `orders.controller.ts` (`/orders`) | 5 |
| `password` | `password.controller.ts` (`/auth/password`) | 3 |
| `tenants` | `tenant.controller.ts` (`/auth`) | 3 |
| `treasury` | `treasury.controller.ts` (`/cash-sessions`) | 1 |
| `health` | `health.controller.ts` (`/health`) | 1 |
| **Total** | | **131** |

Confirmed absent (verified, not assumed):

- **Kitchen** (`src/modules/kitchen/`) has **no controller at all** — the
  module's own docblock states "No controller yet: Fire (the only producer
  of `order.line.fired`) is not implemented." Mechanically asserted by
  `test/openapi.e2e-spec.ts`'s "does not expose the Kitchen module" check
  and by the live-route drift-detection test (a Kitchen route cannot appear
  in the doc if it was never registered with Express in the first place).
- **Fire, Payment, Completion, refund, KDS bump/recall** — no such routes
  exist anywhere in the 12 controllers (verified by reading every route, and
  mechanically asserted by a dedicated e2e test).
- **Workforce**, **Localisation** — imported in `AppModule` but carry no
  controller (confirmed via `grep -rn "@Controller"` across both module
  directories returning nothing).

---

## D. DEPENDENCY / TOOLING CHANGES

- Added `js-yaml@^4.3.1` + `@types/js-yaml@^4.0.9` as `devDependencies`
  (`npm install --save-dev`; resolved to a version already present
  transitively via `@nestjs/swagger`'s own dependency tree — no duplicate
  version installed). Used only by the YAML-serialization step of the
  generator; not a runtime dependency of the app.
- Configured the `@nestjs/swagger` **CLI plugin** in `nest-cli.json`
  (`classValidatorShim: true`, `introspectComments: true`). This is a
  compile-time TypeScript transformer that runs inside `nest build`'s own
  compilation pass — it does **not** activate under a raw `ts-node`
  invocation, which is why the generator (§E) must run against `nest
  build`'s `dist/` output, never against `src/` directly. Verified
  empirically: after `nest build`, `dist/modules/identity/auth/dto/login.dto.js`
  contains a synthesized `static _OPENAPI_METADATA_FACTORY()` the plugin
  added; without the plugin this method does not exist and DTO schemas
  generate empty.
- Added two npm scripts: `openapi:generate` and `openapi:check` (§E).

---

## E. SOURCE-OF-TRUTH / GENERATION ARCHITECTURE

- **Single source of truth**: `SwaggerModule.createDocument()` — no
  hand-written OpenAPI document exists anywhere that could drift from code.
- New `src/swagger.config.ts` — `buildSwaggerConfig(apiVersion)`, a shared
  `DocumentBuilder` config used by **both** `src/main.ts` (live `/docs` UI)
  and `src/scripts/generate-openapi.ts` (standalone generator), so the two
  can never disagree with each other.
- New `src/scripts/generate-openapi.ts` — bootstraps Nest with
  `NestFactory.create(AppModule, { logger: false })` and `app.init()`
  (**no** `app.listen()`), builds the document via
  `SwaggerModule.createDocument(app, buildSwaggerConfig(apiVersion), {
  deepScanRoutes: true })`, recursively sorts every object's keys
  (`sortKeysDeep`), writes `docs/api/openapi.json` (2-space indent) and
  `docs/api/openapi.yaml` (`js-yaml`, `sortKeys: true`), closes the app, and
  sets `process.exitCode = 1` on any failure.
- Placed under `src/scripts/`, **not** a root-level `scripts/` directory —
  verified that `tsconfig.build.json` has no `include` restricting
  compilation to `src/**`, so a root-level directory would have been picked
  up by `nest build` too, but would have **shifted `tsc`'s computed
  `rootDir`** to the repository root (since it has no explicit `rootDir`),
  which would have moved `dist/main.js` to `dist/src/main.js` and broken
  the existing `"start:prod": "node dist/main"` script. Placing the
  generator inside `src/scripts/` keeps the existing `dist/main.js` path
  untouched — verified by building and confirming `dist/main.js` did not
  move.
- **Generation command** (repeatable, in `package.json`):
  ```
  npm run openapi:generate
  ```
  which runs `nest build && node dist/scripts/generate-openapi.js`.
- **Drift-check command**:
  ```
  npm run openapi:check
  ```
  which runs `openapi:generate` then `git diff --exit-code -- docs/api` —
  fails if the checked-in artifacts are stale relative to the current code.

---

## F. DOCUMENT METADATA

- **Title**: `"ROS Backend API"` (was `"ROS Identity API"` — stale, only
  reflected the original identity-only phase).
- **Description**: rewritten to state plainly that the document describes
  the live, implemented HTTP surface, and explicitly names Fire/Payment/
  Completion/KDS bump-recall as deliberately absent rather than merely
  undocumented.
- **Version**: `package.json`'s `"version": "0.0.1"`, read live via
  `readFileSync`/`JSON.parse` (not `require()`, to avoid a
  `@typescript-eslint/no-require-imports` violation) in both `main.ts` and
  the generator, so the two never disagree. **Judgment call, recorded
  explicitly**: `package.json`'s version has never been bumped to track API
  changes (it is the default Nest scaffold value), so it is not a
  "meaningful" semver history — but the prompt's instruction was to prefer
  `package.json` when meaningful, "otherwise use the current API version
  convention already in the repository." No such convention exists: the
  only related reference found (a comment in `orders.controller.ts` noting
  "the documented `/v1` prefix is applied at deployment, not in the
  controller") describes a *deployment-time* routing prefix, not a document
  version, and is not itself present in any live route. Rather than
  inventing a version number that would misrepresent a maintained history
  that doesn't exist, the literal `package.json` value is used as-is; this
  is recorded here so a future slice knows the field is not yet meaningful,
  not silently "fixed" by picking an arbitrary number.
- **Auth scheme**: `.addBearerAuth({ type: 'http', scheme: 'bearer',
  bearerFormat: 'JWT', description: '...' })` — genuinely what the app uses
  (`JwtAuthGuard` validates a JWT access token via `Authorization: Bearer
  <token>`); no other security scheme exists or is documented.

---

## G. REQUEST SCHEMA COVERAGE

Every request-body DTO in the API is a genuine `class` with
`class-validator` decorators (not an `interface`), living in a file matching
the CLI plugin's default `.dto.ts` suffix — no plugin configuration
customization was needed. The plugin synthesizes complete `@ApiProperty()`
metadata (types, required/optional, and validation constraints such as
`minLength`/`pattern`/`enum` lifted from the `class-validator` decorators
already present) with zero manual annotation. Verified for
`CreateOrderDto`/`PinLoginDto` by inspecting the generated
`components.schemas` entries directly (§P, "required DTO fields" test) —
both retain their real required-field sets.

Path-parameter DTOs (`OrderPathParamsDto`, `OrderLinePathParamsDto`, etc.)
are also classes and are auto-expanded into `@ApiParam` entries; bare
`@Param('name') name: string` parameters (used in some controllers) are
still auto-documented by Nest's built-in parameter extractor purely from the
route pattern, with a generic string type and no description — acceptable
everywhere by default, and given an explicit `@ApiParam` override only where
a specific format adds real value (e.g. `businessDay`'s `YYYY-MM-DD`
pattern, applied via `businessDaySchema()`).

---

## H. RESPONSE SCHEMA COVERAGE

Response shapes are **not** classes anywhere in this codebase — every
module returns a plain object typed by a TS `interface`, built by a
`toXView`/`toXSummary` factory function (e.g. `toSafeUser`, `toOrderView`,
`toTerminalSummary`). Interfaces are erased at compile time, so
`@nestjs/swagger`'s runtime reflection — CLI plugin or not — cannot infer
these shapes. Two options existed: generate ~20-30 new documentation-only
response classes, or write inline `@ApiOkResponse({ schema: {...} })`
JSON-Schema fragments next to each route. The inline approach was chosen —
fewer new files, no refactor of the existing view-factory convention purely
for documentation's sake — backed by a shared helper module:

- New `src/common/openapi/schema-helpers.ts` — `moneyStringSchema()`,
  `decimalStringSchema()`, `businessDaySchema()`, `isoDateTimeSchema()`,
  `uuidSchema()`, `nullable(schema)`. Declares its own minimal
  `SchemaObject`-compatible local type rather than deep-importing
  `@nestjs/swagger`'s internal `dist/interfaces/open-api-spec.interface`
  path, because that type is genuinely not part of the package's public API
  (its `package.json` `exports` map allows only `.`, `./plugin`, and
  `./package.json` — verified directly, not assumed; a deep import fails to
  resolve under `moduleResolution: nodenext`).
- Every module-level `const xSchema = {...}` object added in this slice
  (one set of consts per controller file, immediately above the class) was
  built field-by-field from the actual return statement of the real
  factory/service method, cross-checked against `prisma/schema.prisma`
  enum declarations for any enum field — never inferred from the SRS or
  guessed from a field name. Where a real ambiguity or inconsistency in the
  underlying code was found, it is documented as-is rather than silently
  "corrected" by the schema:
  - `src/modules/inventory/`: `POST /inventory/movements`'s `balanceAfter`
    is a plain JS `number` in that route's own response, while the same
    conceptual field on `GET /inventory/items/:itemId/movements` is a
    decimal *string* — both are what the code actually returns; the
    generated schema documents each as its own real (differing) type, with
    a note.
  - `src/modules/production/`: 3 routes (`replaceLines`, `listGroups`,
    `addGroupMember`) return raw Prisma rows rather than a view-shaped
    object; their schemas are built directly from the Prisma model instead
    of a `to*View` factory, and this distinction is called out in a file
    comment so it isn't mistaken for the same guarantee the view-shaped
    routes carry.

**Coverage** (measured against the final generated document, §P):
119 of 131 operations (91%) carry an explicit response body `schema`; the
remaining 12 are **all** genuinely-bodyless `204 No Content` mutations
(logout, role assign/remove, password change/reset, catalogue link/unlink
operations) — verified individually, listed in full in §P. Real body
coverage is **100%** — every route that returns a body documents its shape.

---

## I. AUTH / SECURITY METADATA

125 of 131 operations (95%) carry `security: [{ bearerAuth: [...] }]`. The
remaining 6 are the genuinely public, unauthenticated routes — verified
individually by reading each: `GET /health`, `POST /auth/login`, `POST
/auth/pin`, `POST /auth/refresh`, `POST /auth/password/forgot`, `POST
/auth/password/reset`. No route is missing security metadata that should
have it, and no public route is over-documented with a security requirement
it doesn't enforce — mechanically asserted by
`test/openapi.e2e-spec.ts`'s "every non-public operation carries security
metadata" test, which checks the actual set, not a sample.

`POST /auth/pin` — the one route found with **zero** prior decoration — now
carries `@ApiOperation`, a full `AuthTokens` response schema, and accurate
401/429 responses, matching the pattern of the other 4 `auth` routes.

---

## J. WIRE-FORMAT AUDIT (VERIFIED, NOT INFERRED)

Read directly from the actual serializers, not the Prisma schema or the
SRS (canonical reference: `src/modules/sales/sales.views.ts`,
`toOrderView`/`toOrderLineView`), and applied consistently via the
`schema-helpers.ts` functions everywhere the same pattern recurs:

| Wire type | Source pattern | Schema helper |
|---|---|---|
| BigInt money (minor units) | `.toString()` — decimal string, never a JSON number (would corrupt a large total via IEEE-754) | `moneyStringSchema()` |
| Prisma `Decimal` quantity | `.toString()` — decimal string, may carry a fractional part | `decimalStringSchema()` |
| `businessDay` partition key | `.toISOString().slice(0, 10)` — plain `YYYY-MM-DD`, never a full instant | `businessDaySchema()` |
| Other `Date`/`Timestamptz` | Returned as a raw JS `Date`; serialized implicitly by `JSON.stringify`'s `Date.prototype.toJSON()` — full ISO-8601 instant | `isoDateTimeSchema()` |
| Identifier | UUID string | `uuidSchema()` |
| Opaque localized-name / provenance JSONB | Passed through as-is | documented as `type: 'object'` with a description, not string-typed |

No field was documented as a money/decimal string merely because it is a
`BigInt`/`Decimal` column in `prisma/schema.prisma` — each was verified
against the module's actual response-shaping code (the `inventory`
`balanceAfter` inconsistency in §H is a direct product of this
verify-don't-infer discipline).

---

## K. IDEMPOTENCY / CONCURRENCY HEADERS

Exactly 3 routes in the entire application carry `@Idempotent()` (verified
by grep, not the SRS's aspirational FR-API-020 list), and all 3 now document
a required `Idempotency-Key` header with the actual replay/conflict
semantics read from `src/common/idempotency/idempotency.interceptor.ts`:

| Route | Header |
|---|---|
| `POST /orders` | `Idempotency-Key` (required) |
| `POST /orders/{businessDay}/{id}/lines` | `Idempotency-Key` + `If-Match` (both required) |
| `POST /cash-sessions` | `Idempotency-Key` (required) |

Exactly 2 routes require `If-Match` (verified by grep for the controller's
own `parseIfMatch`):

| Route | Header |
|---|---|
| `POST /orders/{businessDay}/{id}/lines` | `If-Match` (required) |
| `DELETE /orders/{businessDay}/{id}/lines/{lineId}` | `If-Match` (required) |

**Real bug found and fixed during this work**: Nest's own Swagger explorer
auto-adds a header parameter for any `@Headers('name')` method-parameter
decorator. Adding an explicit `@ApiHeader({ name: 'Idempotency-Key', ... })`
alongside an existing `@Headers('idempotency-key')` produced **two**
separate parameter entries in the generated document (`idempotency-key` and
`Idempotency-Key`) because OpenAPI parameter identity is case-sensitive by
name string. Fixed by matching the `@ApiHeader` `name` to the exact lowercase
casing used in each controller's own `@Headers('...')` call — verified by
rebuilding and inspecting the generated JSON's `parameters` array for zero
duplicates, both locally on `orders.controller.ts` and, via the treasury
fork, on `POST /cash-sessions`. `test/openapi.e2e-spec.ts` does not
currently assert "no duplicate parameters" as a standalone generic check
(it asserts the *specific* required headers exist), but this was manually
verified across the **entire** document (all 131 operations, case-insensitive)
after every fork's changes landed — see §P.

`ETag`/response-header documentation: `orders.controller.ts` sets `ETag` on
every single-order response (`POST /orders`, `GET /orders/{businessDay}/{id}`,
`POST .../lines`, `DELETE .../lines/{lineId}`) — each of those 4 operations'
`@ApiCreatedResponse`/`@ApiOkResponse` now documents an `ETag` response
header with the real `W/"<orderId>.<version>"` weak-validator format.

---

## L. PATH / QUERY PARAMETERS

Path parameters are documented either via DTO classes (auto-expanded by the
CLI plugin — e.g. `OrderPathParamsDto`'s existing JSDoc on `businessDay`
surfaces automatically as the parameter description) or, for bare
`@Param('name')` parameters, via Nest's built-in route-pattern extractor
(generic required string, sufficient by default). Query DTOs
(`ListOrdersQueryDto` and equivalents in other modules) are classes and are
fully covered by the CLI plugin with no manual work.

---

## M. ERROR RESPONSE AUDIT

Every `@ApiBadRequestResponse`/`@ApiConflictResponse`/
`@ApiUnprocessableEntityResponse`/`@ApiNotFoundResponse` added in this slice
was traced to an actual `throw new ...Exception(...)` call site in the
corresponding service or domain-exception filter — never added because a
status "should" be possible. Two representative, fully-traced examples:

- `orders.controller.ts`: `SalesDomainExceptionFilter` maps
  `OrderVersionConflictError` → `409` (a stale `If-Match` — "the caller's
  precondition was stale") and every other Sales domain error → `422` ("the
  request was well formed but the domain refuses it") — read directly from
  the filter's own doc comment and `catch()` logic, not assumed from the
  HTTP spec's general guidance.
- `catalogue.controller.ts`: `assertPriceCompleteness` throws
  `ConflictException` (409), initially assumed by the documenting agent to
  be `422` — caught and corrected by reading the actual throw site before
  finalizing the schema.

No route was given a 500 entry (never a contract, always a failure).

---

## N. TAGGING / OPERATION IDS

All 12 controllers already carried `@ApiTags`; no new tags were introduced.
`operationId`s are Nest's own default (`<ControllerClass>_<methodName>`),
stable and derived purely from source identifiers — no route relies on an
auto-incrementing or timestamp-based id. Verified: **131 operations, 131
unique `operationId`s, zero duplicates** (§P).

---

## O. DETERMINISM PROOF

Per the requirement that regenerating with no code change produce zero
diff: ran `npm run openapi:generate` three separate times in this session
(the third after an unrelated `npx prisma generate` refresh, to also prove
the Prisma client regeneration step has no effect on the API document),
hashing both artifacts after each run:

```
Run 1 docs/api/openapi.json  sha256: 9c64acb4a02bed95b373cfbfa3c4343ebed8009c84f24491ec1726e5ff517af4
Run 1 docs/api/openapi.yaml  sha256: abce12802e7ef9ef83c2f213f366661689bde4f162abfbfa447f98da1f44aa30
Run 2 docs/api/openapi.json  sha256: 9c64acb4a02bed95b373cfbfa3c4343ebed8009c84f24491ec1726e5ff517af4  (identical)
Run 2 docs/api/openapi.yaml  sha256: abce12802e7ef9ef83c2f213f366661689bde4f162abfbfa447f98da1f44aa30  (identical)
Run 3 docs/api/openapi.json  sha256: 9c64acb4a02bed95b373cfbfa3c4343ebed8009c84f24491ec1726e5ff517af4  (identical)
Run 3 docs/api/openapi.yaml  sha256: abce12802e7ef9ef83c2f213f366661689bde4f162abfbfa447f98da1f44aa30  (identical)
```

`diff` between run 1 and run 3 output: empty on both files. Determinism is
structural, not incidental: the generator's `sortKeysDeep` sorts every
object's keys recursively before serialization, `js-yaml`'s `dump` is called
with `sortKeys: true`, and the generator contains no `Date.now()`,
`Math.random()`, or other non-deterministic input.

---

## P. VALIDATION, DRIFT-DETECTION, AND TESTS

New `test/openapi.e2e-spec.ts` (17 tests, all passing against the final
document) — reads the checked-in artifacts (does not regenerate them; CI
runs `openapi:generate` or `openapi:check` first) and a live-bootstrapped
`AppModule` for router introspection:

1. JSON parses and is a well-formed OpenAPI 3 document.
2. YAML parses to the exact same structure as the JSON (`js-yaml.load` vs
   `JSON.parse`, deep-equal).
3. Every `$ref` resolves to a component that actually exists.
4. No duplicate `operationId`s (131/131 unique, asserted, not just
   reported).
5. All 9 "important live controller" representative paths are present
   (`/health`, `/auth/login`, `/auth/pin`, `/orders`, `/catalogue/items`,
   `/inventory/items`, `/org/branches`, `/recipes`, `/cash-sessions`).
6. No Fire/Payment/refund/bump/recall path exists (regex-asserted across
   every path).
7. No `/kitchen*` path exists.
8. Every non-public operation carries non-empty `security` metadata.
9-10. The 3 `Idempotency-Key` routes and 2 `If-Match` routes each document
   the header as `required: true` (parameterized `it.each`, one assertion
   per route — a route silently losing its header re-fails this test by
   name, not just an aggregate count).
11. `CreateOrderDto` retains its real required fields
    (`orderType`/`channel`/`originDeviceTime`).
12. `PinLoginDto` retains its real required fields
    (`tenantId`/`terminalId`/`employeeCode`/`pin`).
13. **Mechanical drift-detection, direction 1**: every method+path Express
    actually has registered (introspected via
    `app.getHttpAdapter().getInstance()._router.stack`, walked recursively,
    `:param` normalized to `{param}`) exists in the generated document —
    catches a live route silently missing from the doc.
14. **Mechanical drift-detection, direction 2**: every documented
    method+path corresponds to an actually-registered live route — catches
    a stale/orphaned doc entry for a route that no longer exists.

Enum-values-match-runtime and duplicate-parameter checks were done as
one-time manual verification rather than standing assertions (§K, §J) — see
those sections for what was checked and how.

**Regression suite, run against a freshly-migrated scratch DB** (found the
local dev DB was 11 migrations behind at the start of this verification
pass — a pre-existing environment gap unrelated to this slice, since every
one of those 11 migrations predates this session; caught it, ran
`prisma migrate deploy` to catch up — non-destructive, applied zero new
migrations, migration count remained 26 — then re-verified):

- `npx tsc --noEmit -p tsconfig.json`: clean, except one already-existing,
  unrelated error in `src/modules/identity/auth/access-token.service.spec.ts`
  (confirmed pre-existing by stashing this slice's entire diff and
  reproducing the identical error against the unmodified tree).
- `npx eslint "{src,test}/**/*.ts"`: zero errors, zero warnings.
- `npx prisma validate`: schema valid.
- Full unit suite: **702/702 passing** (51 suites).
- Full e2e suite: **630/630 passing** (30 suites) — including
  `catalogue.e2e-spec.ts`, `terminal.e2e-spec.ts`, and the new
  `openapi.e2e-spec.ts`, each individually re-run and green after the DB
  catch-up.
- 26 migrations, unchanged; `schema.prisma` untouched.

Response-body schema coverage (measured from the final document): 119/131
operations (91%) carry an explicit response schema; auth metadata coverage:
125/131 (95%) — both fully accounted for in §H/§I as legitimate, not gaps.

---

## Q. EXIT QUESTIONS

- Does `docs/api/openapi.json`/`openapi.yaml` describe every live,
  implemented HTTP endpoint in this repository, and no endpoint that does
  not exist? **YES**
- Is the document generated solely from `@nestjs/swagger` runtime/CLI-plugin
  metadata, with no hand-written OpenAPI content that could drift? **YES**
- Are BigInt money, `Decimal` quantity, `businessDay`, and `Date` wire
  formats documented as verified from actual serializers, not inferred?
  **YES**
- Are `Idempotency-Key`/`If-Match` headers documented only on the routes
  that actually enforce them (3 and 2 respectively), with no
  SRS-aspirational over-annotation? **YES**
- Is generation deterministic (byte-identical across repeated runs with no
  code change)? **YES** (proven 3 times, §O)
- Does a mechanical test catch both directions of route/document drift (a
  live route missing from the doc, and a doc entry with no live route)?
  **YES**
- Does every protected endpoint carry security metadata, and every public
  endpoint correctly carry none? **YES**
- Were Fire, Payment, Completion, or any other unimplemented endpoint
  fabricated anywhere in the document or this report? **NO**
- Was any runtime behavior, business logic, DTO validation rule, database
  schema, or permission changed in this slice? **NO**
- Is this slice ready to commit? **YES** — see §S.

---

## R. NEXT SLICE

**FIRE AUTHORIZATION DECISION + SALES FIRE COMMAND** — not implemented in
this slice, and explicitly out of scope for it. This is a business-feature
slice (touches permissions, Kitchen contract publication, and the first
real `order.line.fired` producer) and must not be conflated with this
purely documentation-generation slice.

---

## S. COMMIT READINESS

**COMMIT READY: YES**
**COMMITTED: NO** — per this slice's explicit instructions, no commit or
push was performed. `git status` shows 16 modified files (12 controllers +
`main.ts` + `nest-cli.json` + `package.json` + `package-lock.json`) and 5
new paths (`docs/api/`, `src/common/openapi/`, `src/scripts/`,
`src/swagger.config.ts`, `test/openapi.e2e-spec.ts`), all reviewed above.
No destructive git command was run. The one non-trivial state-changing
action taken outside the slice's own new files was `prisma migrate deploy`
against the local scratch DB (§P) — applying 11 already-authored, already-
committed migrations that predate this session, to make the regression
suite runnable; this created zero new migration files and did not touch
`schema.prisma`.

---

## Non-goals confirmed respected

Fire/Payment/Completion not implemented; no Kitchen HTTP route added; auth
not redesigned; no permission changed; no controller refactored beyond
adding `@Api*` decorators and the accompanying module-level schema consts;
no DB schema/migration change (migration 27 not created); no frontend SDK
or client code generated; no internal service exposed; no non-existent
endpoint documented; full SRS API coverage not claimed; no commit; no push.
