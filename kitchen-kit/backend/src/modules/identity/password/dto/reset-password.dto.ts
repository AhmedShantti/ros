import { IsString, Length } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  @Length(16, 512)
  token!: string;

  @IsString()
  @Length(8, 256)
  newPassword!: string;
}
