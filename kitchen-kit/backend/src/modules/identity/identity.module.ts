import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthThrottlerGuard } from '../../common/throttler/auth-throttler.guard';
import { AccessTokenService } from './auth/access-token.service';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { PermissionGuard } from './authz/guards/permission.guard';
import { MembershipRolesService } from './authz/membership-roles.service';
import { PermissionsService } from './authz/permissions.service';
import { RbacController } from './authz/rbac.controller';
import { RolesService } from './authz/roles.service';
import { TenantContextGuard } from './context/tenant-context.guard';
import { TenantContextService } from './context/tenant-context.service';
import { TerminalController } from './terminals/terminal.controller';
import { TerminalSessionService } from './terminals/terminal-session.service';
import { TerminalsService } from './terminals/terminals.service';
import { PasswordController } from './password/password.controller';
import { PasswordService } from './password/password.service';
import {
  LoggingPasswordResetNotifier,
  PASSWORD_RESET_NOTIFIER,
} from './password/password-reset.notifier';
import { CredentialsService } from './credentials/credentials.service';
import { MembershipsRepository } from './memberships/memberships.repository';
import { MembershipsService } from './memberships/memberships.service';
import { SessionsService } from './sessions/sessions.service';
import { TenantController } from './tenants/tenant.controller';
import { TenantSelectionService } from './tenants/tenant-selection.service';
import { TenantsService } from './tenants/tenants.service';
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
    // Rate limiting for sensitive auth endpoints. Config-driven so production can
    // tighten without a code change; storage is in-memory per process.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: Number(config.get<string>('AUTH_THROTTLE_TTL') ?? '60000'),
            limit: Number(config.get<string>('AUTH_THROTTLE_LIMIT') ?? '50'),
          },
        ],
      }),
    }),
  ],
  controllers: [
    AuthController,
    TenantController,
    RbacController,
    TerminalController,
    PasswordController,
  ],
  providers: [
    UsersService,
    UsersRepository,
    CredentialsService,
    SessionsService,
    AccessTokenService,
    AuthService,
    JwtAuthGuard,
    TenantsService,
    MembershipsRepository,
    MembershipsService,
    TenantSelectionService,
    PermissionsService,
    RolesService,
    MembershipRolesService,
    TenantContextService,
    TenantContextGuard,
    PermissionGuard,
    TerminalsService,
    TerminalSessionService,
    PasswordService,
    AuthThrottlerGuard,
    {
      provide: PASSWORD_RESET_NOTIFIER,
      useClass: LoggingPasswordResetNotifier,
    },
  ],
  exports: [
    UsersService,
    CredentialsService,
    SessionsService,
    AccessTokenService,
    JwtAuthGuard,
    TenantsService,
    MembershipsService,
    PermissionsService,
    RolesService,
    MembershipRolesService,
    TenantContextService,
    TenantContextGuard,
    PermissionGuard,
    TerminalsService,
    TerminalSessionService,
    PasswordService,
  ],
})
export class IdentityModule {}
