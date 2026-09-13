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
import { EmployeesService } from '../employees/employees.service';
import { TerminalSummary, toTerminalSummary } from './terminal.view';
import { TerminalsService } from './terminals.service';

export interface BindTerminalResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  terminal: TerminalSummary;
}

/**
 * CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (2026-09-13): this is now the
 * Sync/offline device channel's OWN session-binding mechanism, and
 * nothing else's. POS and KDS mint their branch-scoped session directly at
 * PIN login (`AuthService.loginWithPin`) and never call this — see
 * `AuthenticatedPrincipal.terminalId`'s docblock. Genuinely independent
 * subsystem kept unmodified per the P0 report §4/§17: `SyncTerminalGuard`
 * fail-closed-gates every sync route on the `trm` claim this mints.
 *
 * Binds an authenticated, tenant-scoped session to a terminal. The terminal id
 * is validated server-side against the trusted TenantContext — a client cannot
 * bind to another tenant's terminal (invisible under RLS → 404) or to a
 * disabled/revoked terminal (403). The established terminal identity is minted
 * into the access token as `trm`.
 */
@Injectable()
export class TerminalSessionService {
  private readonly accessTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly terminals: TerminalsService,
    private readonly tokens: AccessTokenService,
    private readonly snapshots: AuthorizationSnapshotService,
    private readonly employees: EmployeesService,
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

    // DEMO-POS-EMPLOYEE-SESSION-HOTFIX — a terminal-bound token must carry
    // the employee behind it whenever the caller IS one (`Employee.userId`
    // is unique, so this is a safe, unambiguous derivation — no migration,
    // no new session column). A caller with no linked Employee (a pure
    // Sync/offline-device-binding back-office user, say) simply gets no
    // `emp` claim, exactly as before.
    const employee = await this.employees.findByUser(
      context.tenantId,
      context.userId,
    );
    const accessToken = await this.tokens.sign({
      sub: context.userId,
      sid: context.sessionId,
      tid: context.tenantId,
      mid: context.membershipId,
      trm: terminalId,
      ...(employee?.status === 'active' ? { emp: employee.id } : {}),
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
