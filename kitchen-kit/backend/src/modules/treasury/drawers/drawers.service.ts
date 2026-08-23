/**
 * Drawer — the physical cash container (FR-FIN-001 [M]).
 *
 * A branch-level master identity. It holds no balance and no float: those belong
 * to the CashSession open over it.
 *
 * ── NO PUBLIC ADMINISTRATION SURFACE, AND WHY ──────────────────────────────
 * The SRS defines no drawer-management endpoint and §15.2 contains no
 * drawer-admin permission. `cash.drawer.open_no_sale` is about opening the
 * physical till without a sale, not about creating drawer records. So:
 *
 *   · no public route is exposed;
 *   · `cash.session.open` is NOT misused as a drawer-admin authority;
 *   · no permission is invented to fill the gap;
 *   · and drawers are NOT auto-created per terminal — no source says a terminal
 *     implies a drawer, and inventing that rule would silently give every KDS
 *     screen a till.
 *
 * The persistence substrate exists so FR-FIN-001 is modelled and so the session
 * command has something real to reference. Provisioning is an internal
 * application call today; the missing operator surface is reported, not faked.
 */

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

export interface CreateDrawerInput {
  readonly id?: string;
  readonly branchId: string;
  readonly name: string;
  /**
   * Optional device binding. When set, a session may only be opened from THAT
   * terminal. Same-branch is enforced by the database, not here.
   */
  readonly terminalId?: string | null;
}

export interface ResolvedDrawer {
  readonly id: string;
  readonly branchId: string;
  readonly name: string;
  readonly terminalId: string | null;
  readonly isActive: boolean;
}

@Injectable()
export class DrawersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Provision a drawer. INTERNAL — no HTTP route reaches this.
   *
   * Reads and writes through `withAuthContext`, so RLS applies: a branch or
   * terminal belonging to another tenant is invisible and surfaces as 404.
   */
  async create(
    tenantId: string,
    actorUserId: string,
    input: CreateDrawerInput,
  ) {
    return this.prisma.withAuthContext(
      { userId: actorUserId, tenantId },
      async (tx) => {
        const branch = await tx.branch.findUnique({
          where: { id: input.branchId },
          select: { id: true },
        });
        if (!branch) throw new NotFoundException('Branch not found.');

        if (input.terminalId) {
          const terminal = await tx.terminal.findUnique({
            where: { id: input.terminalId },
            select: { id: true, branchId: true },
          });
          if (!terminal) throw new NotFoundException('Terminal not found.');
          if (terminal.branchId !== branch.id) {
            throw new ConflictException(
              'That terminal is not registered to this branch.',
            );
          }
        }

        return tx.drawer.create({
          data: {
            id: input.id ?? newId(),
            tenantId,
            branchId: branch.id,
            name: input.name,
            terminalId: input.terminalId ?? null,
          },
        });
      },
    );
  }

  /**
   * The drawer a session is being opened over, resolved on the CALLER's
   * transaction so the whole open is one unit of work.
   *
   * Every rejection is a 404 or a business conflict that discloses nothing about
   * another tenant's or branch's drawers:
   *   · another tenant's drawer   -> invisible under RLS -> 404
   *   · another branch's drawer   -> 404, not "wrong branch"
   *   · inactive drawer           -> conflict
   *   · terminal-bound elsewhere  -> conflict
   */
  async requireForBranch(
    tx: Prisma.TransactionClient,
    drawerId: string,
    branchId: string,
    terminalId: string,
  ): Promise<ResolvedDrawer> {
    const drawer = await tx.drawer.findUnique({
      where: { id: drawerId },
      select: {
        id: true,
        branchId: true,
        name: true,
        terminalId: true,
        isActive: true,
      },
    });
    // A drawer in another branch is reported exactly as a missing one: telling a
    // caller "that exists, but elsewhere" is itself a disclosure.
    if (!drawer || drawer.branchId !== branchId) {
      throw new NotFoundException('Drawer not found.');
    }
    if (!drawer.isActive) {
      throw new ConflictException('That drawer is not in service.');
    }
    if (drawer.terminalId !== null && drawer.terminalId !== terminalId) {
      throw new ConflictException(
        'That drawer is bound to a different terminal and cannot be opened from this one.',
      );
    }
    return drawer;
  }

  listForBranch(tenantId: string, branchId: string) {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.drawer.findMany({ where: { branchId }, orderBy: { name: 'asc' } }),
    );
  }
}
