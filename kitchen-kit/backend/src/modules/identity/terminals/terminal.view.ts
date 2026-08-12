import {
  Terminal,
  TerminalStatus,
  TerminalType,
} from '../../../generated/prisma/client';

/** Safe terminal view — no device fingerprint material is ever included. */
export interface TerminalSummary {
  id: string;
  tenantId: string;
  branchId: string;
  name: string;
  terminalType: TerminalType;
  status: TerminalStatus;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export function toTerminalSummary(terminal: Terminal): TerminalSummary {
  return {
    id: terminal.id,
    tenantId: terminal.tenantId,
    branchId: terminal.branchId,
    name: terminal.name,
    terminalType: terminal.terminalType,
    status: terminal.status,
    lastSeenAt: terminal.lastSeenAt,
    createdAt: terminal.createdAt,
  };
}
