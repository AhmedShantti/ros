import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessTokenService } from '../auth/access-token.service';
import { AuthorizationSnapshotService } from '../authz/authorization-snapshot.service';
import { TenantContext } from '../context/tenant-context';
import { TerminalSummary, toTerminalSummary } from './terminal.view';
import { TerminalsService } from './terminals.service';

export interface BindTerminalResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  terminal: TerminalSummary;
}

/**
 * Binds an authenticated, tenant-scoped session to a terminal. The terminal id
 * is validated server-side against the trusted TenantContext — a client cannot
 * bind to another tenant's terminal (invisible under RLS → 404) or to a
 * disabled/revoked terminal (403). The established terminal identity is minted
 * into the access token as `trm`; only these POS/terminal sessions carry it.
 */
@Injectable()
export class TerminalSessionService {
  private readonly accessTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly terminals: TerminalsService,
    private readonly tokens: AccessTokenService,
    private readonly snapshots: AuthorizationSnapshotService,
    config: ConfigService,
  ) {
    this.accessTtlSeconds = Math.floor(
      parseDurationMs(config.getOrThrow<string>('JWT_ACCESS_TTL')) / 1000,
    );
  }

  async bind(
    context: TenantContext,
    terminalId: string,
  ): Promise<BindTerminalResult> {
    const terminal = await this.terminals.findInTenant(
      context.tenantId,
      terminalId,
    );
    if (!terminal) {
      throw new NotFoundException('Terminal not found.');
    }
    if (terminal.status !== 'active') {
      throw new ForbiddenException('Terminal is not active.');
    }

    // sessions is not RLS-scoped; bind the caller's own session by id.
    await this.prisma.session.update({
      where: { id: context.sessionId },
      data: { terminalId },
    });

    // T-4-LIVE: re-minting a tenant-bound token re-mints the snapshot with it,
    // so a terminal-bound token is never left carrying an older epoch than the
    // token it replaced.
    const snapshot = await this.snapshots.build(
      context.userId,
      context.tenantId,
      context.membershipId,
    );
    const accessToken = await this.tokens.sign({
      sub: context.userId,
      sid: context.sessionId,
      tid: context.tenantId,
      mid: context.membershipId,
      trm: terminalId,
      scp: [...snapshot.scp],
      pbr: snapshot.pbr,
      epo: snapshot.epo,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
      terminal: toTerminalSummary(terminal),
    };
  }
}
