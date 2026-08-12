import { IsOptional, IsString, Length, MaxLength } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @Length(1, 64)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
