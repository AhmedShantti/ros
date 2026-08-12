import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Fail fast at boot if required secrets/vars are missing or malformed.
      validate: validateEnv,
    }),
    PrismaModule,
    HealthModule,
    // Identity bounded context (auth, users, sessions, tenants, rbac, …) is
    // added incrementally from Phase 2 onwards.
  ],
})
export class AppModule {}
