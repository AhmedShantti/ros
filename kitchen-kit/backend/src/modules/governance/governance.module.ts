import { Module } from '@nestjs/common';
import { ApprovalsService } from './approvals/approvals.service';
import { APPROVAL_COMMANDS } from './contract/approval.contract';

/**
 * Governance bounded context — the general Approval mechanism
 * (FR-SEC-030..033, migration 32). `AuditModule` is `@Global()`, so
 * `ApprovalsService` reaches `AuditService` without an explicit import here.
 *
 * NO controller. NO HTTP route of any kind — synchronous and asynchronous
 * alike (D-14 A-1, D-20). Consumers reach this module ONLY through
 * `governance/contract` (`APPROVAL_COMMANDS`), never through
 * `ApprovalsService` directly — `module-boundaries.spec.ts` enforces this
 * mechanically via the standard contract-only import rule.
 *
 * Depends on NO other module for DI: `ApprovalsService` receives an
 * already-verified `VerifiedTerminalPrincipal` as a plain argument (typed
 * via `identity/contract`) rather than injecting Identity's PIN verifier —
 * the consuming module (e.g. a future Treasury close) calls
 * `TERMINAL_PIN_VERIFIER` itself, before opening its transaction.
 */
@Module({
  providers: [
    ApprovalsService,
    { provide: APPROVAL_COMMANDS, useExisting: ApprovalsService },
  ],
  exports: [APPROVAL_COMMANDS],
})
export class GovernanceModule {}
