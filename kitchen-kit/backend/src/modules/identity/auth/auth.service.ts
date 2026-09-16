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
import { TenantContextService } from '../context/tenant-context.service';
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
  /** FR-SEC-026 idle defaults — see env.validation.ts for the configured minutes/hours. */
  private readonly posIdleTimeoutMs: number;
  private readonly kdsIdleTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersRepository,
    private readonly credentials: CredentialsService,
    private readonly sessions: SessionsService,
    private readonly tokens: AccessTokenService,
    private readonly memberships: MembershipsService,
    /**
     * Sync/offline device channel ONLY — used solely to re-check a bound
     * terminal's live status when preserving a `trm` claim across refresh.
     * See `refresh()`'s own docblock.
     */
    private readonly terminals: TerminalsService,
    private readonly audit: AuditService,
    private readonly pins: PinService,
    private readonly snapshots: AuthorizationSnapshotService,
    /**
     * POS-KDS-SESSION-CONTINUITY-P0 — reuses `resolveEmployeeBranch()`, the
     * SAME definition of a valid POS/KDS branch identity every ordinary
     * live request already uses, for `refresh()`'s POS/KDS revalidation.
     * See `refresh()`'s own docblock.
     */
    private readonly tenantContext: TenantContextService,
    config: ConfigService,
  ) {
    this.accessTtlSeconds = Math.floor(
      parseDurationMs(config.getOrThrow<string>('JWT_ACCESS_TTL')) / 1000,
    );
    this.posIdleTimeoutMs =
      config.getOrThrow<number>('POS_IDLE_TIMEOUT_MINUTES') * 60_000;
    this.kdsIdleTimeoutMs =
      config.getOrThrow<number>('KDS_IDLE_TIMEOUT_HOURS') * 3_600_000;
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
   * FR-SEC-020/021/022 — authenticate an employee by PIN for a chosen
   * operating branch and issue a POS-or-KDS-ONLY session.
   *
   * ── CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0 (PRODUCT DECISION) ──────────
   * POS and KDS are APPLICATION SESSIONS, not registered device identities.
   * The original FR-SEC-020/021 "terminal" wording is SUPERSEDED for this
   * flow: there is no terminal to bind, register, revoke or carry in the
   * token. `dto.sessionType` selects which of the two disjoint audiences
   * (`pos`/`kds`) is issued.
   *
   * The issued access token carries `typ: 'pos' | 'kds'`, which
   * `JwtAuthGuard` refuses on every route that has not explicitly opted in
   * to that exact audience. That is how "SHALL NOT grant access to the web
   * dashboard" is executable rather than aspirational: even though the
   * linked User may hold dashboard permissions, the session audience denies
   * those routes.
   */
  async loginWithPin(
    dto: PinLoginDto,
    ctx: SessionContext,
  ): Promise<AuthTokens> {
    const result = await this.pins.authenticate(
      dto.tenantId,
      dto.branchId,
      dto.employeeCode,
      dto.pin,
    );

    const user = await this.users.findById(result.userId);
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('Invalid PIN, branch or employee.');
    }

    // POS-KDS-SESSION-CONTINUITY-P0 (FR-SEC-026 idle-expiry model, design
    // report `docs/reports/claude/2026-09-16_POS-KDS-SESSION-CONTINUITY-P0_
    // investigation.md`) — `sessionType`/`employeeId`/`branchId`/
    // `membershipId` are now persisted onto the session row, server-derived
    // from THIS authenticated PIN result only, never from client input.
    // `refresh()` branches on `session.sessionType` FIRST and always mints
    // `typ`/`emp`/`brc` together with `tid`/`mid` for a `pos`/`kds` row —
    // never separately — so persisting `membershipId` here no longer risks
    // a PIN session refreshing into an indistinguishable-from-console
    // token, the escalation the OLD comment (removed) warned about. `mid`
    // is what makes the session AUTHORIZABLE: permissions are resolved per
    // request from the membership, so a POS/KDS token without it could
    // reach no permission-guarded route at all. `emp` names the employee
    // behind the session, which POS/KDS routes need as the acting party
    // (FR-SEC-021).
    // T-4-LIVE: a tenant-bound token carries the SRS-required authorization
    // snapshot (FR-API-012 clause 1) and the epoch that makes it verifiable.
    // The snapshot never authorises — `TenantContextService` re-resolves live
    // on every request, and additionally re-checks this session's employee and
    // permitted-branch facts (`brc`).
    const { session, refreshToken } = await this.sessions.issue(
      user.id,
      ctx,
      {
        sessionType: dto.sessionType,
        employeeId: result.employeeId,
        branchId: result.branchId,
        membershipId: result.membershipId,
      },
    );
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
      brc: result.branchId,
      emp: result.employeeId,
      typ: dto.sessionType,
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
      // No PIN, and nothing derived from it, ever enters the payload.
      metadata: {
        result: 'success',
        method: 'pin',
        sessionId: session.id,
        sessionType: dto.sessionType,
        branchId: result.branchId,
      },
    });

    return this.buildTokens(accessToken, refreshToken, user);
  }

  /**
   * Exchange a valid refresh token for a new access + refresh token pair. The
   * old refresh token is invalidated (rotation). Any invalid/expired/revoked/
   * reused token is a generic 401 (see SessionsService.rotate). If the account
   * has since become inactive, the freshly minted session is revoked and 401.
   *
   * POS-KDS-SESSION-CONTINUITY-P0 (FR-SEC-026) — a `pos`/`kds` session is
   * handled entirely by `refreshPosOrKds()` below: the access-token TTL
   * boundary is NOT a human-session boundary, so an actively operating
   * POS/KDS terminal survives any number of ordinary rotations, and PIN is
   * required only once the session's own idle timeout is exceeded or a
   * genuine invalidation is found. This CORRECTS a previous, unratified
   * assumption (removed) that a POS/KDS session was meant to simply end at
   * every refresh, attributed in an earlier version of this comment to
   * "the deliberate FR-SEC-021 boundary" — no ratified governance decision
   * ever said that (`CROSSCUT-POS-KDS-TERMINAL-DECOUPLING-P0` concerns only
   * removing terminal/device binding; FR-SEC-021 concerns PIN's branch
   * scoping and dashboard exclusion, not refresh-boundary session
   * lifetime). See the design report's Phase 8 for the full governance
   * trace. No governance deviation was needed: this restores FR-SEC-026's
   * own required idle-expiry semantics.
   */
  async refresh(
    refreshToken: string,
    ctx: SessionContext,
  ): Promise<AuthTokens> {
    const {
      session,
      refreshToken: nextRefreshToken,
      priorActivityAt,
    } = await this.sessions.rotate(refreshToken, ctx);

    const user = await this.users.findById(session.userId);
    if (!user || user.status !== 'active') {
      await this.sessions.revoke(session.id);
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.sessionType === 'pos' || session.sessionType === 'kds') {
      return this.refreshPosOrKds(
        session,
        session.sessionType,
        nextRefreshToken,
        user,
        priorActivityAt,
      );
    }

    // ── Console/dashboard path — UNCHANGED from before this task ─────────
    // Preserve tenant context across rotation, but only if the membership (and
    // its tenant) is still active; otherwise the refreshed token drops it.
    const context = session.membershipId
      ? await this.memberships.resolveActiveContext(
          user.id,
          session.membershipId,
        )
      : null;

    // The Sync/offline device channel's OWN terminal binding (`trm`, minted
    // by `POST /auth/terminal` — see `terminal-session.service.ts`'s own
    // docblock) IS preserved across refresh: a long-lived Sync device
    // session must not lose its binding on every token rotation.
    // Re-checked live so a revoked/disabled terminal drops from the
    // refreshed token, same as any other live-state check. A `pos`/`kds`
    // session never reaches this path (never sets `terminalId`) — see
    // `refreshPosOrKds()` above.
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

  /**
   * POS-KDS-SESSION-CONTINUITY-P0 — refresh for a session whose persisted
   * `sessionType` is `pos`/`kds`. Restores FR-SEC-026's configurable
   * IDLE-expiry model in place of the access-token TTL: idle time is
   * measured from `priorActivityAt` (the session's activity timestamp AS
   * IT WAS immediately before this rotation — see
   * `SessionsService.rotate()`'s own docblock), NEVER from the JWT `exp`
   * claim and NEVER from a client-supplied timestamp.
   *
   * Every fact restored into the new token — `typ`/`emp`/`brc`/`tid`/`mid`/
   * `scp`/`pbr`/`epo` — is re-derived from CURRENT database state, reached
   * through the session row's own persisted anchors
   * (`sessionType`/`employeeId`/`branchId`/`membershipId`), using EXACTLY
   * the same live invariants (`resolveActiveContext`,
   * `TenantContextService.resolveEmployeeBranch`) every ordinary POS/KDS
   * request already re-checks — never reconstructed from the old access
   * token's claims and never accepted from client input. This is not a
   * manufactured console context: it is the SAME real membership
   * `PinService.authenticate()` already resolves at PIN login
   * (`Membership` is unique per `[userId, tenantId]`), re-verified live.
   *
   * Any failure (idle-expired, account/membership/tenant/employee/branch no
   * longer valid) revokes the freshly-rotated session and fails the SAME
   * generic 401 `SessionsService.rotate()` already uses for every other
   * refresh failure — a POS/KDS session must not be distinguishable, from
   * the outside, from any other refresh failure, and it must NEVER
   * silently degrade into a console-shaped token instead of ending.
   */
  private async refreshPosOrKds(
    session: { id: string; employeeId: string | null; branchId: string | null; membershipId: string | null },
    sessionType: 'pos' | 'kds',
    nextRefreshToken: string,
    user: User,
    priorActivityAt: Date,
  ): Promise<AuthTokens> {
    const fail = async (): Promise<never> => {
      await this.sessions.revoke(session.id);
      throw new UnauthorizedException('Invalid refresh token');
    };

    // Defensive: `issue()`/`rotate()` always set these three together for a
    // pos/kds row. Their absence means the row is inconsistent — never
    // trust a partial POS/KDS identity.
    if (!session.employeeId || !session.branchId || !session.membershipId) {
      return fail();
    }

    // FR-SEC-026 idle expiry — the primary requirement this task restores.
    // Checked BEFORE any identity is restored: idle time exceeded means the
    // session is over, full stop, regardless of whether the account/
    // employee/branch would otherwise still validate.
    const idleTimeoutMs =
      sessionType === 'pos' ? this.posIdleTimeoutMs : this.kdsIdleTimeoutMs;
    if (Date.now() - priorActivityAt.getTime() >= idleTimeoutMs) {
      return fail();
    }

    // The employee's tenant, reached WITHOUT an RLS chicken-and-egg:
    // `identity.employees`/`org.branches` require `app.tenant_id` to
    // already be set to be readable at all, so tenant must come from
    // somewhere RLS-free first. `identity.memberships`' SELECT policy
    // allows a user-scoped read of THEIR OWN membership by id
    // (`identity_rls` migration) — the exact same mechanism the console
    // path above already relies on via `resolveActiveContext`. This also
    // re-verifies the membership and its tenant are still active.
    const context = await this.memberships.resolveActiveContext(
      user.id,
      session.membershipId,
    );
    if (!context) {
      return fail();
    }

    // Employee still exists, still active, still belongs to the SAME
    // tenant (RLS-enforced — a cross-tenant employeeId is invisible here),
    // and is still permitted at this branch, which itself still exists and
    // is active. The SAME live check every ordinary POS/KDS request already
    // runs per-request (`TenantContextService.resolveSessionBranch`) — one
    // definition of a valid POS/KDS branch identity, never two.
    let branchId: string;
    try {
      branchId = await this.prisma.withAuthContext(
        { userId: user.id, tenantId: context.tenantId },
        (tx) =>
          this.tenantContext.resolveEmployeeBranch(
            tx,
            session.employeeId as string,
            session.branchId as string,
          ),
      );
    } catch {
      return fail();
    }

    // A refreshed POS/KDS token gets a FRESH snapshot and epoch too — the
    // same "refresh recovers from a stale snapshot" property the console
    // path already had, now genuinely available to POS/KDS (it never was
    // before this task: a bare PIN session's refresh restored nothing).
    const snapshot = await this.snapshots.build(
      user.id,
      context.tenantId,
      context.membershipId,
    );
    const accessToken = await this.tokens.sign({
      sub: user.id,
      sid: session.id,
      tid: context.tenantId,
      mid: context.membershipId,
      brc: branchId,
      emp: session.employeeId,
      typ: sessionType,
      scp: [...snapshot.scp],
      pbr: snapshot.pbr,
      epo: snapshot.epo,
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
