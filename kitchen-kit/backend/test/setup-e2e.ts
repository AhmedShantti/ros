/**
 * E2E test setup (runs before each e2e test file, before the Nest app boots).
 *
 * The production-SAFE code default for AUTH_THROTTLE_LIMIT is intentionally
 * strict (see src/config/env.validation.ts). Several e2e suites legitimately
 * make many sensitive-endpoint calls (e.g. the refresh-rotation suite), so the
 * test run opts into a looser, deterministic limit here — committed so it does
 * not depend on any developer's local .env. Uses `??=` so an explicitly-set
 * environment value still wins.
 */
process.env.AUTH_THROTTLE_TTL ??= '60000';
process.env.AUTH_THROTTLE_LIMIT ??= '50';
