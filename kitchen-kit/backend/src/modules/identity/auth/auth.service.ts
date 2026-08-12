import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { User } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { MembershipsService } from '../memberships/memberships.service';
import { SessionContext, SessionsService } from '../sessions/sessions.service';
import { TerminalsService } from '../terminals/terminals.service';
import { SafeUser, toSafeUser } from '../users/user.view';
import { UsersRepository } from '../users/users.repository';
import { UsersService } from '../users/users.service';
import { AccessTokenService } from './access-token.service';
import { AuthTokens } from './auth.types';
import { LoginDto } from './dto/login.dto';

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

    const accessToken = await this.tokens.sign({
      sub: user.id,
      sid: session.id,
      ...(context ? { tid: context.tenantId, mid: context.membershipId } : {}),
      ...(terminalId ? { trm: terminalId } : {}),
    });
    return this.buildTokens(accessToken, nextRefreshToken, user);
  }

  /** Revoke the caller's current session server-side. Idempotent. */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId);
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
