import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { User } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  SENTINEL_TENANT_ID,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { MembershipsService } from '../memberships/memberships.service';
import { SessionContext, SessionsService } from '../sessions/sessions.service';
import { TerminalsService } from '../terminals/terminals.service';
import { SafeUser, toSafeUser } from '../users/user.view';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { AuthorizationSnapshotService } from '../authz/authorization-snapshot.service';
import { AccessTokenService } from './access-token.service';
import { AuthTokens } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { PinService } from '../employees/pin.service';

@Injectable()
export class AuthService {
  private readonly accessTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsService,
    private readonly sessions: SessionsService,
    private readonly tokens: AccessTokenService,
    private readonly memberships: MembershipsService,
    private readonly terminals: TerminalsService,
    private readonly audit: AuditService,
    private readonly pins: PinService,
    private readonly snapshots: AuthorizationSnapshotService,
    config: ConfigService,
  ) {
    this.accessTtlSeconds = Math.floor(
      parseDurationMs(config.getOrThrow<string>('JWT_ACCESS_TTL')) / 1000,
    );
  }

  /**
   * Authenticate email + password. Unknown account, missing credential, wrong
   * password, and inactive account are all indistinguishable to the caller: a
   * single generic 401. A password verification always runs (timing guard).
   */
  async login(dto: LoginDto, ctx: SessionContext): Promise<AuthTokens> {
    const email = UsersService.normalizeEmail(dto.email);
    const user = await this.users.findByEmail(email);
    const credential = user
      ? await this.prisma.credential.findUnique({
          where: {
            userId_credentialType: {
              userId: user.id,
              credentialType: 'password',
            },
          },
        })
      : null;

    const passwordOk = await this.credentials.verifyPasswordSafe(
      credential?.secretHash ?? null,
      dto.password,
    );

    if (!user || !credential || !passwordOk || user.status !== 'active') {
      // Enumeration-safe: anonymous actor, no email/credential stored.
      await this.audit.emit({
        tenantId: SENTINEL_TENANT_ID,
        action: AUDIT_ACTION.LOGIN_FAILURE,
        entityType: AUDIT_ENTITY.USER,
        actorType: 'anonymous',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        reasonCode: 'invalid_credentials',
        metadata: { result: 'failure' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const { session, refreshToken } = await this.sessions.issue(user.id, ctx);
    const accessToken = await this.tokens.sign({
      sub: user.id,
      sid: session.id,
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.audit.emit({
      tenantId: SENTINEL_TENANT_ID,
      action: AUDIT_ACTION.LOGIN_SUCCESS,
      entityType: AUDIT_ENTITY.USER,
      actorType: 'user',
      actorId: user.id,
      entityId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { result: 'success', sessionId: session.id },
    });

    return this.buildTokens(accessToken, refreshToken, user);
  }

  /**
   * FR-SEC-020/021/022 — authenticate an employee by PIN at a registered
   * terminal and issue a POS-ONLY session.
   *
   * The issued access token carries `typ: 'pos'`, which `JwtAuthGuard` refuses
   * on every route that has not explicitly opted in. That is how "SHALL NOT
   * grant access to the web dashboard" is executable rather than aspirational:
   * even though the linked User may hold dashboard permissions, the session
   * audience denies those routes.
   */
  async loginWithPin(
    dto: PinLoginDto,
    ctx: SessionContext,
  ): Promise<AuthTokens> {
    const result = await this.pins.authenticate(
      dto.tenantId,
      dto.terminalId,
      dto.employeeCode,
      dto.pin,
    );

    const user = await this.users.findById(result.userId);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid PIN, terminal or employee.');
    }

    const { session, refreshToken } = await this.sessions.issue(user.id, {
      ...ctx,
      terminalId: result.terminalId,
    });
    // NOTE: the membership is deliberately NOT persisted onto the session row.
    // `refresh` rebuilds a token from `session.membershipId` and does not carry
    // the `pos` audience forward, so storing it there would let a PIN session
    // refresh itself into a full dashboard session — the exact escalation
    // FR-SEC-021 forbids. The consequence is that a POS session ends with its
    // access token and the employee re-enters their PIN; that is a smaller cost
    // than an escalation path, and POS refresh semantics are not source-decided.
    // `mid` is what makes the session AUTHORIZABLE: permissions are resolved
    // per request from the membership, so a POS token without it could reach no
    // permission-guarded route at all. `emp` names the employee behind the
    // session, which POS routes need as the acting party (FR-SEC-021).
    // T-4-LIVE: a tenant-bound token carries the SRS-required authorization
    // snapshot (FR-API-012 clause 1) and the epoch that makes it verifiable.
    // The snapshot never authorises — `TenantContextService` re-resolves live
    // on every request, and additionally re-checks this POS session's terminal
    // and permitted-branch facts.
    const snapshot = await this.snapshots.build(
      user.id,
      dto.tenantId,
      result.membershipId,
    );
    const accessToken = await this.tokens.sign({
      sub: user.id,
      sid: session.id,
      tid: dto.tenantId,
      mid: result.membershipId,
      trm: result.terminalId,
      emp: result.employeeId,
      typ: 'pos',
      scp: [...snapshot.scp],
      pbr: snapshot.pbr,
      epo: snapshot.epo,
    });

    await this.audit.emit({
      tenantId: dto.tenantId,
      action: AUDIT_ACTION.LOGIN_SUCCESS,
      entityType: AUDIT_ENTITY.USER,
      actorType: 'user',
      actorId: user.id,
      entityId: result.employeeId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      terminalId: result.terminalId,
      // No PIN, and nothing derived from it, ever enters the payload.
      metadata: { result: 'success', method: 'pin', sessionId: session.id },
    });

    return this.buildTokens(accessToken, refreshToken, user);
  }

  /**
   * Exchange a valid refresh token for a new access + refresh token pair. The
   * old refresh token is invalidated (rotation). Any invalid/expired/revoked/
   * reused token is a generic 401 (see SessionsService.rotate). If the account
   * has since become inactive, the freshly minted session is revoked and 401.
   */
  async refresh(
    refreshToken: string,
    ctx: SessionContext,
  ): Promise<AuthTokens> {
    const { session, refreshToken: nextRefreshToken } =
      await this.sessions.rotate(refreshToken, ctx);

    const user = await this.users.findById(session.userId);
    if (!user || user.status !== 'active') {
      await this.sessions.revoke(session.id);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Preserve tenant context across rotation, but only if the membership (and
    // its tenant) is still active; otherwise the refreshed token drops it.
    const context = session.membershipId
      ? await this.memberships.resolveActiveContext(
          user.id,
          session.membershipId,
        )
      : null;

    // Preserve terminal binding across rotation, but only while the terminal is
    // still active (a revoked/disabled terminal drops from the refreshed token).
    let terminalId: string | undefined;
    if (context && session.terminalId) {
      const terminal = await this.terminals.findInTenant(
        context.tenantId,
        session.terminalId,
      );
      if (terminal?.status === 'active') {
        terminalId = terminal.id;
      }
    }

    // A refreshed tenant-bound token gets a FRESH snapshot and epoch, so a
    // refresh is the supported way to recover from a stale-snapshot refusal.
    const snapshot = context
      ? await this.snapshots.build(
          user.id,
          context.tenantId,
          context.membershipId,
        )
      : null;
    const accessToken = await this.tokens.sign({
      sub: user.id,
      sid: session.id,
      ...(context ? { tid: context.tenantId, mid: context.membershipId } : {}),
      ...(terminalId ? { trm: terminalId } : {}),
      ...(snapshot
        ? { scp: [...snapshot.scp], pbr: snapshot.pbr, epo: snapshot.epo }
        : {}),
    });
    return this.buildTokens(accessToken, nextRefreshToken, user);
  }

  /** Revoke the caller's current session server-side. Idempotent. */
  async logout(userId: string, sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
    await this.audit.emit({
      tenantId: SENTINEL_TENANT_ID,
      action: AUDIT_ACTION.LOGOUT,
      entityType: AUDIT_ENTITY.SESSION,
      actorType: 'user',
      actorId: userId,
      entityId: sessionId,
      metadata: { result: 'success' },
    });
  }

  /** Current authenticated user; credential-free view. Surfaces the (advisory)
   *  must_reset flag from the password credential without exposing any hash. */
  async me(userId: string): Promise<SafeUser & { mustReset: boolean }> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    const credential = await this.prisma.credential.findUnique({
      where: { userId_credentialType: { userId, credentialType: 'password' } },
      select: { mustReset: true },
    });
    return { ...toSafeUser(user), mustReset: credential?.mustReset ?? false };
  }

  private buildTokens(
    accessToken: string,
    refreshToken: string,
    user: User,
  ): AuthTokens {
    return {
      tokenType: 'Bearer',
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      user: toSafeUser(user),
    };
  }
}
