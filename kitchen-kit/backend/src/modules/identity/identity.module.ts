import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { AccessTokenService } from './auth/access-token.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { CredentialsService } from './credentials/credentials.service';
import { SessionsService } from './sessions/sessions.service';
import { UsersRepository } from './users/users.repository';
import { UsersService } from './users/users.service';

/**
 * Identity bounded context. Owns users, credentials, sessions, and auth; grows
 * to tenants/memberships, roles/permissions, and terminals in later phases.
 * Other contexts consume it through exported services, never its tables.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          // TTL string like "15m"; jsonwebtoken's type is the narrow ms
          // StringValue, so we assert the validated config value to it.
          expiresIn: config.getOrThrow<string>('JWT_ACCESS_TTL') as NonNullable<
            JwtModuleOptions['signOptions']
          >['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    UsersService,
    UsersRepository,
    CredentialsService,
    SessionsService,
    AccessTokenService,
    AuthService,
    JwtAuthGuard,
  ],
  exports: [
    UsersService,
    CredentialsService,
    SessionsService,
    AccessTokenService,
    JwtAuthGuard,
  ],
})
export class IdentityModule {}
