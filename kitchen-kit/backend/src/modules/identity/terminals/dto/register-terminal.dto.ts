import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';
import { TerminalType } from '../../../../generated/prisma/client';

export class RegisterTerminalDto {
  @IsString()
  @Length(1, 64)
  name!: string;

  @IsEnum(TerminalType)
  terminalType!: TerminalType;

  @Matches(UUID_PATTERN, { message: 'branchId must be a UUID' })
  branchId!: string;

  // Raw device fingerprint (optional). Hashed server-side; never stored/logged.
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  deviceFingerprint?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  os?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  appVersion?: string;
}
