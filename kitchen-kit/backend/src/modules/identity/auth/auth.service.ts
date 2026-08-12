import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseDurationMs } from '../../../common/duration';
import { PrismaService } from '../../../prisma/prisma.service';
import { CredentialsService } from '../credentials/credentials.service';
import { SessionContext, SessionsService } from '../sessions/sessions.service';
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

    return {
      tokenType: 'Bearer',
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      user: toSafeUser(user),
    };
  }

  /** Current authenticated user; credential-free view. */
  async me(userId: string): Promise<SafeUser> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthorizedException();
    }
    return toSafeUser(user);
  }
}
