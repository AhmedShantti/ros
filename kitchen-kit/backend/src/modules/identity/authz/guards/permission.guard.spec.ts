import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedPrincipal } from '../../auth/auth.types';
import { AuthorizationService } from '../authorization.service';
import { RequiredPermissions } from '../decorators/require-permission.decorator';
import { PermissionGuard } from './permission.guard';

function ctxWith(principal?: AuthenticatedPrincipal): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const authed: AuthenticatedPrincipal = {
  userId: 'u-1',
  sessionId: 's-1',
  tenantId: 't-1',
  membershipId: 'm-1',
};

describe('PermissionGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let authz: { getEffectivePermissions: jest.Mock };
  let guard: PermissionGuard;

  const requireAll = (...codes: string[]): RequiredPermissions => ({
    codes,
    mode: 'all',
  });

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    authz = { getEffectivePermissions: jest.fn() };
    guard = new PermissionGuard(
      reflector as unknown as Reflector,
      authz as unknown as AuthorizationService,
    );
  });

  it('allows routes without @RequirePermission metadata', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(ctxWith(authed))).resolves.toBe(true);
  });

  it('401s when there is no principal at all', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      requireAll('identity.role.read'),
    );
    await expect(guard.canActivate(ctxWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('403s when authenticated but no active tenant context', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      requireAll('identity.role.read'),
    );
    await expect(
      guard.canActivate(ctxWith({ userId: 'u-1', sessionId: 's-1' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('403s when the permission is missing', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      requireAll('identity.role.read'),
    );
    authz.getEffectivePermissions.mockResolvedValue(
      new Set(['identity.role.create']),
    );
    await expect(guard.canActivate(ctxWith(authed))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows when all required permissions are present (AND)', async () => {
    reflector.getAllAndOverride.mockReturnValue(
      requireAll('identity.role.read', 'identity.role.create'),
    );
    authz.getEffectivePermissions.mockResolvedValue(
      new Set(['identity.role.read', 'identity.role.create']),
    );
    await expect(guard.canActivate(ctxWith(authed))).resolves.toBe(true);
  });

  it('supports ANY (OR) semantics', async () => {
    reflector.getAllAndOverride.mockReturnValue({
      codes: ['a', 'b'],
      mode: 'any',
    });
    authz.getEffectivePermissions.mockResolvedValue(new Set(['b']));
    await expect(guard.canActivate(ctxWith(authed))).resolves.toBe(true);
  });
});
