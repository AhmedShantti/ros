import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';

export interface RecordConflictInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly entityType: string;
  readonly entityId: string;
  /** e.g. `lww`, `add_wins`, `single_writer`, `semantic`. */
  readonly conflictClass: string;
  readonly opId: string;
  readonly competingOpId?: string | null;
  /** The rule that resolved it, e.g. `conflict.lww.hlc`. Null when unresolved. */
  readonly appliedRule?: string | null;
  /** `auto` when the kernel resolved it; `manual_pending` when a human must. */
  readonly resolution: 'auto' | 'manual_pending';
  /** BOTH versions — FR-OFF-043 requires a manager to be shown each. */
  readonly localState: Record<string, unknown>;
  readonly serverState: Record<string, unknown>;
  readonly terminalId?: string | null;
}

/**
 * `FR-OFF-043` conflict register and `FR-OFF-044` audit linkage.
 *
 * Writes inside the CALLER's transaction, so a conflict record and the operation
 * that produced it commit or roll back together — a conflict register that can
 * disagree with the ledger is worse than none.
 *
 * ── SUBSTRATE ONLY IN D4-1A ───────────────────────────────────────────────
 * D4-1A ships this writer and the protocol's ability to return a `conflict`
 * result. It ships NO domain conflict rules: the ratified matrix covers orders,
 * payments, cash sessions, stock movements, KDS tickets and more, and each needs
 * its domain handler to exist first. `FR-OFF-040` therefore remains PARTIAL, and
 * `FR-OFF-043`/`FR-OFF-044` remain PARTIAL until D4-1B wires real handlers —
 * this file is why they are PARTIAL rather than NOT IMPLEMENTED.
 */
@Injectable()
export class ConflictRecordService {
  constructor(private readonly audit: AuditService) {}

  async record(
    tx: Prisma.TransactionClient,
    input: RecordConflictInput,
  ): Promise<string> {
    const id = newId();
    // FR-OFF-044: "recorded in the audit log with BOTH input states and the
    // applied rule". `before_state`/`after_state` carry the two versions and
    // `reason_code` the rule, so no new audit substrate is needed.
    const entry = await this.audit.record(tx, {
      tenantId: input.tenantId,
      action: AUDIT_ACTION.SYNC_CONFLICT_RECORDED,
      entityType: AUDIT_ENTITY.SYNC_CONFLICT_RECORD,
      entityId: id,
      actorType: 'system',
      terminalId: input.terminalId ?? null,
      reasonCode: input.appliedRule ?? input.conflictClass,
      before: input.serverState,
      metadata: {
        conflictClass: input.conflictClass,
        opId: input.opId,
        competingOpId: input.competingOpId ?? null,
        appliedRule: input.appliedRule ?? null,
        resolution: input.resolution,
        localState: input.localState,
        targetEntityType: input.entityType,
        targetEntityId: input.entityId,
      },
    });

    await tx.syncConflictRecord.create({
      data: {
        id,
        tenantId: input.tenantId,
        branchId: input.branchId,
        entityType: input.entityType,
        entityId: input.entityId,
        conflictClass: input.conflictClass,
        opId: input.opId,
        competingOpId: input.competingOpId ?? null,
        appliedRule: input.appliedRule ?? null,
        resolution: input.resolution,
        localState: input.localState as Prisma.InputJsonValue,
        serverState: input.serverState as Prisma.InputJsonValue,
        auditEntryId: entry.id,
      },
    });
    return id;
  }
}
