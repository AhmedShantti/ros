import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { newId } from '../../../common/ids';
import { Session, SessionType } from '../../../generated/prisma/client';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  SENTINEL_TENANT_ID,
} from '../../governance/audit/audit.constants';
import { AuditService } from '../../governance/audit/audit.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { generateRefreshToken, hashRefreshToken } from './refresh-token';

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
  terminalId?: string | null;
}

/**
 * POS-KDS-SESSION-CONTINUITY-P0 — the trusted POS/KDS context anchors
 * (design report Option A). Passed ONLY by `AuthService.loginWithPin()`,
 * built ONLY from `PinService.authenticate()`'s server-resolved result —
 * never from client input. `membershipId` here is the SAME real membership
 * a console session eventually selects via `/auth/tenant` (`Membership` is
 * unique per `[userId, tenantId]`); persisting it is what lets
 * `AuthService.refresh()` resolve a POS/KDS session's tenant WITHOUT an
 * RLS chicken-and-egg (`identity.employees`/`org.branches` require
 * `app.tenant_id` to be already set to be readable at all — see the
 * design report's Phase 6 notes). This does NOT reopen the escalation risk
 * the original "never persist membershipId for a PIN session" comment
 * warned about: `refresh()` branches on `session.sessionType` FIRST, and
 * the POS/KDS branch always mints `typ`/`emp`/`brc` together with
 * `tid`/`mid` — never one without the others — so a POS/KDS row can never
 * fall through to the console token-shape path.
 */
export interface PosSessionContext {
  sessionType: SessionType;
  employeeId: string;
  branchId: string;
  membershipId: string;
}

export interface IssuedSession {
  session: Session;
  /** Plaintext refresh token — returned to the client exactly once. */
  refreshToken: string;
}

export interface RotatedSession {
  session: Session;
  /** Plaintext refresh token — returned to the client exactly once. */
  refreshToken: string;
  /**
   * The session lineage's activity timestamp AS IT WAS immediately before
   * this rotation (the presented token's own `lastUsedAt`, or its
   * `issuedAt` if never touched) — i.e. "how long was this session
   * genuinely idle before this refresh/touch." NOT the same as
   * `session.lastUsedAt` on the returned (child) row, which this rotation
   * itself just set to "now" (a rotation IS activity — FR-SEC-026's idle
   * model). Callers that enforce an idle timeout (`AuthService.refresh()`,
   * for POS/KDS) must compare against THIS value, read before the write
   * that would otherwise mask it.
   */
  priorActivityAt: Date;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly refreshTtlMs: number;

  /**
   * POS-KDS-SESSION-CONTINUITY-P0 — how often an authenticated POS/KDS
   * request may bump `lastUsedAt` (`touch()`). FR-SEC-026's idle model
   * needs activity tracked, not every-request precision: a busy POS
   * terminal or a KDS screen polling every few seconds would otherwise
   * write to `identity.sessions` on nearly every request. 60 seconds
   * bounds that write rate to at most once/minute per session while
   * staying far below either configured idle default — at most ~0.4%
   * error against the 15-minute POS default, ~0.02% against the 8-hour
   * KDS default. Chosen as a fixed constant (not configuration): it is an
   * internal write-coalescing detail, not a product-facing timeout value.
   */
  private static readonly ACTIVITY_TOUCH_DEBOUNCE_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.refreshTtlMs = parseDurationMs(
      config.getOrThrow<string>('JWT_REFRESH_TTL'),
    );
  }

  /** Create a session and its first refresh token. */
  async issue(
    userId: string,
    ctx: SessionContext = {},
    pos?: PosSessionContext,
  ): Promise<IssuedSession> {
    const refreshToken = generateRefreshToken();
    const now = new Date();
    const session = await this.prisma.session.create({
      data: {
        id: newId(),
        userId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
        terminalId: ctx.terminalId ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        // FR-SEC-026 idle model: a brand-new session is, by definition,
        // active right now.
        lastUsedAt: now,
        ...(pos
          ? {
              sessionType: pos.sessionType,
              employeeId: pos.employeeId,
              branchId: pos.branchId,
              membershipId: pos.membershipId,
            }
          : {}),
      },
    });
    return { session, refreshToken };
  }

  /**
   * POS-KDS-SESSION-CONTINUITY-P0 — record authenticated activity on a
   * POS/KDS session's CURRENT live row, debounced. Called from
   * `JwtAuthGuard` on every authenticated POS/KDS request (never for
   * console — see the design report's Phase 4; console idle enforcement
   * is a separate, pre-existing, not-yet-addressed gap, and touching its
   * behaviour is out of this task's scope).
   *
   * Atomic, conditional, single-statement `updateMany`: within the
   * debounce window this matches zero rows and is a cheap no-op (no
   * read-then-write race, no lost update). `revokedAt: null` additionally
   * guards against a stray touch racing a concurrent revoke/rotation ever
   * reviving a dead row's timestamp. Never awaited by the caller for
   * request latency — see `JwtAuthGuard`'s own comment on why this is
   * fire-and-forget.
   */
  async touch(sessionId: string): Promise<void> {
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - SessionsService.ACTIVITY_TOUCH_DEBOUNCE_MS,
    );
    await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }],
      },
      data: { lastUsedAt: now },
    });
  }

  /**
   * Rotate a refresh token. All failure modes (unknown token, expired, revoked,
   * reused, or lost concurrency race) surface as the same generic 401 so a
   * caller cannot probe which sessions exist.
   *
   * Rotation runs in a single transaction and uses a conditional
   * compare-and-swap (`updateMany ... WHERE revoked_at IS NULL AND
   * replaced_by_session_id IS NULL AND expires_at > now`) to claim the old
   * session. Exactly one of N concurrent refreshes can win that claim; the rest
   * are rejected without minting a token — this is the concurrency guard.
   *
   * Reuse detection: if the presented token's session was ALREADY rotated or
   * revoked at read time, the token is being replayed. The whole rotation chain
   * is revoked (assume compromise) and a 401 is returned.
   */
  async rotate(
    presentedToken: string,
    ctx: SessionContext = {},
  ): Promise<RotatedSession> {
    const presentedHash = hashRefreshToken(presentedToken);

    // Classify the presented token before opening the rotation transaction, so
    // that reuse-revocation writes are NOT rolled back by the 401 we throw.
    const current = await this.prisma.session.findUnique({
      where: { refreshTokenHash: presentedHash },
    });
    if (!current) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Read-time replay: token already rotated (has a successor) or already
    // flagged. Assume compromise → revoke the whole lineage (own transaction so
    // it commits), then 401. A logout-revoked token (revoked, never replaced) is
    // rejected but is not treated as an attack, so it does not nuke a chain.
    if (current.replacedBySessionId || current.reuseDetectedAt) {
      await this.revokeChain(current);
      this.logger.warn(
        `Refresh token reuse detected: session=${current.id} user=${current.userId}`,
      );
      // Security event — safe identifiers only, never the token.
      await this.audit.emit({
        tenantId: SENTINEL_TENANT_ID,
        action: AUDIT_ACTION.REFRESH_REUSE_DETECTED,
        entityType: AUDIT_ENTITY.SESSION,
        actorType: 'user',
        actorId: current.userId,
        entityId: current.id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        reasonCode: 'refresh_reuse',
        metadata: { chainRevoked: true },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (current.revokedAt) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (current.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // POS-KDS-SESSION-CONTINUITY-P0 — the activity timestamp to idle-check
    // AGAINST is the row's state as read here, before this rotation's own
    // writes touch it. Falls back to `issuedAt` for a session that has
    // never rotated/touched before (its first-ever refresh).
    const priorActivityAt = current.lastUsedAt ?? current.issuedAt;

    return this.prisma.$transaction(async (tx) => {
      // Atomically claim the old session. Loses to a concurrent sibling that
      // read the same still-valid token and claimed first (count === 0). The
      // conditional WHERE is the concurrency guard.
      const now = new Date();
      const claim = await tx.session.updateMany({
        where: {
          id: current.id,
          revokedAt: null,
          replacedBySessionId: null,
          expiresAt: { gt: now },
        },
        // NOTE: `lastUsedAt` is deliberately NOT written here any more. This
        // row is being revoked/superseded by the rotation, not used — the
        // previous code wrote `lastUsedAt` onto exactly the row that was
        // about to become dead, which made the field useless for idle
        // tracking (POS-KDS-SESSION-CONTINUITY-P0 design report, Phase 4).
        // The live activity timestamp now lives on the CHILD row below.
        data: { revokedAt: now },
      });
      if (claim.count === 0) {
        // Benign concurrency race (or just-expired) — reject, do not nuke.
        throw new UnauthorizedException('Invalid refresh token');
      }

      const newRefreshToken = generateRefreshToken();
      const child = await tx.session.create({
        data: {
          id: newId(),
          userId: current.userId,
          refreshTokenHash: hashRefreshToken(newRefreshToken),
          expiresAt: new Date(Date.now() + this.refreshTtlMs),
          terminalId: current.terminalId,
          // Carry tenant selection across rotation; refresh re-validates it.
          membershipId: current.membershipId,
          // POS-KDS-SESSION-CONTINUITY-P0 — carried forward exactly like
          // `membershipId`/`terminalId` above: never trusted as current
          // truth on their own, only as anchors `AuthService.refresh()`
          // live-revalidates on every rotation.
          sessionType: current.sessionType,
          employeeId: current.employeeId,
          branchId: current.branchId,
          // This rotation IS activity (FR-SEC-026's idle model — see
          // AuthService.refresh()'s idle-timeout check, which compares
          // against `priorActivityAt` above, never against this).
          lastUsedAt: now,
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });
      // Link lineage (child must exist first — FK on replaced_by_session_id).
      await tx.session.update({
        where: { id: current.id },
        data: { replacedBySessionId: child.id },
      });

      return { session: child, refreshToken: newRefreshToken, priorActivityAt };
    });
  }

  /** Server-side revocation (logout). Idempotent. */
  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoke every session in a rotation lineage, starting from the reused token's
   * session and following `replaced_by_session_id` forward to the live tip. Runs
   * in its own transaction so the revocation commits even though the caller then
   * throws a 401.
   */
  private async revokeChain(start: Session): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const chain: string[] = [];
      let cursor: string | null = start.id;

      while (cursor && chain.length <= 1000) {
        chain.push(cursor);
        const node: { replacedBySessionId: string | null } | null =
          await tx.session.findUnique({
            where: { id: cursor },
            select: { replacedBySessionId: true },
          });
        cursor = node?.replacedBySessionId ?? null;
      }

      // Flag the whole lineage as compromised; revoke only those still live so
      // we keep the original revocation timestamps of already-rotated sessions.
      await tx.session.updateMany({
        where: { id: { in: chain } },
        data: { reuseDetectedAt: now },
      });
      await tx.session.updateMany({
        where: { id: { in: chain }, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  }
}
