import { IsEnum } from 'class-validator';
import { TerminalStatus } from '../../../../generated/prisma/client';

export class SetTerminalStatusDto {
  @IsEnum(TerminalStatus)
  status!: TerminalStatus;
}
