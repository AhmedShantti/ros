import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

/** Document types come verbatim from the approved SQL's comment. */
export const PRINT_DOCUMENT_TYPES: string[] = [
  'receipt',
  'kitchen_ticket',
  'bar_ticket',
];

/**
 * Configuration only. Neither the SRS nor the approved SQL defines a priority or
 * an active flag for print routing, so neither is invented (ADR 0008 D-19).
 */
export class CreatePrintRoutingDto {
  @IsIn(PRINT_DOCUMENT_TYPES)
  documentType!: string;

  @IsString()
  @Length(1, 64)
  printerTarget!: string;

  // Absent/NULL = branch-level default. The composite FK confines the station to
  // the same branch (ADR 0008 D-09).
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'stationId must be a UUID' })
  stationId?: string;
}
