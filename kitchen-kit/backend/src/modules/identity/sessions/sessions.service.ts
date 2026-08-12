import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { newId } from '../../../common/ids';
import { Session } from '../../../generated/prisma/client';
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

export interface IssuedSession {
  session: Session;
  /** Plaintext refresh token — returned to the client exactly once. */
  refreshToken: string;
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly refreshTtlMs: number;

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
  ): Promise<IssuedSession> {
    const refreshToken = generateRefreshToken();
    const session = await this.prisma.session.create({
      data: {
        id: newId(),
        userId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlMs),
        terminalId: ctx.terminalId ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });
    return { session, refreshToken };
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
  ): Promise<IssuedSession> {
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
        data: { revokedAt: now, lastUsedAt: now },
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
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });
      // Link lineage (child must exist first — FK on replaced_by_session_id).
      await tx.session.update({
        where: { id: current.id },
        data: { replacedBySessionId: child.id },
      });

      return { session: child, refreshToken: newRefreshToken };
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
