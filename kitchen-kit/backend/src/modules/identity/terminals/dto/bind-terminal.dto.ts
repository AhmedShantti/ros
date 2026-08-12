import { Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class BindTerminalDto {
  @Matches(UUID_PATTERN, { message: 'terminalId must be a UUID' })
  terminalId!: string;
}
