import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

/**
 * `status` is deliberately absent (ADR 0008 D-05): live table state is
 * order-driven, high-churn and owned by Sales, so it is not part of the
 * Organisation configuration aggregate.
 */
export class CreateTableDto {
  @IsString()
  @Length(1, 16)
  label!: string;

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
