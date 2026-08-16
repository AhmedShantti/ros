import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateTableDto {
  @IsOptional()
  @IsString()
  @Length(1, 16)
  label?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  section?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(32767)
  seatCapacity?: number;
}
