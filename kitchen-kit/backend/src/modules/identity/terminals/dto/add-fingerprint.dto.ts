import { IsOptional, IsString, MaxLength } from 'class-validator';

export class AddFingerprintDto {
  @IsString()
  @MaxLength(1024)
  deviceFingerprint!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  os?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}
