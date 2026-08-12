import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { TenantContextGuard } from './tenant-context.guard';
import { TenantContextService } from './tenant-context.service';

function ctxWith(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('TenantContextGuard', () => {
  let tenantContext: { require: jest.Mock };
  let guard: TenantContextGuard;

  beforeEach(() => {
    tenantContext = { require: jest.fn() };
    guard = new TenantContextGuard(
      tenantContext as unknown as TenantContextService,
    );
  });

  it('establishes the context and allows the request', async () => {
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(),
    });
    const request = {};
    await expect(guard.canActivate(ctxWith(request))).resolves.toBe(true);
    expect(tenantContext.require).toHaveBeenCalledWith(request);
  });

  it('rejects when no valid context can be established', async () => {
    tenantContext.require.mockRejectedValue(new ForbiddenException());
    await expect(guard.canActivate(ctxWith({}))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
