import { Injectable } from '@nestjs/common';
import { Membership, MembershipStatus } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { toTenantSummary } from '../tenants/tenant.view';
import { MembershipView, TenantContext } from './membership.view';
import { MembershipsRepository } from './memberships.repository';

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: MembershipsRepository,
  ) {}

  /**
   * Tenants the user may currently select. Runs under a USER-scoped RLS context
   * (app.user_id set, no tenant) — this is the cross-tenant "list my tenants"
   * read permitted by the memberships SELECT policy before tenant selection.
   */
  async listForUser(userId: string): Promise<MembershipView[]> {
    const memberships = await this.prisma.withAuthContext({ userId }, (tx) =>
      this.repo.listSelectableByUser(tx, userId),
    );
    return memberships.map((m) => ({
      membershipId: m.id,
      status: m.status,
      tenant: toTenantSummary(m.tenant),
    }));
  }

  /**
   * Resolve the tenant context for a session's membership (used on refresh),
   * re-validating that membership and tenant are still active. USER-scoped so
   * the row is visible via the memberships SELECT policy.
   */
  async resolveActiveContext(
    userId: string,
    membershipId: string,
  ): Promise<TenantContext | null> {
    const membership = await this.prisma.withAuthContext({ userId }, (tx) =>
      this.repo.findByIdWithTenant(tx, membershipId),
    );
    if (
      !membership ||
      membership.userId !== userId ||
      membership.status !== 'active' ||
      membership.tenant.status !== 'active'
    ) {
      return null;
    }
    return { tenantId: membership.tenantId, membershipId: membership.id };
  }

  /** Grant a membership (bootstrap/seed/tests). INSERT is tenant-scoped by RLS. */
  grant(
    userId: string,
    tenantId: string,
    status?: MembershipStatus,
  ): Promise<Membership> {
    return this.prisma.withAuthContext({ userId, tenantId }, (tx) =>
      this.repo.create(tx, { userId, tenantId, status }),
    );
  }

  /** Membership lifecycle transition. UPDATE is tenant-scoped by RLS, so the
   *  acting tenant must be supplied. */
  setStatus(
    tenantId: string,
    membershipId: string,
    status: MembershipStatus,
  ): Promise<Membership> {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      this.repo.setStatus(tx, membershipId, status),
    );
  }
}
