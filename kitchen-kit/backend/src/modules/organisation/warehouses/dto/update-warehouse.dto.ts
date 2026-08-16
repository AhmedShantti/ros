import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';
import { WarehouseType } from '../../../../generated/prisma/client';

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsEnum(WarehouseType)
  warehouseType?: WarehouseType;

  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'branchId must be a UUID' })
  branchId?: string;
}
