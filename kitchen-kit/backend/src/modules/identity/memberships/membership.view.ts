import { MembershipStatus } from '../../../generated/prisma/client';
import { TenantSummary } from '../tenants/tenant.view';

/** Established tenant context — carried in the access token (tid/mid) and on the
 * session. Consumed by later RBAC (Phase 6) and RLS (Phase 8). */
export interface TenantContext {
  tenantId: string;
  membershipId: string;
}

export interface MembershipSummary {
  membershipId: string;
  status: MembershipStatus;
}

export interface MembershipView extends MembershipSummary {
  tenant: TenantSummary;
}

export interface SelectTenantResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  tenant: TenantSummary;
  membership: MembershipSummary;
}
