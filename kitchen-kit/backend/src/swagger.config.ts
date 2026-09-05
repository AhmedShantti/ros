import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Single source of truth for the OpenAPI document's metadata — shared by the
 * live `/docs` UI (`main.ts`) and the standalone generator
 * (`scripts/generate-openapi.ts`), so the two can never drift apart.
 *
 * Title/description/version are DESCRIPTIVE, not aspirational: this document
 * describes the HTTP surface that exists in this repository today. It does
 * not claim ROS SRS compliance, and it does not list endpoints (Fire,
 * Payment, Completion, KDS bump/recall, ...) that are designed but not yet
 * implemented — see `docs/reports/claude/2026-08-23_API_swagger-openapi-frontend-contract.md`
 * for the full audit of what is and is not covered.
 *
 * `version` is taken directly from `package.json` (`0.0.1` at the time this
 * file was written) rather than a hand-picked number: the field has never
 * been bumped to track API changes, so inventing a more "meaningful" value
 * here would misrepresent it as a maintained semver history it is not. If
 * `package.json`'s version starts being bumped deliberately for API
 * changes, this file needs no edit — it already reads it live.
 *
 * `setOpenAPIVersion('3.1.0')` — SRS NFR-API-001 requires OpenAPI 3.1.
 * `@nestjs/swagger@11` supports this natively (verified against its own
 * `isOas31OrLater` gate); the one thing it does NOT do for a 3.1 document is
 * rewrite the 3.0-only `nullable: true` keyword its CLI plugin and
 * `@ApiProperty({nullable})` still emit regardless of this setting — that
 * correction is applied separately as a document post-process, see
 * `src/common/openapi/oas31.util.ts`.
 *
 * `addServer('/', ...)` — the server entry documents the actually-verified
 * base (relative root), never a guess. No deployment/proxy configuration
 * exists in this repository (`docker-compose.yml` defines only the local
 * Postgres container) to confirm whether an external layer adds a prefix —
 * see `docs/reports/claude/2026-08-23_API1A_openapi31-basepath-error-contract.md`
 * §F.
 *
 * VERSIONING, as of D4-1A: there is still no `setGlobalPrefix`, so every
 * pre-existing route remains at its unversioned path. What DOES exist is Nest
 * URI versioning with `defaultVersion: VERSION_NEUTRAL`
 * (`common/http/api-versioning.ts`), under which a controller only moves under
 * `/v1` if it explicitly asks — today exactly one does, the Sync controller,
 * whose canonical contract Correction 5 of the D1-1 ratification fixes at
 * `/v1/sync/batch`. So paths in this document are a MIX by design, and that is
 * accurate rather than untidy: repository-wide versioning is a Platform
 * decision that Lane D was explicitly forbidden to make unilaterally. When it
 * lands, flipping `defaultVersion` to `'1'` versions everything at once.
 */
export function buildSwaggerConfig(apiVersion: string) {
  return new DocumentBuilder()
    .setTitle('ROS Backend API')
    .setDescription(
      'Restaurant Operating System backend API — the live, implemented ' +
        'HTTP surface of this NestJS backend. Endpoints not yet built ' +
        '(Fire, Payment, Completion, KDS bump/recall, and others the SRS ' +
        'describes but this repository has not implemented) are ' +
        'deliberately absent from this document, not merely undocumented.',
    )
    .setVersion(apiVersion)
    .setOpenAPIVersion('3.1.0')
    .addServer(
      '/',
      'Current application root. There is no global path prefix: routes ' +
        'appear here at the exact paths the application serves. Most are ' +
        'unversioned; the Sync routes are versioned under /v1 because their ' +
        'canonical contract requires it, using Nest URI versioning with a ' +
        'VERSION_NEUTRAL default so no other route was moved. ' +
        'Repository-wide /v1 versioning (SRS §26.1) is a Platform decision ' +
        'and is not yet made. No deployment/proxy configuration exists in ' +
        'this repository, so confirm the real deployed base URL with ' +
        'deployment/ops before treating any prefix as authoritative.',
    )
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'Access token issued by POST /auth/login, POST /auth/pin, or ' +
        'rotated by POST /auth/refresh. Sent as `Authorization: Bearer <token>`.',
    })
    .build();
}
