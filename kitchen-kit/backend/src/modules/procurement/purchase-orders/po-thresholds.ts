import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * FR-PRC-018 §7 — configurable value-band thresholds.
 *
 * Per the ratified Governance Decision Register (D-13, "Threshold / Value
 * Configuration", 2026-08-17): "Governance does NOT own thresholds... the
 * consuming domain determines whether an operation requires approval." This
 * slice IS that consuming domain. The mission brief's own §7 directs
 * inspecting whether generic Platform Settings (`EFFECTIVE_SETTING_QUERY`,
 * FR-PLT-025) is the right mechanism for this non-financial workflow
 * configuration — it is: no per-key registration is required, and Platform
 * Settings' own `SettingsAdminService`/`UpsertSettingValueDto` HTTP surface
 * already lets a tenant admin set ANY key, so no new write route is needed
 * here — only this read-side parser (mirrors
 * `service-charge-policy-rules.ts`'s hand-rolled-validator precedent; no
 * Zod or schema library exists anywhere in this repository).
 *
 * Setting key: `procurement.po_approval_thresholds`
 * Value shape: `{ threshold1Minor: string, threshold2Minor: string, threshold3Minor: string }`
 *   — base-10 integer minor-unit strings, `0 <= threshold1 < threshold2 < threshold3`.
 *
 * ── MULTI-CURRENCY SCOPE NOTE (a recorded, narrow simplification) ──────────
 * No currency-conversion mechanism exists anywhere in this repository
 * (comparative pricing explicitly refuses to compare amounts across
 * currencies — `pricing.service.ts` §9). Thresholds are therefore compared
 * directly against a PurchaseOrder's own `grandTotal` in the PO's own
 * currency, with no FX normalisation — exact and correct for a
 * single-currency tenant, and the same posture every other money comparison
 * in this codebase already takes. Inventing FX conversion here would be
 * exactly the "inventing financial semantics" the mission brief's §4
 * instructs against; this is recorded rather than silently assumed.
 */

export interface PoApprovalThresholds {
  readonly threshold1Minor: bigint;
  readonly threshold2Minor: bigint;
  readonly threshold3Minor: bigint;
}

export const PO_APPROVAL_THRESHOLDS_SETTING_KEY =
  'procurement.po_approval_thresholds';

class PoApprovalThresholdsParseError extends Error {}

function parseMinorUnitString(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) {
    throw new PoApprovalThresholdsParseError(
      `${PO_APPROVAL_THRESHOLDS_SETTING_KEY}.${field} must be a base-10 ` +
        'non-negative integer minor-unit string.',
    );
  }
  return BigInt(value);
}

/** Throws `BadRequestException` on a malformed configured value — a tenant
 *  misconfiguration, not a caller error, but 400 is this repository's
 *  convention for "the request cannot proceed because of invalid input the
 *  server holds", mirroring `ServiceChargePolicyRuleValidationError`'s own
 *  400 mapping at its call site. */
export function parsePoApprovalThresholds(raw: unknown): PoApprovalThresholds {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new PoApprovalThresholdsParseError(
        `${PO_APPROVAL_THRESHOLDS_SETTING_KEY} must be a JSON object.`,
      );
    }
    const obj = raw as Record<string, unknown>;
    const threshold1Minor = parseMinorUnitString(
      obj.threshold1Minor,
      'threshold1Minor',
    );
    const threshold2Minor = parseMinorUnitString(
      obj.threshold2Minor,
      'threshold2Minor',
    );
    const threshold3Minor = parseMinorUnitString(
      obj.threshold3Minor,
      'threshold3Minor',
    );
    if (!(
      threshold1Minor < threshold2Minor && threshold2Minor < threshold3Minor
    )) {
      throw new PoApprovalThresholdsParseError(
        `${PO_APPROVAL_THRESHOLDS_SETTING_KEY} thresholds must be strictly ` +
          'increasing: threshold1Minor < threshold2Minor < threshold3Minor.',
      );
    }
    return { threshold1Minor, threshold2Minor, threshold3Minor };
  } catch (err) {
    if (err instanceof PoApprovalThresholdsParseError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

export type PurchaseOrderApprovalBand = 'auto' | 'tier_1' | 'tier_2' | 'tier_3';

/**
 * §7/§8 boundary rule (no source specifies inclusivity; this is a recorded,
 * explicit engineering judgment call, not an invented financial rule):
 * `total < threshold1` → auto; `threshold1 <= total < threshold2` → tier_1;
 * `threshold2 <= total < threshold3` → tier_2; `total >= threshold3` → tier_3.
 * A half-open partition avoids any double-boundary ambiguity.
 */
export function resolveApprovalBand(
  totalMinor: bigint,
  thresholds: PoApprovalThresholds,
): PurchaseOrderApprovalBand {
  if (totalMinor < thresholds.threshold1Minor) return 'auto';
  if (totalMinor < thresholds.threshold2Minor) return 'tier_1';
  if (totalMinor < thresholds.threshold3Minor) return 'tier_2';
  return 'tier_3';
}

/** Ordinal comparison for "does band A already cover the authority band B
 *  requires" (mission brief §10 — amendment reapproval rule). */
const BAND_ORDER: Record<PurchaseOrderApprovalBand, number> = {
  auto: 0,
  tier_1: 1,
  tier_2: 2,
  tier_3: 3,
};

export function bandCovers(
  heldBand: PurchaseOrderApprovalBand,
  requiredBand: PurchaseOrderApprovalBand,
): boolean {
  return BAND_ORDER[heldBand] >= BAND_ORDER[requiredBand];
}

export function requiredPermissionForBand(
  band: PurchaseOrderApprovalBand,
  permissions: {
    readonly tier1: string;
    readonly tier2: string;
    readonly tier3: string;
  },
): string | null {
  switch (band) {
    case 'auto':
      return null;
    case 'tier_1':
      return permissions.tier1;
    case 'tier_2':
      return permissions.tier2;
    case 'tier_3':
      return permissions.tier3;
  }
}

/** No `procurement.po_approval_thresholds` configured at all — fail closed
 *  rather than invent a default (mission brief §4/§7: no defensible
 *  precedent for a default threshold amount exists anywhere in this
 *  repository or the SRS). */
export function requireConfiguredThresholds(hasEffectiveValue: boolean): void {
  if (!hasEffectiveValue) {
    throw new UnprocessableEntityException(
      `${PO_APPROVAL_THRESHOLDS_SETTING_KEY} must be configured (via the ` +
        'Platform Settings admin surface, FR-PLT-025) before a purchase ' +
        'order can be submitted for approval.',
    );
  }
}
