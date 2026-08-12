import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  // Length is enforced in depth by the password policy; this only bounds input.
  @IsString()
  @Length(8, 256)
  password!: string;

  @IsString()
  @Length(1, 120)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  preferredLocale?: string;
}
