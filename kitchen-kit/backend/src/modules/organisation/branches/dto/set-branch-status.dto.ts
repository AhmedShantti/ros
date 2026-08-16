import { IsEnum } from 'class-validator';
import { BranchStatus } from '../../../../generated/prisma/client';

/** ADR 0008 D-03: availability flag only — `active | inactive`, no state machine. */
export class SetBranchStatusDto {
  @IsEnum(BranchStatus)
  status!: BranchStatus;
}
