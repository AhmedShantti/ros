import { Injectable, NotFoundException } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { rethrowAsNotFoundOnFk } from '../prisma-errors';
import { StationSummary, toStationSummary } from './station.view';

const NAME_CONFLICT = 'A station with this name already exists in the branch.';
// P2003 on insert/update can be either the branch FK or the D-16 composite
// terminal FK; both mean "not found within your tenant/branch".
const PARENT_NOT_FOUND = 'Branch or display terminal not found.';

export interface CreateStationInput {
  name: string;
  capacityConfig?: Record<string, unknown>;
  displayTerminalId?: string;
  displayColour?: string;
}

export type UpdateStationInput = Partial<CreateStationInput>;

/**
 * Station administration. Station is an Organisation aggregate root (ADR 0008
 * D-07), but it carries NO tenant_id: tenant scope is inherited through its
 * branch, and RLS resolves it via `EXISTS (branches b WHERE b.id = branch_id AND
 * b.tenant_id = app.tenant_id)` — the same child-inheritance pattern proven in
 * Phases 8/9.
 */
@Injectable()
export class StationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    actorId: string,
    branchId: string,
    input: CreateStationInput,
  ): Promise<StationSummary> {
    try {
      const station = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          // Foreign branches are invisible under RLS → 404 (no probing).
          await assertBranch(tx, branchId);
          const created = await tx.station.create({
            data: {
              id: newId(),
              branchId,
              name: input.name,
              ...(input.capacityConfig !== undefined
                ? {
                    capacityConfig:
                      input.capacityConfig as Prisma.InputJsonValue,
                  }
                : {}),
              displayTerminalId: input.displayTerminalId ?? null,
              displayColour: input.displayColour ?? null,
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.STATION_CREATED,
            entityType: AUDIT_ENTITY.STATION,
            actorType: 'user',
            actorId,
            entityId: created.id,
            metadata: { branchId, name: created.name },
          });
          return created;
        },
      );
      return toStationSummary(station);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND, NAME_CONFLICT);
    }
  }

  listForBranch(tenantId: string, branchId: string): Promise<StationSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, async (tx) => {
        await assertBranch(tx, branchId);
        return tx.station.findMany({
          where: { branchId },
          orderBy: { createdAt: 'asc' },
        });
      })
      .then((rows) => rows.map(toStationSummary));
  }

  async findOne(tenantId: string, stationId: string): Promise<StationSummary> {
    const station = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.station.findUnique({ where: { id: stationId } }),
    );
    if (!station) {
      throw new NotFoundException('Station not found.');
    }
    return toStationSummary(station);
  }

  async update(
    tenantId: string,
    actorId: string,
    stationId: string,
    input: UpdateStationInput,
  ): Promise<StationSummary> {
    try {
      const station = await this.prisma.withAuthContext(
        { userId: actorId, tenantId },
        async (tx) => {
          const existing = await tx.station.findUnique({
            where: { id: stationId },
          });
          if (!existing) {
            throw new NotFoundException('Station not found.');
          }
          const updated = await tx.station.update({
            where: { id: stationId },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.capacityConfig !== undefined
                ? {
                    capacityConfig:
                      input.capacityConfig as Prisma.InputJsonValue,
                  }
                : {}),
              ...(input.displayTerminalId !== undefined
                ? { displayTerminalId: input.displayTerminalId }
                : {}),
              ...(input.displayColour !== undefined
                ? { displayColour: input.displayColour }
                : {}),
            },
          });
          await this.audit.record(tx, {
            tenantId,
            action: AUDIT_ACTION.STATION_UPDATED,
            entityType: AUDIT_ENTITY.STATION,
            actorType: 'user',
            actorId,
            entityId: stationId,
            before: {
              name: existing.name,
              displayTerminalId: existing.displayTerminalId,
              displayColour: existing.displayColour,
            },
            metadata: {
              name: updated.name,
              displayTerminalId: updated.displayTerminalId,
              displayColour: updated.displayColour,
            },
          });
          return updated;
        },
      );
      return toStationSummary(station);
    } catch (err) {
      rethrowAsNotFoundOnFk(err, PARENT_NOT_FOUND, NAME_CONFLICT);
    }
  }
}

async function assertBranch(
  tx: Prisma.TransactionClient,
  branchId: string,
): Promise<void> {
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) {
    throw new NotFoundException('Branch not found.');
  }
}
