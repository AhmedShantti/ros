import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { DayCloseService } from './day-close.service';

/**
 * DayClose Z-NUMBER RETRY — pure unit proof of `post()`'s bounded local
 * retry loop, deterministic and independent of real database timing (the
 * REAL-Postgres concurrency proof lives in
 * `test/day-close-znumber-concurrency.e2e-spec.ts`, which cannot itself
 * guarantee a P2002 collision manifests on every run since — per the
 * ratified design, `day-close.service.ts`'s own docblock — NO advisory
 * lock or barrier is added for numbering, deliberately). This file proves
 * `post()`'s catch/retry mechanics in isolation: `this.unitOfWork.execute`
 * is mocked to throw a P2002 exactly N times before succeeding, and the
 * assertion is on how many times it was called and what `post()` finally
 * returns/throws — never real database state.
 */
function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function otherError(): Error {
  return new Error('unrelated failure');
}

describe('DayCloseService.post — Z-number bounded retry (unit)', () => {
  function mkService(execute: jest.Mock) {
    const service = Object.create(DayCloseService.prototype) as DayCloseService;
    Object.assign(service, {
      unitOfWork: { execute },
    });
    return service;
  }

  const input = {
    branchId: 'b1',
    businessDay: new Date('2026-08-01T00:00:00.000Z'),
  };
  const permissions = new Set(['cash.day.close']);

  it('succeeds on the first attempt with zero retries when no collision occurs', async () => {
    const execute = jest.fn().mockResolvedValue({ outcome: 'CLOSED' });
    const service = mkService(execute);
    const result = await service.post('t1', 'u1', {}, permissions, input);
    expect(result).toEqual({ outcome: 'CLOSED' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retries from a FRESH attempt exactly once after a single P2002, then succeeds', async () => {
    const execute = jest
      .fn()
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({ outcome: 'CLOSED', dayClose: { zNumber: '2' } });
    const service = mkService(execute);
    const result = await service.post('t1', 'u1', {}, permissions, input);
    expect(result).toEqual({ outcome: 'CLOSED', dayClose: { zNumber: '2' } });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('retries up to MAX_ATTEMPTS (5) and then raises a terminal 409, never an unbounded loop', async () => {
    const execute = jest.fn().mockRejectedValue(p2002());
    const service = mkService(execute);
    await expect(
      service.post('t1', 'u1', {}, permissions, input),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('a non-P2002 error is NEVER retried — propagates immediately on the first attempt', async () => {
    const err = otherError();
    const execute = jest.fn().mockRejectedValue(err);
    const service = mkService(execute);
    await expect(service.post('t1', 'u1', {}, permissions, input)).rejects.toBe(
      err,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('each retry attempt shares one correlationId across the whole post() call', async () => {
    const seenCorrelationIds: unknown[] = [];
    const execute = jest
      .fn()
      .mockImplementation((_ctx, fn, opts: { correlationId: unknown }) => {
        seenCorrelationIds.push(opts.correlationId);
        if (seenCorrelationIds.length < 3) return Promise.reject(p2002());
        return Promise.resolve({ outcome: 'CLOSED' });
      });
    const service = mkService(execute);
    await service.post('t1', 'u1', {}, permissions, input);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(new Set(seenCorrelationIds).size).toBe(1);
  });
});
