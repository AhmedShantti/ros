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
