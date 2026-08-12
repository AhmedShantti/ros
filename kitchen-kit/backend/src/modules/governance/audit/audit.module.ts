import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global so any bounded context can inject the audit writer. Audit is
 * cross-cutting governance infrastructure, not part of the identity context.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
