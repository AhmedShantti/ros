/**
 * Fail-closed guard for the e2e database-isolation harness (G1-2).
 *
 * Every function in this harness that can CREATE or DROP a database calls
 * `assertScratchDatabaseName` first. It throws — refusing the operation —
 * unless the name is unambiguously a disposable scratch database. This is
 * the only thing standing between a harness bug and an accidental DROP of
 * the persistent `ros` database, so it is deliberately conservative: an
 * unrecognised name is refused, not assumed safe.
 */

const PROTECTED_DATABASE_NAMES = new Set([
  'ros',
  'postgres',
  'template0',
  'template1',
]);

// ros_test_<...>, ros_lane_<...>, ros_ci_<...> — see task brief §10.
const SCRATCH_DATABASE_NAME_PATTERN = /^ros_(test|lane|ci)_[a-z0-9_]+$/;

export function assertScratchDatabaseName(name: string): void {
  if (PROTECTED_DATABASE_NAMES.has(name)) {
    throw new Error(
      `e2e-db-isolation: refusing to operate on protected database "${name}"`,
    );
  }
  if (!SCRATCH_DATABASE_NAME_PATTERN.test(name)) {
    throw new Error(
      `e2e-db-isolation: refusing to operate on "${name}" — does not match ` +
        `the scratch-database naming contract ${SCRATCH_DATABASE_NAME_PATTERN}`,
    );
  }
}
