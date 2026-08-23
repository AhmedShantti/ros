import {
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class CreateStationDto {
  @IsString()
  @Length(1, 64)
  name!: string;

  // FR-KDS-001 mentions a configurable capacity; the approved SQL models it as
  // opaque JSON. No key schema is imposed (display colour has NO column — see
  // PHASE_15_DISCOVERY_REPORT §20).
  @IsOptional()
  @IsObject()
  capacityConfig?: Record<string, unknown>;

  // ADR 0008 D-16: the composite FK forces the terminal to be in the SAME
  // branch, hence the same tenant. Not validated by an application check alone.
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'displayTerminalId must be a UUID' })
  displayTerminalId?: string;

  // FR-KDS-001 [M]: "configurable name, display colour, and capacity."
  // Same nullable VARCHAR(9) convention as catalogue categories/menu items.
  @IsOptional()
  @IsString()
  @Length(1, 9)
  displayColour?: string;
}
