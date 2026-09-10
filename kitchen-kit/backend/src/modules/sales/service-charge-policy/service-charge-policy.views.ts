import {
  isoDateTimeSchema,
  uuidSchema,
} from '../../../common/openapi/schema-helpers';
import type { ResolvedServiceChargePolicyVersion } from './service-charge-policy.resolver';
import type { ServiceChargePolicyRecord } from './service-charge-policy.service';

/**
 * Response shaping for ServiceChargePolicy — P2D (ratified P2D-R1). Exposes
 * only safe configuration facts (id, level, target, rules, locked,
 * effectiveFrom, createdAt) — never internal RLS/audit metadata, never
 * `createdBy` beyond what `toServiceChargePolicyView` (the CREATE
 * response) already echoes back to the actor who just created it.
 */

const ruleSchema = () => ({
  type: 'object',
  properties: {
    orderType: {
      type: 'string',
      nullable: true,
      enum: [
        'dine_in',
        'takeaway',
        'delivery',
        'drive_thru',
        'pickup',
        'aggregator',
      ],
      description: 'null = applies to all order types.',
    },
    minGuestCount: {
      type: 'integer',
      nullable: true,
      minimum: 0,
      description:
        'null = no guest-count condition; otherwise Order.guestCount >= minGuestCount.',
    },
    ratePercent: {
      type: 'string',
      description:
        'Exact-decimal percentage string, e.g. "12.5". Never a JSON number.',
      example: '12.5',
    },
  },
});

export const serviceChargePolicyResponseSchema = () => ({
  type: 'object',
  properties: {
    id: uuidSchema(),
    tenantId: uuidSchema(),
    level: { type: 'string', enum: ['tenant', 'brand', 'branch'] },
    targetId: uuidSchema(),
    rules: { type: 'array', items: ruleSchema() },
    locked: { type: 'boolean' },
    effectiveFrom: isoDateTimeSchema(),
    createdBy: uuidSchema(),
    createdAt: isoDateTimeSchema(),
  },
});

export const resolvedServiceChargePolicyResponseSchema = () => ({
  type: 'object',
  properties: {
    id: uuidSchema(),
    level: { type: 'string', enum: ['tenant', 'brand', 'branch'] },
    targetId: uuidSchema(),
    rules: { type: 'array', items: ruleSchema() },
    locked: { type: 'boolean' },
    effectiveFrom: isoDateTimeSchema(),
  },
});

export function toServiceChargePolicyView(record: ServiceChargePolicyRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId,
    level: record.level,
    targetId: record.targetId,
    rules: record.rules,
    locked: record.locked,
    effectiveFrom: record.effectiveFrom.toISOString(),
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toResolvedServiceChargePolicyView(
  version: ResolvedServiceChargePolicyVersion,
) {
  return {
    id: version.id,
    level: version.level,
    targetId: version.targetId,
    rules: version.rules,
    locked: version.locked,
    effectiveFrom: version.effectiveFrom.toISOString(),
  };
}
