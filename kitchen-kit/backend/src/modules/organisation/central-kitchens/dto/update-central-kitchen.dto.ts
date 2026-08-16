import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class UpdateCentralKitchenDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'warehouseId must be a UUID' })
  warehouseId?: string;
}
