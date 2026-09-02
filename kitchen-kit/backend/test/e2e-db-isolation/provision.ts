/**
 * Database provisioning primitives for the e2e isolation harness (G1-2).
 *
 * Two tiers, both going through `assertScratchDatabaseName` before any
 * CREATE/DROP:
 *
 *  1. A single run-level TEMPLATE database, migrated from zero once per
 *     e2e invocation via `prisma migrate deploy` (~20s for the current 35
 *     migrations).
 *  2. Per-suite SCRATCH databases, each `CREATE DATABASE ... TEMPLATE
 *     <template>` — a filesystem-level clone that takes well under a
 *     second, so every suite gets a fully-migrated, private database
 *     without paying the full migration cost per suite.
 *
 * Cloning requires no other session hold a connection to the template at
 * the moment of the clone; nothing in this harness ever connects to the
 * template again after migrating it, so concurrent clones from multiple
 * Jest workers are safe.
 */
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import { databaseNameFromUrl, withDatabaseName } from './db-url';
import { assertScratchDatabaseName } from './guard';

const ROLE_ALREADY_EXISTS = '42710'; // Postgres duplicate_object

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Connects to the `postgres` maintenance database on the same server as
 * `migratorBaseUrl`, runs `fn`, and always disconnects. CREATE/DROP DATABASE
 * cannot run against the database you're connected to. */
export async function withAdminConnection<T>(
  migratorBaseUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: withDatabaseName(migratorBaseUrl, 'postgres'),
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Idempotent: mirrors docker/postgres/init/01-init-app-role.sh so the same
 * harness works unchanged against a freshly-created CI Postgres service
 * container (no `ros_app` role yet) and the shared local dev server (role
 * already exists). */
export async function ensureAppRole(
  admin: Client,
  appRoleName: string,
  appRolePassword: string,
): Promise<void> {
  try {
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(appRoleName)} LOGIN PASSWORD ${quoteLiteral(
        appRolePassword,
      )} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  } catch (err) {
    if ((err as { code?: string }).code !== ROLE_ALREADY_EXISTS) throw err;
  }
}

export async function createDatabase(
  admin: Client,
  name: string,
  options: { owner: string; template?: string; grantConnectTo?: string },
): Promise<void> {
  assertScratchDatabaseName(name);
  const templateClause = options.template
    ? ` TEMPLATE ${quoteIdentifier(options.template)}`
    : '';
  await admin.query(
    `CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(options.owner)}${templateClause}`,
  );
  if (options.grantConnectTo) {
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(name)} TO ${quoteIdentifier(options.grantConnectTo)}`,
    );
  }
}

/** Terminates other backends on `name` first — a suite that forgot to close
 * its Nest app/Prisma connections must never be able to block cleanup. */
export async function dropDatabase(admin: Client, name: string): Promise<void> {
  assertScratchDatabaseName(name);
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [name],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
}

/** Lists scratch databases matching a name prefix — used by global teardown
 * to sweep anything an individual suite's own cleanup missed (crash, hard
 * kill). Never used with a prefix broader than the current run's own id. */
export async function listDatabasesWithPrefix(
  admin: Client,
  prefix: string,
): Promise<string[]> {
  const result = await admin.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datname LIKE $1`,
    [`${prefix}%`],
  );
  return result.rows.map((row) => row.datname);
}

/** Runs `prisma migrate deploy` from zero against `databaseUrl` (the
 * migrator/owner connection for a specific, already-created database). */
export function migrateFromZero(databaseUrl: string): void {
  const dbName = databaseNameFromUrl(databaseUrl);
  assertScratchDatabaseName(dbName);
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: `${__dirname}/../..`,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
