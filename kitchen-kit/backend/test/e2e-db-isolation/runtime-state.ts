/**
 * Handoff between Jest's `globalSetup` (runs once, in the main process,
 * before any worker starts) and each worker's `setupFilesAfterEnv` hook
 * (runs once per test FILE, in a fresh module registry, possibly in a
 * different process). A JSON file is used rather than relying on
 * `process.env` propagation for the full payload: it is explicit and
 * inspectable.
 *
 * The file's PATH, however, is itself keyed by `E2E_DB_ISOLATION_RUN_ID` — an
 * env var `global-setup.ts` sets on `process.env` before Jest spawns any
 * worker, which Node's `child_process.fork` (how Jest's default worker farm
 * spawns workers) copies into every worker's own `process.env` at fork time.
 * This is required, not cosmetic: two *separate* `npx jest --config
 * jest-e2e.json` invocations running concurrently on the same machine (e.g.
 * two lanes, or two CI jobs, racing on the same shared Postgres server) are
 * two unrelated OS process trees that would otherwise both read and write
 * the exact same fixed file path, each capable of overwriting the other's
 * state mid-run — proven live in this session: a second concurrent
 * invocation's `globalTeardown` read the first invocation's run id from a
 * clobbered shared file and swept the first invocation's template database
 * out from under it. Keying the path by the run id closes that race: each
 * invocation's own workers only ever see their own invocation's env var
 * (inherited from their own parent process), so each invocation reads and
 * writes only its own file.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface E2eDbRuntimeState {
  runId: string;
  migratorBaseUrl: string;
  appBaseUrl: string;
  migratorRoleName: string;
  appRoleName: string;
  templateDatabaseName: string;
}

export const RUN_ID_ENV_VAR = 'E2E_DB_ISOLATION_RUN_ID';

const STATE_DIR = join(__dirname, '.runtime');

function stateFilePath(): string {
  const runId = process.env[RUN_ID_ENV_VAR];
  if (!runId) {
    throw new Error(
      `e2e-db-isolation: ${RUN_ID_ENV_VAR} is not set in this process — ` +
        'globalSetup did not run in this process tree (jest-e2e.json must ' +
        'set "globalSetup" to global-setup.ts), or a worker was spawned in a ' +
        "way that does not inherit its parent's environment.",
    );
  }
  return join(STATE_DIR, `e2e-db-state.${runId}.json`);
}

export function writeRuntimeState(state: E2eDbRuntimeState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
}

export function readRuntimeState(): E2eDbRuntimeState {
  const file = stateFilePath();
  if (!existsSync(file)) {
    throw new Error(
      `e2e-db-isolation: no runtime state at ${file} — globalSetup did not ` +
        'run (jest-e2e.json must set "globalSetup" to global-setup.ts).',
    );
  }
  return JSON.parse(readFileSync(file, 'utf8')) as E2eDbRuntimeState;
}

export function clearRuntimeState(): void {
  rmSync(stateFilePath(), { force: true });
}
