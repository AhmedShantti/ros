import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class CreateDrawerDto {
  /** `Drawer.name` — VARCHAR(64). */
  @IsString()
  @Length(1, 64)
  name!: string;

  /**
   * Optional LEGACY device binding — `DrawersService.create` still enforces
   * same-branch (ADR 0008 D-16) when a value is supplied. CROSSCUT-POS-KDS-
   * TERMINAL-DECOUPLING-P0 (2026-09-13): opening a cash session no longer
   * checks this field at all — POS is a branch/employee-scoped application
   * session with no terminal identity, so a drawer bound to a terminal is
   * selectable from any POS session at the same branch exactly as an
   * unbound drawer is. Retained only as administrative/hardware-inventory
   * metadata for tenants that still track it.
   */
  @IsOptional()
  @Matches(UUID_PATTERN, { message: 'terminalId must be a UUID' })
  terminalId?: string;
}
