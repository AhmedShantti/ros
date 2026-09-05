import { randomBytes } from 'node:crypto';

/**
 * A run id embeds its own creation time (base36 epoch-ms) plus 6 hex bytes
 * of entropy, so it is both globally unique — safe for two lanes or two CI
 * jobs racing on the same shared Postgres server — and self-describing
 * enough for `scripts/db/sweep-stale-scratch-databases.ts` to find and drop
 * databases orphaned by a killed run, without a database-side creation
 * timestamp (Postgres does not keep one in `pg_database`).
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const entropy = randomBytes(3).toString('hex');
  return `${timestamp}_${entropy}`;
}

export function runIdCreatedAtMs(runId: string): number {
  const [timestampPart] = runId.split('_');
  return parseInt(timestampPart, 36);
}

export function scratchDatabasePrefix(runId: string): string {
  return `ros_test_e2e_${runId}_`;
}

export function templateDatabaseName(runId: string): string {
  return `${scratchDatabasePrefix(runId)}tmpl`;
}

// Postgres identifiers are limited to 63 bytes; keep well under that.
export function suiteDatabaseName(runId: string, suiteTag: string): string {
  const sanitizedTag = suiteTag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 12);
  const entropy = randomBytes(3).toString('hex');
  return `${scratchDatabasePrefix(runId)}s_${sanitizedTag}_${entropy}`;
}
