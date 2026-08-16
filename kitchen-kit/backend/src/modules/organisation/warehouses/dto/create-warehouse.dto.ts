import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';
import { WarehouseType } from '../../../../generated/prisma/client';

export class CreateWarehouseDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  // ADR 0008 D-17: enum values verbatim from the approved SQL. No CHECK
  // correlates warehouseType with branchId — the sources define no such rule.
  @IsOptional()
  @IsEnum(WarehouseType)
  warehouseType?: WarehouseType;

  // NULL/absent = standalone warehouse (approved SQL).
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'branchId must be a UUID' })
  branchId?: string;
}
