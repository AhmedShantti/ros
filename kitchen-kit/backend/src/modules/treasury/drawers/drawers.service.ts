/**
 * Drawer — the physical cash container (FR-FIN-001 [M]).
 *
 * A branch-level master identity. It holds no balance and no float: those belong
 * to the CashSession open over it.
 *
 * ── ADMINISTRATION SURFACE (DEMO-OPS-HOTFIX-3) ──────────────────────────────
 * The SRS defines no drawer-management endpoint and §15.2 contains no
 * drawer-admin permission — so `create`/`listForBranch` are exposed on
 * `DrawersController` (`branches/:branchId/drawers`) reusing
 * `settings.branch.manage` (`TREASURY_PERMISSIONS.SETTINGS_BRANCH_MANAGE`,
 * the SAME code `CashClosePolicyController` already uses for this exact kind
 * of branch-scoped Treasury configuration), never `cash.session.open` and
 * never an invented permission. `listForTerminal` is exposed on
 * `TreasuryController` (`GET /cash-sessions/drawers`, POS-session-only) so a
 * Cashier can select a real drawer to open their own shift over — gated on
 * `cash.session.open` (the permission they already need for the shift
 * itself), never on `settings.branch.manage`, so this cannot be mistaken for
 * a drawer-administration grant. Drawers are still NOT auto-created per
 * terminal — no source says a terminal implies a drawer, and inventing that
 * rule would silently give every KDS screen a till; every drawer here is an
 * explicit, named administrative act.
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
   * Provision a drawer, via `DrawersController` (`settings.branch.manage`).
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

  async listForBranch(tenantId: string, branchId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const branch = await tx.branch.findUnique({
        where: { id: branchId },
        select: { id: true },
      });
      if (!branch) {
        throw new NotFoundException('Branch not found.');
      }
      return tx.drawer.findMany({
        where: { branchId },
        orderBy: { name: 'asc' },
      });
    });
  }

  /**
   * The drawers a POS session's OWN terminal-bound branch may open a shift
   * over — for the Cashier-facing drawer selector on `GET
   * /cash-sessions/drawers`. Resolves the terminal's branch itself (never a
   * caller-supplied branchId), mirroring `CashSessionsService.open`'s own
   * terminal-to-branch resolution — a terminal in another tenant is
   * invisible under RLS and surfaces as 404, never a drawer list for a
   * branch the caller does not actually operate from.
   */
  async listForTerminal(tenantId: string, terminalId: string) {
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const terminal = await tx.terminal.findUnique({
        where: { id: terminalId },
        select: { branchId: true },
      });
      if (!terminal) {
        throw new NotFoundException('Terminal not found.');
      }
      return tx.drawer.findMany({
        where: { branchId: terminal.branchId },
        orderBy: { name: 'asc' },
      });
    });
  }
}
