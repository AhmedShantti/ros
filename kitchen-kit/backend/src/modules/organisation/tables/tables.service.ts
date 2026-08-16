import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { assertBranchInScope } from '../branch-scope';
import { rethrowAsConflict } from '../prisma-errors';
import { BranchTableSummary, toBranchTableSummary } from './branch-table.view';

const LABEL_CONFLICT = 'A table with this label already exists in the branch.';

export interface CreateTableInput {
  label: string;
  section?: string;
  seatCapacity?: number;
}

export type UpdateTableInput = Partial<CreateTableInput>;

/** Branch tables — physical/service locations under a branch (Branch aggregate). */
@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    branchId: string,
    input: CreateTableInput,
  ): Promise<BranchTableSummary> {
    try {
      const table = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          await assertBranchInScope(tx, branchId);
          const created = await tx.branchTable.create({
            data: {
              id: newId(),
              branchId,
              label: input.label,
              section: input.section ?? null,
              seatCapacity: input.seatCapacity ?? null,
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.TABLE_CREATED,
            entityType: AUDIT_ENTITY.TABLE,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: { branchId, label: created.label },
          });
          return created;
        },
      );
      return toBranchTableSummary(table);
    } catch (err) {
      rethrowAsConflict(err, LABEL_CONFLICT);
    }
  }

  listForBranch(
    tenantId: string,
    branchId: string,
  ): Promise<BranchTableSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        await assertBranchInScope(tx, branchId);
        return tx.branchTable.findMany({
          where: { branchId },
          orderBy: { label: 'asc' },
        });
      })
      .then((rows) => rows.map(toBranchTableSummary));
  }

  async update(
    tenantId: string,
    actorId: string,
    tableId: string,
    input: UpdateTableInput,
  ): Promise<BranchTableSummary> {
    try {
      const table = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.branchTable.findUnique({
            where: { id: tableId },
          });
          if (!existing) {
            throw new NotFoundException('Table not found.');
          }
          const updated = await tx.branchTable.update({
            where: { id: tableId },
            data: {
              ...(input.label !== undefined ? { label: input.label } : {}),
              ...(input.section !== undefined
                ? { section: input.section }
                : {}),
              ...(input.seatCapacity !== undefined
                ? { seatCapacity: input.seatCapacity }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.TABLE_UPDATED,
            entityType: AUDIT_ENTITY.TABLE,
            actorType: 'user',
            actorId,
            entityId: tableId,
            before: { label: existing.label },
            metadata: { label: updated.label },
          });
          return updated;
        },
      );
      return toBranchTableSummary(table);
    } catch (err) {
      rethrowAsConflict(err, LABEL_CONFLICT);
    }
  }
}
