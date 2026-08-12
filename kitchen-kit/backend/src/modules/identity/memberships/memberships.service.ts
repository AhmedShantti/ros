import { Injectable } from '@nestjs/common';
import { Membership, MembershipStatus } from '../../../generated/prisma/client';
import { toTenantSummary } from '../tenants/tenant.view';
import { MembershipView, TenantContext } from './membership.view';
import { MembershipsRepository } from './memberships.repository';

@Injectable()
export class MembershipsService {
  constructor(private readonly repo: MembershipsRepository) {}

  /** Tenants the user may currently select (active membership + active tenant). */
  async listForUser(userId: string): Promise<MembershipView[]> {
    const memberships = await this.repo.listSelectableByUser(userId);
    return memberships.map((m) => ({
      membershipId: m.id,
      status: m.status,
      tenant: toTenantSummary(m.tenant),
    }));
  }

  /**
   * Resolve the tenant context for a session's membership, re-validating that
   * the membership and its tenant are still active. Returns null when the
   * context is no longer valid (so a refreshed token drops tenant context).
   */
  async resolveActiveContext(
    membershipId: string,
  ): Promise<TenantContext | null> {
    const membership = await this.repo.findByIdWithTenant(membershipId);
    if (
      !membership ||
      membership.status !== 'active' ||
      membership.tenant.status !== 'active'
    ) {
      return null;
    }
    return { tenantId: membership.tenantId, membershipId: membership.id };
  }

  /** Grant a membership (used by bootstrap/seed and tests — not an HTTP route). */
  grant(
    userId: string,
    tenantId: string,
    status?: MembershipStatus,
  ): Promise<Membership> {
    return this.repo.create({ userId, tenantId, status });
  }

  /** Membership lifecycle transition (activate/deactivate/suspend). */
  setStatus(
    membershipId: string,
    status: MembershipStatus,
  ): Promise<Membership> {
    return this.repo.setStatus(membershipId, status);
  }
}
