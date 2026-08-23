import {
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class UpdateStationDto {
  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @IsOptional()
  @IsObject()
  capacityConfig?: Record<string, unknown>;

  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'displayTerminalId must be a UUID' })
  displayTerminalId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 9)
  displayColour?: string;
}
