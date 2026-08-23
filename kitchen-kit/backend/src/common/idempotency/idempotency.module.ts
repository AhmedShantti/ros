import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

/**
 * Reusable API idempotency (SRS §26.5). Global so any bounded context can apply
 * `@Idempotent()` without re-importing.
 *
 * The interceptor is registered APP-WIDE and is inert on every route that does
 * not carry `@Idempotent()`. Registering it globally rather than per-controller
 * is what makes FR-API-020 hold by construction: a financially significant route
 * added later cannot silently lose replay protection because its author forgot
 * to wire an interceptor — it only has to declare the decorator.
 */
@Global()
@Module({
  providers: [
    IdempotencyService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}
