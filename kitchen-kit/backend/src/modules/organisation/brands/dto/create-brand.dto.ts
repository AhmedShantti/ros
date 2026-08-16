import { IsObject, IsOptional, IsString, Length } from 'class-validator';

export class CreateBrandDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  // Opaque JSON per the approved SQL / SRS §7.3 #4 — no key schema is imposed.
  @IsOptional()
  @IsObject()
  theme?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  defaultSettings?: Record<string, unknown>;
}
