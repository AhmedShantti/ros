# ROS Backend — OpenAPI contract

`openapi.json` and `openapi.yaml` describe the **live, implemented** HTTP
surface of this NestJS backend — generated directly from `@nestjs/swagger`
metadata, not hand-written, as **OpenAPI 3.1** (SRS NFR-API-001). They do not
describe the ROS SRS's full intended API surface: endpoints not yet built
(Fire, Payment, Completion, KDS bump/recall, and others) are absent, not
merely undocumented. See
`docs/reports/claude/2026-08-23_API_swagger-openapi-frontend-contract.md`
(the original audit) and
`docs/reports/claude/2026-08-23_API1A_openapi31-basepath-error-contract.md`
(the 3.1/base-path/error-contract correction) for the full audit trail.

## Base URL — read this before pointing a client at the API

The `servers` entry in the document is `/` (relative root, no prefix). SRS
§26.1 specifies `/v1` URL versioning, but **`/v1` is not implemented**: the
application registers no global prefix (`setGlobalPrefix` is never called),
and this repository contains no deployment/proxy configuration (no nginx
config, no app container in `docker-compose.yml` — it defines only the local
Postgres database) that could add one at the infrastructure layer. If your
deployment puts this API behind a reverse proxy that adds `/v1` (or any other
prefix), that is **deployment configuration external to this repository** —
confirm the real deployed base URL with deployment/ops rather than assuming
one. Do not hard-code `/v1` into a generated client based on the SRS alone.

## Error response bodies

Every documented 400/401/403/404/409/422/429 response references a shared
`ErrorResponse` component schema: `{ statusCode: integer, message: string |
string[], error?: string }`. This is Nest's real default `HttpException`
envelope (also produced verbatim by the one global `SalesDomainExceptionFilter`)
— not RFC 7807. `error` is genuinely absent on some responses (e.g. a bare
`new UnauthorizedException()` with no message) and present on others; the
schema's `error` field is optional to reflect that truthfully. The ROS SRS
§26.2 calls for RFC 7807 — that is a runtime gap, not something this
generated document can paper over; see the API-1A report §I for the full
classification.

## Regenerating

```
npm run openapi:generate
```

This runs `nest build` (required so `@nestjs/swagger`'s CLI plugin, configured
in `nest-cli.json`, synthesizes DTO metadata at compile time) and then runs
the compiled generator (`src/scripts/generate-openapi.ts`), which writes both
files deterministically — object keys are sorted recursively before
serialization, so re-running against an unchanged API surface produces
byte-identical output.

To confirm the checked-in files aren't stale relative to the current code:

```
npm run openapi:check
```

(Regenerates, then fails if `git diff` sees any change under `docs/api/`.)

## Rules

- **Do not hand-edit `openapi.json` or `openapi.yaml`.** They are generated
  artifacts; edit the `@Api*` decorators on the relevant controller (and the
  shared schema fragments in `src/common/openapi/schema-helpers.ts`) instead,
  then regenerate.
- **Regenerate after any API-contract change** — a new route, a changed
  request/response shape, a changed status code — before committing.
- **Only implemented endpoints are documented.** If a route doesn't exist in
  `src/modules/**/*.controller.ts`, it must not appear here; if you're adding
  one, add the controller and decorators first, then regenerate.
- `test/openapi.e2e-spec.ts` mechanically checks the generated document
  against the live route surface (drift detection), required DTO fields,
  documented idempotency/concurrency headers, and structural validity
  ($ref resolution, no duplicate `operationId`s). Run it after regenerating.
