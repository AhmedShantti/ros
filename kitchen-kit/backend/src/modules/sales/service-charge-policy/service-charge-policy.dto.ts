import { IsBoolean, IsDefined, IsISO8601, IsOptional } from 'class-validator';

/**
 * Create a new immutable ServiceChargePolicy VERSION — P2D (ratified
 * P2D-R1). One DTO shared by the tenant/brand/branch create routes; the
 * route itself supplies `level`/`targetId` (never the body — mirrors
 * `UpsertSettingValueDto`/`CreateCashClosePolicyDto`'s own "no
 * tenantId/branchId/createdBy in the body" discipline).
 *
 * `rules` is intentionally typed `unknown`: the DEEP structural/semantic
 * validation (`orderType` against the real `OrderType` vocabulary,
 * `minGuestCount` non-negative, `ratePercent` exact-decimal) lives in
 * `service-charge-policy-rules.ts`'s `parseServiceChargePolicyRules`,
 * consumed by `ServiceChargePolicyService` — the `UpsertSettingValueDto`
 * precedent for "a generic body field whose shape a class-validator
 * decorator cannot usefully police."
 */
export class CreateServiceChargePolicyDto {
  @IsDefined({ message: 'rules is required (an array; [] is valid).' })
  rules!: unknown;

  /** Omitted = unlocked (`false`). */
  @IsOptional()
  @IsBoolean()
  locked?: boolean;

  /**
   * Omitted = effective immediately (resolved to DATABASE time, never this
   * process's clock). A past instant is rejected — enforced by the DB
   * CHECK (`ck_scp_no_backdating`), not merely this validator.
   */
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;
}
