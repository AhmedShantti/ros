import { Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/** ADR 0008 D-13 / FR-PLT-004 — explicit operation, never a generic PATCH field. */
export class ReassignBrandDto {
  @Matches(UUID_PATTERN, { message: 'brandId must be a UUID' })
  brandId!: string;
}
