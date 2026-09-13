import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/**
 * PIN authentication for a POS or KDS application session — FR-SEC-020 /
 * FR-SEC-021.
 *
 * ── CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13, PRODUCT DECISION) ──
 * POS and KDS are APPLICATION SESSIONS, not registered device identities.
 * This request carries no `terminalId` — the original FR-SEC-020/021
 * "terminal" wording is SUPERSEDED for this flow (see the product-decision
 * record in the P0 report). `branchId` is the operator's chosen operating
 * branch, verified against the employee's permitted branches exactly as
 * before; `sessionType` selects which of the two disjoint session
 * audiences (`pos`/`kds`) the issued token carries.
 *
 * The tenant is supplied explicitly because a PIN session is established before
 * any tenant context exists: unlike password login there is no prior token to
 * carry `tid`. The branch must belong to that tenant, which RLS enforces.
 */
export class PinLoginDto {
  @Matches(UUID_PATTERN) tenantId!: string;

  @Matches(UUID_PATTERN) branchId!: string;

  /** Employee code, not an email — a POS/KDS operator identifies by staff code. */
  @IsString() @MinLength(1) @MaxLength(32) employeeCode!: string;

  /** FR-SEC-020: 4–8 digits. Never logged, never echoed. */
  @Matches(/^\d{4,8}$/, { message: 'PIN must be 4 to 8 digits.' })
  pin!: string;

  /** Which application session this PIN login establishes. */
  @IsIn(['pos', 'kds'])
  sessionType!: 'pos' | 'kds';
}
