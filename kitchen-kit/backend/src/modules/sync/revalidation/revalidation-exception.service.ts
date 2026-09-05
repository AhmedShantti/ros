import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../../governance/contract';

export interface RaiseRevalidationExceptionInput {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly opId: string;
  readonly entityType: string;
  readonly entityId: string;
  /** What the device computed. */
  readonly clientValues: Record<string, unknown>;
  /** What the server computed. */
  readonly serverValues: Record<string, unknown>;
}

/**
 * `FR-OFF-046` reconciliation exceptions — SYNC-OWNED (`GD-D1-05`, ratified
 * 2026-09-02, overturning the design gate's `governance.anomaly_flags`
 * recommendation, which would have made this lane wait on a table that does not
 * exist).
 *
 * ── THE RULE THIS SERVICE EXISTS TO MAKE UNAVOIDABLE ──────────────────────
 * `FR-OFF-046` [M]: "Where server revalidation produces a different result, the
 * server SHALL ACCEPT the transaction (the sale physically occurred), record
 * both values, and raise a reconciliation exception for review."
 *
 * There is deliberately no code path here that rejects, reverses or corrects an
 * operation. Raising an exception is the ONLY thing a mismatch does, because the
 * SRS's own rationale is blunt about the alternative: "Rejecting a synced sale
 * because the server disagrees about a price is not an option: the customer
 * already paid and left." This is the rule most likely to be implemented
 * wrongly, since every instinct in a validation layer says reject the bad data.
 *
 * ── SUBSTRATE ONLY IN D4-1A ───────────────────────────────────────────────
 * The financially significant computations that PRODUCE a mismatch — price
 * resolution, discounts, taxes, totals, loyalty accrual — are wired in D4-1B.
 * `FR-OFF-045`/`046`/`047` are therefore PARTIAL.
 */
@Injectable()
export class RevalidationExceptionService {
  constructor(private readonly audit: AuditService) {}

  /** Writes inside the caller's transaction; never rejects the operation. */
  async raise(
    tx: Prisma.TransactionClient,
    input: RaiseRevalidationExceptionInput,
  ): Promise<string> {
    const id = newId();
    await tx.syncRevalidationException.create({
      data: {
        id,
        tenantId: input.tenantId,
        branchId: input.branchId,
        terminalId: input.terminalId,
        opId: input.opId,
        entityType: input.entityType,
        entityId: input.entityId,
        clientValues: input.clientValues as Prisma.InputJsonValue,
        serverValues: input.serverValues as Prisma.InputJsonValue,
      },
    });

    await this.audit.record(tx, {
      tenantId: input.tenantId,
      action: AUDIT_ACTION.SYNC_REVALIDATION_EXCEPTION_RAISED,
      entityType: AUDIT_ENTITY.SYNC_REVALIDATION_EXCEPTION,
      entityId: id,
      actorType: 'system',
      terminalId: input.terminalId,
      reasonCode: 'revalidation_mismatch',
      metadata: {
        opId: input.opId,
        targetEntityType: input.entityType,
        targetEntityId: input.entityId,
        clientValues: input.clientValues,
        serverValues: input.serverValues,
      },
    });

    // FR-OFF-047 — "systematic revalidation mismatches from one terminal SHALL
    // be treated as a signal of stale reference data or client tampering".
    // The counter is maintained here; the configurable-threshold escalation to
    // a platform alert is D4-1B, which is why FR-OFF-047 is PARTIAL.
    await tx.syncDeviceState.updateMany({
      where: { tenantId: input.tenantId, terminalId: input.terminalId },
      data: { revalidationMismatchCount: { increment: 1 } },
    });
    return id;
  }
}
