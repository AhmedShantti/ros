import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { LocalisationModule } from '../localisation/localisation.module';
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
import { EmployeesService } from './employees/employees.service';
import { PinService } from './employees/pin.service';
import { TERMINAL_PIN_VERIFIER } from './contract/pin-verification.contract';
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
      useFactory: (config: ConfigService): JwtModuleOptions => {
        const issuer = config.getOrThrow<string>('JWT_ISSUER');
        const audience = config.getOrThrow<string>('JWT_AUDIENCE');
        return {
          secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
          // Pin the algorithm + issuer + audience on BOTH sign and verify so a
          // token is only accepted if it was minted by this service with the
          // expected symmetric algorithm (Phase 14 — no algorithm confusion, no
          // cross-service token reuse). Token claims (sub/sid/tid/mid/trm) are
          // unchanged.
          signOptions: {
            algorithm: 'HS256',
            // TTL string like "15m"; jsonwebtoken's type is the narrow ms
            // StringValue, so we assert the validated config value to it.
            expiresIn: config.getOrThrow<string>(
              'JWT_ACCESS_TTL',
            ) as NonNullable<JwtModuleOptions['signOptions']>['expiresIn'],
            issuer,
            audience,
          },
          // Merged into every JwtService.verifyAsync() call (see mergeJwtOptions).
          verifyOptions: {
            algorithms: ['HS256'],
            issuer,
            audience,
          },
        };
      },
    }),
    // Rate limiting for sensitive auth endpoints. Config-driven (validated at
    // boot) so production can tighten without a code change; storage is
    // in-memory per process. Defaults are production-safe (see env.validation).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('AUTH_THROTTLE_TTL', 60_000),
            limit: config.get<number>('AUTH_THROTTLE_LIMIT', 10),
          },
        ],
      }),
    }),
    // C-04 AMENDMENT: a tenant's jurisdiction assignment is where its TaxClass
    // identities are provisioned. Identity depends on ONE port
    // (TAX_CLASS_PROVISIONER), and Localisation imports nothing back.
    LocalisationModule,
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
    EmployeesService,
    PinService,
    { provide: TERMINAL_PIN_VERIFIER, useExisting: PinService },
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
    EmployeesService,
    PinService,
    TERMINAL_PIN_VERIFIER,
  ],
})
export class IdentityModule {}
