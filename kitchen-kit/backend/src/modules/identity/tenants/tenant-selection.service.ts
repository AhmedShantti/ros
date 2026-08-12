import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessTokenService } from '../auth/access-token.service';
import { SelectTenantResult } from '../memberships/membership.view';
import { toTenantSummary } from './tenant.view';

@Injectable()
export class TenantSelectionService {
  private readonly accessTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.accessTtlSeconds = Math.floor(
      parseDurationMs(config.getOrThrow<string>('JWT_ACCESS_TTL')) / 1000,
    );
  }

  /**
   * Establish tenant context for the caller's session. Requires an ACTIVE
   * membership for an ACTIVE tenant; any other case (no membership, inactive
   * membership, inactive/unknown tenant) returns the same generic 403 so the
   * existence of tenants/memberships is not leaked.
   *
   * Validation and session binding happen in one transaction so the membership
   * cannot be deactivated between the check and the bind. The tenant context is
   * then minted into a signed access token (tid/mid) — it can never be set by a
   * client-supplied header/id.
   */
  async select(
    userId: string,
    sessionId: string,
    tenantId: string,
  ): Promise<SelectTenantResult> {
    // User-scoped RLS context: the membership is read via the memberships SELECT
    // policy (user_id = app.user_id) because no tenant is active yet.
    const membership = await this.prisma.withAuthContext(
      { userId },
      async (tx) => {
        const found = await tx.membership.findUnique({
          where: { userId_tenantId: { userId, tenantId } },
          include: { tenant: true },
        });
        if (
          !found ||
          found.status !== 'active' ||
          found.tenant.status !== 'active'
        ) {
          throw new ForbiddenException(
            'You do not have access to this tenant.',
          );
        }
        await tx.session.update({
          where: { id: sessionId },
          data: { membershipId: found.id },
        });
        return found;
      },
    );

    const accessToken = await this.tokens.sign({
      sub: userId,
      sid: sessionId,
      tid: membership.tenantId,
      mid: membership.id,
    });

    await this.audit.emit({
      tenantId: membership.tenantId,
      action: AUDIT_ACTION.TENANT_SELECTED,
      entityType: AUDIT_ENTITY.TENANT,
      actorType: 'user',
      actorId: userId,
      entityId: membership.tenantId,
      metadata: { membershipId: membership.id, sessionId },
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      tenant: toTenantSummary(membership.tenant),
      membership: { membershipId: membership.id, status: membership.status },
    };
  }
}
