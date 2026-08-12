import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { AuditModule } from './modules/governance/audit/audit.module';
import { IdentityModule } from './modules/identity/identity.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail fast at boot if required secrets/vars are missing or malformed.
      validate: validateEnv,
    }),
    PrismaModule,
    // Governance audit trail — global, cross-cutting; consumed by identity.
    AuditModule,
    HealthModule,
    // Identity bounded context (users, credentials, auth, sessions, tenants,
    // rbac, terminals) — grown incrementally from Phase 2 onwards.
    IdentityModule,
  ],
})
export class AppModule {}
