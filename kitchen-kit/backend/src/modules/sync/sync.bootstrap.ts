import { INestApplication } from '@nestjs/common';
import { json } from 'express';
import { SYNC_MAX_BATCH_BYTES } from './protocol/protocol.constants';

/**
 * Give the sync routes — and ONLY the sync routes — a body limit large enough
 * to carry a ratified batch.
 *
 * ── THE BUG THIS FIXES, FOUND BY THE E2E SUITE ────────────────────────────
 * Express's default JSON body limit is 100 KB and this application never
 * configured one, so it was inherited. A 500-operation batch is roughly 150 KB,
 * which means `NFR-PERF-032`'s OWN batch size — and the ratified 4 MiB cap —
 * were both unreachable: the framework returned 413 before the kernel saw a
 * single byte, and the protocol's own limit could never take effect. The D1-1
 * report flagged the missing configuration; this is where it stops being
 * theoretical.
 *
 * ── WHY IT IS SCOPED, NOT GLOBAL ──────────────────────────────────────────
 * Raising the limit application-wide would widen the memory-pressure surface of
 * every unrelated endpoint to suit one route. Registering a path-scoped parser
 * BEFORE Nest's own means the sync path gets the larger limit and every other
 * route keeps the 100 KB default untouched — `body-parser` marks the request as
 * read, so Nest's global parser sees an already-parsed body and passes it
 * straight through.
 *
 * MUST be called before `app.init()`, so this middleware is registered ahead of
 * the global parser, and must be called by main.ts, and by every test that
 * exercises a realistic batch — otherwise tests and production would disagree
 * about what a client can send.
 */
export function applySyncBodyLimit(app: INestApplication): void {
  const parser = json({ limit: SYNC_MAX_BATCH_BYTES });

  // ── DO NOT INLINE `json(...)` HERE ──────────────────────────────────────
  // `express.json()` returns a function literally NAMED `jsonParser`, and
  // Nest's `ExpressAdapter.registerParserMiddleware` decides whether it still
  // needs to install the global parser by scanning the router stack for a
  // handler with that exact name (`isMiddlewareApplied('jsonParser')`).
  // Registering the raw `json()` here therefore convinces Nest that a global
  // JSON parser already exists, and it installs none — leaving EVERY OTHER
  // ROUTE in the application with an unparsed body. That failure is silent at
  // startup and shows up only as unrelated endpoints suddenly 400-ing, which
  // is exactly how the e2e suite caught it.
  //
  // Wrapping in a differently-named function keeps Nest's detection accurate:
  // the global parser is still installed, and this path-scoped one simply runs
  // first and marks the body as already read.
  const syncJsonParser = (
    req: Parameters<typeof parser>[0],
    res: Parameters<typeof parser>[1],
    next: Parameters<typeof parser>[2],
  ): void => parser(req, res, next);

  app.use('/v1/sync', syncJsonParser);
}
