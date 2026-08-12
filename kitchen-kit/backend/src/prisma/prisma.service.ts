import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client';

/** Trusted authorization scope for a tenant-scoped DB transaction. Both values
 *  originate only from a validated principal/TenantContext — never client input. */
export interface AuthScope {
  userId?: string;
  tenantId?: string;
}

/**
 * Prisma 7 client wired through the node-postgres driver adapter.
 *
 * The application connects as the RLS-constrained runtime role (ros_app,
 * NOBYPASSRLS). `withAuthContext` is the ONE mechanism that establishes the
 * transaction-local PostgreSQL tenant context consumed by RLS policies.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        // Runtime = the RLS-constrained application role. Migrations run
        // separately as ros_migrator via prisma.config.ts (DATABASE_URL).
        connectionString: config.getOrThrow<string>('APP_DATABASE_URL'),
      }),
    });
  }

  /**
   * Run `fn` inside a single interactive transaction whose first statement sets
   * the transaction-local RLS context (`app.user_id`, `app.tenant_id`) via
   * `set_config(..., true)` — the parameterized equivalent of `SET LOCAL`.
   *
   * Guarantees (verified against @prisma/adapter-pg): the set_config and all of
   * `fn`'s queries execute on the SAME connection/transaction; the settings are
   * transaction-local, so they are discarded at COMMIT/ROLLBACK and never leak
   * to another pooled request. A missing value is passed as '' → NULLIF → NULL
   * in policies → fail-closed. Nested calls to withAuthContext are NOT supported
   * (Prisma has no nested interactive transactions); compose within a single
   * scope instead.
   */
  async withAuthContext<T>(
    scope: AuthScope,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)",
        scope.userId ?? '',
        scope.tenantId ?? '',
      );
      return fn(tx);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected (ros_app / RLS-constrained)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
