import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantContextService } from '../../context/tenant-context.service';
import { RequiredPermissions } from '../decorators/require-permission.decorator';
import { PermissionGuard } from './permission.guard';

function ctx(): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({}) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const requireAll = (...codes: string[]): RequiredPermissions => ({
  codes,
  mode: 'all',
});

describe('PermissionGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let tenantContext: { require: jest.Mock };
  let guard: PermissionGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    tenantContext = { require: jest.fn() };
    guard = new PermissionGuard(
      reflector as unknown as Reflector,
      tenantContext as unknown as TenantContextService,
    );
  });

  it('allows routes without @RequirePermission metadata (no context query)', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(tenantContext.require).not.toHaveBeenCalled();
  });

  it('propagates the context guard rejection (e.g. no tenant context → 403)', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      requireAll('identity.role.read'),
    );
    tenantContext.require.mockRejectedValue(
      new ForbiddenException('No active tenant context.'),
    );
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('403s when the required permission is missing', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      requireAll('identity.role.read'),
    );
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['identity.role.create']),
    });
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows when all required permissions are present (AND)', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      requireAll('identity.role.read', 'identity.role.create'),
    );
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['identity.role.read', 'identity.role.create']),
    });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('supports ANY (OR) semantics', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      codes: ['a', 'b'],
      mode: 'any',
    });
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['b']),
    });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });
});
