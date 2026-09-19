import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * A Prisma client connected as the migration/owner role (ros_migrator) for
 * privileged test arrange/teardown on RLS-protected tables. This mirrors real
 * operations: migrations/admin tooling run as ros_migrator, while the app under
 * test runs as the RLS-constrained ros_app. The runtime isolation being proven
 * is always exercised through HTTP as ros_app — never through this client.
 */
export function createMigratorClient(app: INestApplication): PrismaClient {
  const url = app.get(ConfigService).getOrThrow<string>('DATABASE_URL');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/**
 * BRANCH-MANAGER-CASH-CLOSE-RLS-AWARE-MIGRATION-P0 — a Prisma client
 * connected as the ordinary, RLS-CONSTRAINED runtime role (`ros_app`,
 * `APP_DATABASE_URL`) rather than the privileged migrator role above.
 *
 * Every call site MUST construct a fresh instance right before use and
 * never reuse one across a `set_config` call made elsewhere — the whole
 * point is to reproduce a connection that starts with NO
 * `app.tenant_id`/`app.user_id` context, exactly the condition
 * `prisma migrate deploy` runs a migration file under in production
 * (confirmed in
 * `2026-09-19_CASH-CLOSE-MIGRATION-RLS-ZERO-EFFECT-P0_investigation.md`).
 * `PrismaService.withAuthContext` — what every other test in this suite
 * exercises indirectly through HTTP — always sets that context first; this
 * client deliberately never does, so a migration's own SQL is the only
 * thing that can establish it.
 */
export function createAppClient(app: INestApplication): PrismaClient {
  const url = app.get(ConfigService).getOrThrow<string>('APP_DATABASE_URL');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
