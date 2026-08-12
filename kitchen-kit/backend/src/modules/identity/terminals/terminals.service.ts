import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../../common/ids';
import {
  Prisma,
  Terminal,
  TerminalStatus,
  TerminalType,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { hashDeviceFingerprint } from './device-fingerprint';
import { TerminalSummary, toTerminalSummary } from './terminal.view';

export interface RegisterTerminalInput {
  name: string;
  terminalType: TerminalType;
  branchId: string;
  deviceFingerprint?: string;
  os?: string;
  appVersion?: string;
}

export interface RegisterFingerprintInput {
  deviceFingerprint: string;
  os?: string;
  appVersion?: string;
}

/**
 * Terminal identity administration. Every query runs under the acting tenant's
 * RLS context (app.tenant_id), so a terminal is only ever visible/mutable within
 * its own tenant — the DB is the final boundary against cross-tenant access.
 * Raw device fingerprints are hashed and never persisted or logged.
 */
@Injectable()
export class TerminalsService {
  constructor(private readonly prisma: PrismaService) {}

  async register(
    tenantId: string,
    input: RegisterTerminalInput,
  ): Promise<TerminalSummary> {
    try {
      const terminal = await this.prisma.withAuthContext(
        { tenantId },
        async (tx) => {
          const created = await tx.terminal.create({
            data: {
              id: newId(),
              tenantId,
              branchId: input.branchId,
              name: input.name,
              terminalType: input.terminalType,
            },
          });
          if (input.deviceFingerprint) {
            await tx.deviceFingerprint.create({
              data: {
                id: newId(),
                terminalId: created.id,
                fingerprintHash: hashDeviceFingerprint(input.deviceFingerprint),
                os: input.os ?? null,
                appVersion: input.appVersion ?? null,
              },
            });
          }
          return created;
        },
      );
      return toTerminalSummary(terminal);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(
          'A terminal with this name already exists in the branch.',
        );
      }
      throw err;
    }
  }

  /** Idempotent device registration on a terminal (same fingerprint → no-op). */
  async addFingerprint(
    tenantId: string,
    terminalId: string,
    input: RegisterFingerprintInput,
  ): Promise<void> {
    const fingerprintHash = hashDeviceFingerprint(input.deviceFingerprint);
    await this.prisma.withAuthContext({ tenantId }, async (tx) => {
      const terminal = await tx.terminal.findUnique({
        where: { id: terminalId },
      });
      if (!terminal) {
        throw new NotFoundException('Terminal not found.');
      }
      // Idempotent: the same fingerprint on the same terminal is a no-op. Uses
      // check-then-create (not upsert) because device_fingerprints is
      // append-only under RLS (no UPDATE policy).
      const existing = await tx.deviceFingerprint.findUnique({
        where: { terminalId_fingerprintHash: { terminalId, fingerprintHash } },
      });
      if (existing) {
        return;
      }
      await tx.deviceFingerprint.create({
        data: {
          id: newId(),
          terminalId,
          fingerprintHash,
          os: input.os ?? null,
          appVersion: input.appVersion ?? null,
        },
      });
    });
  }

  listForTenant(tenantId: string): Promise<TerminalSummary[]> {
    return this.prisma
      .withAuthContext({ tenantId }, (tx) =>
        tx.terminal.findMany({ orderBy: { createdAt: 'asc' } }),
      )
      .then((terminals) => terminals.map(toTerminalSummary));
  }

  async setStatus(
    tenantId: string,
    terminalId: string,
    status: TerminalStatus,
  ): Promise<TerminalSummary> {
    const terminal = await this.prisma.withAuthContext(
      { tenantId },
      async (tx) => {
        const found = await tx.terminal.findUnique({
          where: { id: terminalId },
        });
        if (!found) {
          // Cross-tenant terminal is invisible under RLS → 404 (no probing).
          throw new NotFoundException('Terminal not found.');
        }
        return tx.terminal.update({
          where: { id: terminalId },
          data: { status },
        });
      },
    );
    return toTerminalSummary(terminal);
  }

  /** Look up a terminal for session binding within the acting tenant. */
  findInTenant(tenantId: string, terminalId: string): Promise<Terminal | null> {
    return this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.terminal.findUnique({ where: { id: terminalId } }),
    );
  }
}
