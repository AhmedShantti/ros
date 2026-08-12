import { Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class AssignRoleDto {
  @Matches(UUID_PATTERN, { message: 'roleId must be a UUID' })
  roleId!: string;
}
