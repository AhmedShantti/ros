import {
  INestApplication,
  VERSION_NEUTRAL,
  VersioningType,
} from '@nestjs/common';

/**
 * The NARROWEST mechanism that produces the canonical `/v1/sync/batch` contract
 * without retrofitting every existing controller.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 * SRS §26.1 specifies `/v1` URL versioning and the Full-SRS API catalogue uses
 * versioned Sync routes (`POST /v1/sync/batch`, `GET /v1/sync/changes`,
 * `GET /v1/sync/status`). This repository has no global prefix — there is no
 * `setGlobalPrefix`, and `swagger.config.ts` documents the absence, publishing
 * `addServer('/')` rather than guessing. Correction 5 of the D1-1 ratification
 * settles the resulting question in both directions: the canonical Sync contract
 * IS `/v1`-versioned, AND "Lane D MUST NOT independently retrofit the entire
 * application routing structure."
 *
 * ── WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
 * `defaultVersion: VERSION_NEUTRAL` means every controller that does not ASK for
 * a version keeps its exact current path. `/orders`, `/kds/...`, `/auth/...` and
 * every other route are byte-identical before and after this call — verified by
 * the committed OpenAPI document, in which this change adds only the new sync
 * paths. A controller opts in by declaring `@Controller({ path, version: '1' })`,
 * which is how `SyncController` reaches `/v1/sync/batch` and nothing else moves.
 *
 * This is not the platform-wide versioning decision. When Platform makes it,
 * flipping `defaultVersion` from `VERSION_NEUTRAL` to `'1'` versions everything
 * at once, and Sync needs no change because it already declares its version
 * explicitly. Nothing here forecloses a different mechanism either.
 *
 * ── WHY A SHARED HELPER AND NOT A LINE IN main.ts ─────────────────────────
 * `main.ts` is not the only place a Nest application is created: the OpenAPI
 * generator builds one, and every e2e suite builds one. Configuring versioning
 * in `main.ts` alone would mean the generated document and every test exercised
 * DIFFERENT routes from production — the exact drift class the repository's
 * `openapi:check` exists to catch. One helper, called from all three, keeps them
 * identical by construction.
 */
export function applyApiVersioning(app: INestApplication): void {
  app.enableVersioning({
    type: VersioningType.URI,
    // Existing routes stay exactly where they are.
    defaultVersion: VERSION_NEUTRAL,
  });
}
