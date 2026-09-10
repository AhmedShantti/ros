import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/** DI token for `ServiceChargePolicyTargetResolver` — Sales-private, never published. */
export const SERVICE_CHARGE_POLICY_TARGET_RESOLVER = Symbol(
  'SERVICE_CHARGE_POLICY_TARGET_RESOLVER',
);

/**
 * `ScopeTargetResolver` for the `DELETE /service-charge-policy/versions/:versionId`
 * route — the `OrderTargetResolver` precedent, applied here so the
 * DECLARATIVE `PermissionGuard` gate is never NARROWER than the version's
 * own real scope (a branch-scoped manager must not be wrongly rejected
 * before `ServiceChargePolicyService.cancel` even runs its own precise,
 * per-level check — see that method's docblock for why the STATIC
 * `@RequirePermission` on this route is only a coarse pre-filter, and this
 * resolver is what keeps that pre-filter from being falsely narrow).
 */
@Injectable()
export class ServiceChargePolicyTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const { versionId } = input.keys;
    if (!versionId) return null;
    const row = await tx.serviceChargePolicy.findUnique({
      where: { id: versionId },
      select: { level: true, targetId: true },
    });
    if (!row) return null;
    if (row.level === 'branch')
      return { type: 'branch', branchId: row.targetId };
    if (row.level === 'brand') return { type: 'brand', brandId: row.targetId };
    return { type: 'tenant' };
  }
}
