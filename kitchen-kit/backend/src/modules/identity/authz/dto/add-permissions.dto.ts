import { ArrayNotEmpty, IsArray, IsString, MaxLength } from 'class-validator';

export class AddPermissionsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permissionCodes!: string[];
}
