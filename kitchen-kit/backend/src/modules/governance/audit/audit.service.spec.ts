import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditEvent, AuditService } from './audit.service';

function makeTx() {
  const create = jest.fn().mockResolvedValue({});
  const findFirst = jest.fn();
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    auditEntry: { findFirst, create },
  } as unknown as Prisma.TransactionClient;
  return { tx, create, findFirst };
}

const event: AuditEvent = {
  tenantId: '00000000-0000-0000-0000-000000000000',
  action: 'LOGIN_SUCCESS',
  entityType: 'user',
  actorType: 'user',
  actorId: 'u-1',
  entityId: 'u-1',
};

function createData(create: jest.Mock): Record<string, unknown> {
  const calls = create.mock.calls as Array<[{ data: Record<string, unknown> }]>;
  return calls[0][0].data;
}

describe('AuditService.record', () => {
  const service = new AuditService({} as PrismaService);

  it('starts the chain at sequence 1 with a null previous hash', async () => {
    const { tx, create, findFirst } = makeTx();
    findFirst.mockResolvedValue(null);
    await service.record(tx, event);
    const data = createData(create);
    expect(data.sequenceNo).toBe(1n);
    expect(data.previousHash).toBeNull();
    expect(data.entryHash).toHaveLength(32);
  });

  it('links to the previous entry (sequence + previous hash)', async () => {
    const { tx, create, findFirst } = makeTx();
    const prev = new Uint8Array([9, 9, 9]).slice();
    findFirst.mockResolvedValue({ sequenceNo: 5n, entryHash: prev });
    await service.record(tx, event);
    const data = createData(create);
    expect(data.sequenceNo).toBe(6n);
    expect(data.previousHash).toBe(prev);
  });

  it('acquires a per-tenant advisory lock before reading the chain', async () => {
    const { tx, findFirst } = makeTx();
    findFirst.mockResolvedValue(null);
    await service.record(tx, event);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      'ros_audit',
      event.tenantId,
    );
  });

  it('redacts secret-looking keys from stored metadata', async () => {
    const { tx, create, findFirst } = makeTx();
    findFirst.mockResolvedValue(null);
    await service.record(tx, {
      ...event,
      metadata: { sessionId: 's-1', refreshToken: 'rt', password: 'p' },
    });
    const after = createData(create).afterState as Record<string, unknown>;
    expect(after.sessionId).toBe('s-1');
    expect(after.refreshToken).toBe('[REDACTED]');
    expect(after.password).toBe('[REDACTED]');
  });
});

describe('AuditService.emit', () => {
  it('never throws even if the audit write fails (best-effort)', async () => {
    const prisma = {
      withAuthContext: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as PrismaService;
    const service = new AuditService(prisma);
    await expect(service.emit(event)).resolves.toBeUndefined();
  });
});
