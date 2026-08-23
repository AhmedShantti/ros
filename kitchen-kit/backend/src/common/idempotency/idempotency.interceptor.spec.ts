import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';

function ctx(headers: Record<string, string>, principal?: unknown) {
  const request = {
    headers,
    principal,
    method: 'POST',
    path: '/v1/orders',
    body: {},
  };
  const response = { setHeader: jest.fn(), status: jest.fn(), statusCode: 201 };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const handler = { handle: () => of({ ok: true }) };

describe('IdempotencyInterceptor — FR-API-020 header requirement', () => {
  const service = {
    fingerprint: () => 'f'.repeat(64),
    reserve: jest.fn(),
    complete: jest.fn(),
    release: jest.fn(),
  } as unknown as IdempotencyService;

  const marked = (v: boolean) =>
    new IdempotencyInterceptor(
      { getAllAndOverride: () => v } as unknown as Reflector,
      service,
    );

  it('passes an unmarked route straight through', async () => {
    const result = await new Promise((resolve) =>
      marked(false).intercept(ctx({}), handler).subscribe({ next: resolve }),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects a marked route with NO Idempotency-Key (FR-API-020)', () => {
    expect(() =>
      marked(true).intercept(ctx({}, { tenantId: 't' }), handler),
    ).toThrow(BadRequestException);
  });

  it('rejects an empty key', () => {
    expect(() =>
      marked(true).intercept(
        ctx({ 'idempotency-key': '   ' }, { tenantId: 't' }),
        handler,
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects a key longer than the 80-character column', () => {
    expect(() =>
      marked(true).intercept(
        ctx({ 'idempotency-key': 'x'.repeat(81) }, { tenantId: 't' }),
        handler,
      ),
    ).toThrow(/at most 80/);
  });

  it('fails closed with no tenant context — a key needs an isolation boundary', () => {
    expect(() =>
      marked(true).intercept(ctx({ 'idempotency-key': 'k' }), handler),
    ).toThrow(/tenant context is required/);
  });
});
