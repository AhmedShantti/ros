import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import type {
  ScopeTargetResolver,
  ScopeTargetResolverInput,
  TargetScope,
} from '../../identity/contract';

/**
 * PRIVATE implementation of `CATALOGUE_PRICE_LIST_TARGET_RESOLVER`.
 *
 * A `brand`/`branch` price list whose `scope_id` is NULL cannot exist under the
 * approved schema, but if one ever did it would be UNSCOPEABLE, not tenant-wide
 * — so it resolves to `null` (refused) rather than widening to TENANT.
 */
@Injectable()
export class PriceListTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const priceListId = input.keys.priceListId;
    if (!priceListId) return null;
    const list = await tx.priceList.findUnique({
      where: { id: priceListId },
      select: { scopeType: true, scopeId: true },
    });
    if (!list) return null;
    if (list.scopeType === 'tenant') return { type: 'tenant' };
    if (list.scopeId === null) return null;
    return list.scopeType === 'brand'
      ? { type: 'brand', brandId: list.scopeId }
      : { type: 'branch', branchId: list.scopeId };
  }
}

/**
 * PRIVATE implementation of `CATALOGUE_AVAILABILITY_RULE_TARGET_RESOLVER`.
 *
 * `branch_id IS NULL` is FR-MNU-030's "applies to all branches", so a
 * tenant-wide rule is genuinely a TENANT target — 86-ing an item everywhere is
 * a tenant-wide act and a single-branch actor must not be able to do it.
 */
@Injectable()
export class AvailabilityRuleTargetResolver implements ScopeTargetResolver {
  async resolve(
    tx: Prisma.TransactionClient,
    input: ScopeTargetResolverInput,
  ): Promise<TargetScope | null> {
    const ruleId = input.keys.ruleId;
    if (!ruleId) return null;
    const rule = await tx.availabilityRule.findUnique({
      where: { id: ruleId },
      select: { branchId: true },
    });
    if (!rule) return null;
    return rule.branchId === null
      ? { type: 'tenant' }
      : { type: 'branch', branchId: rule.branchId };
  }
}
