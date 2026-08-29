import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from './approvals.service';

/**
 * Unit coverage for the validation guards `ApprovalsService` runs BEFORE
 * ever touching the database — the real permanent-id/RLS/concurrency
 * behaviour is proven against real PostgreSQL in
 * `test/approval-runtime.e2e-spec.ts` instead (real transactions, real
 * RLS, real UNIQUE constraints — none of that is meaningfully mockable).
 */
describe('ApprovalsService — input validation (no DB)', () => {
  let service: ApprovalsService;
  let audit: { record: jest.Mock };
  let tx: Prisma.TransactionClient;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const requestedBy = '22222222-2222-2222-2222-222222222222';
  const validId = '33333333-3333-3333-3333-333333333333';
  const validEntityId = '44444444-4444-4444-4444-444444444444';

  beforeEach(() => {
    audit = { record: jest.fn() };
    service = new ApprovalsService(audit as unknown as AuditService);
    // Never reached when validation fails first — a throwing stub proves it.
    tx = {
      approvalRequest: {
        findUnique: jest.fn(() => {
          throw new Error('tx reached — validation did not run first');
        }),
      },
      approvalDecision: {
        findUnique: jest.fn(() => {
          throw new Error('tx reached — validation did not run first');
        }),
      },
    } as unknown as Prisma.TransactionClient;
  });

  const baseCommand = () => ({
    id: validId,
    requestType: 'test_request',
    entityType: 'test_entity',
    entityId: validEntityId,
    value: { note: 'x' },
    requiredPermission: 'test.permission',
    expiresAt: new Date(Date.now() + 60_000),
  });

  it('rejects a malformed id before touching the transaction', async () => {
    await expect(
      service.createRequest(tx, tenantId, requestedBy, {
        ...baseCommand(),
        id: 'not-a-uuid',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a malformed entityId', async () => {
    await expect(
      service.createRequest(tx, tenantId, requestedBy, {
        ...baseCommand(),
        entityId: 'not-a-uuid',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a malformed excludedApproverUserId', async () => {
    await expect(
      service.createRequest(tx, tenantId, requestedBy, {
        ...baseCommand(),
        excludedApproverUserId: 'not-a-uuid',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a blank requestType', async () => {
    await expect(
      service.createRequest(tx, tenantId, requestedBy, {
        ...baseCommand(),
        requestType: '   ',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a blank entityType', async () => {
    await expect(
      service.createRequest(tx, tenantId, requestedBy, {
        ...baseCommand(),
        entityType: '',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a blank requiredPermission', async () => {
    await expect(
      service.createRequest(tx, tenantId, requestedBy, {
        ...baseCommand(),
        requiredPermission: '',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a missing/invalid expiresAt', async () => {
    await expect(
      service.createRequest(tx, tenantId, requestedBy, {
        ...baseCommand(),
        expiresAt: new Date(NaN),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  // `decide`'s equivalent id-shape guards are covered in
  // `test/approval-runtime.e2e-spec.ts` using a REAL `VerifiedTerminalPrincipal`
  // obtained from Identity's PIN-verification contract — constructing one
  // here would require fabricating the branded type outside `identity/`,
  // which `module-boundaries.spec.ts` deliberately confines to Identity
  // itself (see its "PIN trust-boundary fence" tests).
});
