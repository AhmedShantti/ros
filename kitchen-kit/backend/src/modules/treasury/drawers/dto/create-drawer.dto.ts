import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class CreateDrawerDto {
  /** `Drawer.name` — VARCHAR(64). */
  @IsString()
  @Length(1, 64)
  name!: string;

  /**
   * Optional device binding. When set, a cash session may only be opened
   * against this drawer from THAT terminal — `DrawersService.create`
   * enforces same-branch (ADR 0008 D-16). Omitted = any terminal in the
   * branch may open a session over this drawer.
   */
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'terminalId must be a UUID' })
  terminalId?: string;
}
