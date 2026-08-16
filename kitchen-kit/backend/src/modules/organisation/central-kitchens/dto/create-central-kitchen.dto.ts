import { IsString, Length, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class CreateCentralKitchenDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  // Required by the approved SQL (warehouse_id NOT NULL). The composite FK
  // guarantees the warehouse belongs to the acting tenant.
  @Matches(UUID_PATTERN, { message: 'warehouseId must be a UUID' })
  warehouseId!: string;
}
