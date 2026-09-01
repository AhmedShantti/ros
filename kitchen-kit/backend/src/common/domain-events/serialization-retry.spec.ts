import { Prisma } from '../../generated/prisma/client';
import { isSerializationFailure } from './serialization-retry';

/** Matches `@prisma/driver-adapter-utils`'s `DriverAdapterError` shape without importing it (transitive dependency only). */
function fakeDriverAdapterError(originalCode: string): Error {
  const err = new Error('DriverAdapterError');
  Object.assign(err, {
    name: 'DriverAdapterError',
    cause: {
      kind: originalCode === '40001' ? 'TransactionWriteConflict' : 'postgres',
      originalCode,
      originalMessage:
        'could not serialize access due to read/write dependencies among transactions',
    },
  });
  return err;
}

describe('isSerializationFailure (acceptance correction Blocker B/H)', () => {
  it('true for PrismaClientKnownRequestError P2034', () => {
    const err = new Prisma.PrismaClientKnownRequestError('write conflict', {
      code: 'P2034',
      clientVersion: 'test',
    });
    expect(isSerializationFailure(err)).toBe(true);
  });

  it('false for a DIFFERENT PrismaClientKnownRequestError code (e.g. P2002 unique violation)', () => {
    const err = new Prisma.PrismaClientKnownRequestError('unique violation', {
      code: 'P2002',
      clientVersion: 'test',
    });
    expect(isSerializationFailure(err)).toBe(false);
  });

  it('true for PrismaClientUnknownRequestError whose message embeds SQLSTATE 40001', () => {
    const err = new Prisma.PrismaClientUnknownRequestError(
      'Raw query failed. Code: `40001`. Message: `could not serialize access`',
      { clientVersion: 'test' },
    );
    expect(isSerializationFailure(err)).toBe(true);
  });

  it('true for PrismaClientUnknownRequestError whose message embeds SQLSTATE 40P01 (deadlock)', () => {
    const err = new Prisma.PrismaClientUnknownRequestError(
      'Raw query failed. Code: `40P01`. Message: `deadlock detected`',
      { clientVersion: 'test' },
    );
    expect(isSerializationFailure(err)).toBe(true);
  });

  it('false for PrismaClientUnknownRequestError with an unrelated message', () => {
    const err = new Prisma.PrismaClientUnknownRequestError(
      'Raw query failed. Code: `23505`. Message: `duplicate key`',
      { clientVersion: 'test' },
    );
    expect(isSerializationFailure(err)).toBe(false);
  });

  /**
   * The shape discovered by the acceptance correction's own no-advisory-lock
   * proof (test H, `kds-concurrency.e2e-spec.ts`): a conflict detected at
   * COMMIT time (not mid-transaction) surfaces as a raw, unwrapped
   * `DriverAdapterError` — neither `PrismaClientKnownRequestError` nor
   * `PrismaClientUnknownRequestError`. Without this branch, `AuditService`'s
   * advisory lock had been incidentally masking this failure mode by making
   * conflicts surface mid-transaction (shape 1/2) instead.
   */
  it('true for a raw DriverAdapterError with cause.originalCode 40001 (commit-time conflict)', () => {
    expect(isSerializationFailure(fakeDriverAdapterError('40001'))).toBe(true);
  });

  it('true for a raw DriverAdapterError with cause.originalCode 40P01 (commit-time deadlock)', () => {
    expect(isSerializationFailure(fakeDriverAdapterError('40P01'))).toBe(true);
  });

  it('false for a DriverAdapterError with an unrelated originalCode', () => {
    expect(isSerializationFailure(fakeDriverAdapterError('23505'))).toBe(false);
  });

  it('false for an error merely named "DriverAdapterError" with no cause object', () => {
    const err = new Error('not really one');
    Object.assign(err, { name: 'DriverAdapterError' });
    expect(isSerializationFailure(err)).toBe(false);
  });

  it('false for a plain business-rule error (never retried)', () => {
    expect(isSerializationFailure(new Error('cancelled line'))).toBe(false);
    expect(
      isSerializationFailure(new TypeError('not a serialization issue')),
    ).toBe(false);
  });

  it('false for null/undefined/primitive rejection reasons', () => {
    expect(isSerializationFailure(null)).toBe(false);
    expect(isSerializationFailure(undefined)).toBe(false);
    expect(isSerializationFailure('a string reason')).toBe(false);
    expect(isSerializationFailure(42)).toBe(false);
  });
});
