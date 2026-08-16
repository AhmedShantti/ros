import { IsObject, IsOptional, IsString, Length } from 'class-validator';

export class UpdateBrandDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  defaultSettings?: Record<string, unknown>;
}
