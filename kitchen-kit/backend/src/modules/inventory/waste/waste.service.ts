import { ForbiddenException, Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../../organisation/prisma-errors';
import { MovementsService } from '../movements/movements.service';

export interface RecordWasteInput {
  locationId: string;
  reasonCodeId: string;
  lines: { stockItemId: string; quantity: number }[];
  /** B-2: caller-supplied. Inventory NEVER evaluates a threshold. */
  requiresApproval?: boolean;
  notes?: string;
}

/**
 * Waste recording (FR-INV-055…059).
 *
 * Every waste posting writes `waste` movements, which the DB CHECK
 * `ck_reason_required` forces to carry a reason code — the fraud control §11.7
 * describes ("waste is the sanctioned way to make inventory disappear").
 *
 * B-2 approval gate: `requiresApproval` is caller-supplied. When true the
 * posting is REFUSED, because `governance.approval_requests` does not exist and
 * is not created here. FR-INV-058's threshold-driven variant is therefore
 * BLOCKED by the missing Governance context, and no threshold configuration is
 * invented.
 *
 * FR-INV-059 (true waste vs controlled consumption) is expressible through the
 * reason-code taxonomy, which is tenant-configurable.
 */
@Injectable()
export class WasteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly movements: MovementsService,
    private readonly audit: AuditService,
  ) {}

  async record(tenantId: string, actorId: string, input: RecordWasteInput) {
    if (input.requiresApproval) {
      throw new ForbiddenException(
        'This waste record requires approval before posting. The Governance ' +
          'approval workflow is not implemented in this phase, so the posting ' +
          'is refused rather than completed unapproved.',
      );
    }

    try {
      return await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const recordId = newId();
          let totalValue = 0n;
          const posted: { stockItemId: string; movementId: string }[] = [];
          const lineData: {
            stockItemId: string;
            quantity: number;
            unitCost: bigint;
          }[] = [];

          for (const line of input.lines) {
            const mv = await this.movements.post(tx, tenantId, actorId, {
              locationId: input.locationId,
              stockItemId: line.stockItemId,
              movementType: 'waste',
              quantity: -Math.abs(line.quantity),
              referenceType: 'waste',
              referenceId: recordId,
              reasonCodeId: input.reasonCodeId,
              notes: input.notes,
            });
            totalValue += BigInt(mv.totalCost);
            posted.push({ stockItemId: line.stockItemId, movementId: mv.id });
            lineData.push({
              stockItemId: line.stockItemId,
              quantity: Math.abs(line.quantity),
              unitCost: BigInt(mv.unitCost),
            });
          }

          // The parent MUST exist before its lines: waste_lines has no tenant_id
          // and inherits the boundary via EXISTS(waste_records) (ADR 0003), so
          // an orphan line is correctly rejected by RLS.
          await tx.wasteRecord.create({
            data: {
              id: recordId,
              tenantId,
              locationId: input.locationId,
              reasonCodeId: input.reasonCodeId,
              totalValue,
              requiresApproval: false,
              recordedBy: actorId,
            },
          });
          for (const l of lineData) {
            await tx.wasteLine.create({
              data: {
                id: newId(),
                wasteRecordId: recordId,
                stockItemId: l.stockItemId,
                quantity: l.quantity,
                unitCost: l.unitCost,
              },
            });
          }

          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.WASTE_RECORDED,
            entityType: AUDIT_ENTITY.WASTE_RECORD,
            actorType: 'user',
            actorId,
            entityId: recordId,
            metadata: {
              locationId: input.locationId,
              lineCount: input.lines.length,
              totalValue: totalValue.toString(),
            },
            reasonCode: 'waste',
          });

          return {
            id: recordId,
            totalValue: totalValue.toString(),
            lines: posted,
          };
        },
      );
    } catch (err) {
      rethrowAsNotFoundOnFk(
        err,
        'Location, reason code or stock item not found.',
      );
    }
  }

  list(tenantId: string) {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.wasteRecord.findMany({ orderBy: { recordedAt: 'desc' }, take: 200 }),
      )
      .then((rows) =>
        rows.map((r) => ({
          id: r.id,
          locationId: r.locationId,
          reasonCodeId: r.reasonCodeId,
          totalValue: r.totalValue.toString(),
          requiresApproval: r.requiresApproval,
          recordedAt: r.recordedAt,
        })),
      );
  }
}
