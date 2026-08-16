import { Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { assertBranchInScope } from '../branch-scope';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import {
  PrintRoutingSummary,
  toPrintRoutingSummary,
} from './print-routing.view';

const STATION_NOT_FOUND = 'Station not found in this branch.';
const CONFLICT =
  'A print routing rule for this document type and station already exists.';

export interface CreatePrintRoutingInput {
  documentType: string;
  printerTarget: string;
  stationId?: string;
}

/**
 * Print routing configuration (Branch aggregate).
 *
 * Uniqueness is `(branch_id, document_type, station_id)` with **NULLS NOT
 * DISTINCT** (ADR 0008 D-15, applied in the migration). PostgreSQL's default
 * would treat NULL station ids as distinct, which would let unlimited duplicate
 * branch-level defaults accumulate — exactly the row shape the constraint exists
 * to de-duplicate. Prisma cannot express `NULLS NOT DISTINCT`, so the migration
 * replaces the generated index.
 */
@Injectable()
export class PrintRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    branchId: string,
    input: CreatePrintRoutingInput,
  ): Promise<PrintRoutingSummary> {
    try {
      const rule = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          await assertBranchInScope(tx, branchId);
          const created = await tx.printRouting.create({
            data: {
              id: newId(),
              branchId,
              documentType: input.documentType,
              printerTarget: input.printerTarget,
              stationId: input.stationId ?? null,
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.PRINT_ROUTING_CREATED,
            entityType: AUDIT_ENTITY.PRINT_ROUTING,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: {
              branchId,
              documentType: created.documentType,
              stationId: created.stationId,
            },
          });
          return created;
        },
      );
      return toPrintRoutingSummary(rule);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, STATION_NOT_FOUND, CONFLICT);
    }
  }

  listForBranch(
    tenantId: string,
    branchId: string,
  ): Promise<PrintRoutingSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        await assertBranchInScope(tx, branchId);
        return tx.printRouting.findMany({
          where: { branchId },
          orderBy: { documentType: 'asc' },
        });
      })
      .then((rows) => rows.map(toPrintRoutingSummary));
  }
}
