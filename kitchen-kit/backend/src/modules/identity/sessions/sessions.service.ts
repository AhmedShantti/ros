import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { newId } from '../../../common/ids';
import { Session } from '../../../generated/prisma/client';
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
  private readonly refreshTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
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

  /** Server-side revocation (logout). Idempotent. */
  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
