import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUTHORIZATION_TARGET_KEY,
  type AuthorizationTargetSpec,
  branchFromParam,
  tenantTarget,
} from '../../contract/authorization-target';
import { TenantContextService } from '../../context/tenant-context.service';
import { AuthorizationTargetResolver } from '../authorization-target.resolver';
import { ScopeAuthorizationService } from '../scope-authorization.service';
import {
  PERMISSIONS_KEY,
  RequiredPermissions,
} from '../decorators/require-permission.decorator';
import { PermissionGuard } from './permission.guard';

function ctx(request: object = {}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
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
  let targetResolver: { resolve: jest.Mock };
  let scopeAuthorization: { assertAuthorized: jest.Mock };
  let guard: PermissionGuard;

  /**
   * The guard reads TWO metadata keys, so a mock that answers the same thing to
   * both would let a broken key wiring pass. Answer by key.
   */
  const metadata = (
    permissions: RequiredPermissions | undefined,
    target?: AuthorizationTargetSpec,
  ): void => {
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === PERMISSIONS_KEY
        ? permissions
        : key === AUTHORIZATION_TARGET_KEY
          ? target
          : undefined,
    );
  };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    tenantContext = { require: jest.fn() };
    targetResolver = { resolve: jest.fn() };
    scopeAuthorization = { assertAuthorized: jest.fn() };
    guard = new PermissionGuard(
      reflector as unknown as Reflector,
      tenantContext as unknown as TenantContextService,
      targetResolver as unknown as AuthorizationTargetResolver,
      scopeAuthorization as unknown as ScopeAuthorizationService,
    );
  });

  it('allows routes without @RequirePermission metadata (no context query)', async () => {
    metadata(undefined);
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(tenantContext.require).not.toHaveBeenCalled();
  });

  it('propagates the context guard rejection (e.g. no tenant context → 403)', async () => {
    metadata(requireAll('identity.role.read'));
    tenantContext.require.mockRejectedValue(
      new ForbiddenException('No active tenant context.'),
    );
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  // ── the transitional path: no declared target ⇒ TENANT-scoped set only ────

  it('403s when the required permission is missing', async () => {
    metadata(requireAll('identity.role.read'));
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['identity.role.create']),
    });
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows when all required permissions are present (AND)', async () => {
    metadata(requireAll('identity.role.read', 'identity.role.create'));
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['identity.role.read', 'identity.role.create']),
    });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('supports ANY (OR) semantics', async () => {
    metadata({ codes: ['a', 'b'], mode: 'any' });
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['b']),
    });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
  });

  it('does NOT consult the scope primitive when no target is declared', async () => {
    metadata(requireAll('a'));
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['a']),
    });
    await guard.canActivate(ctx());
    expect(targetResolver.resolve).not.toHaveBeenCalled();
    expect(scopeAuthorization.assertAuthorized).not.toHaveBeenCalled();
  });

  // ── B1-3: the declared-target path ───────────────────────────────────────

  it('delegates to the scope primitive with the RESOLVED target', async () => {
    const auth = { context: {}, permissions: new Set<string>() };
    metadata(requireAll('sales.order.read'), branchFromParam('branchId'));
    tenantContext.require.mockResolvedValue(auth);
    targetResolver.resolve.mockResolvedValue({
      outcome: 'target',
      target: { type: 'branch', branchId: 'b-1' },
    });

    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(scopeAuthorization.assertAuthorized).toHaveBeenCalledWith(
      auth,
      requireAll('sales.order.read'),
      { type: 'branch', branchId: 'b-1' },
    );
  });

  it('does NOT fall back to the tenant-scoped set when a target is declared', async () => {
    // The whole point of D-10 is that a narrow grant must not satisfy a
    // tenant-target route. The mirror image matters just as much: a route WITH
    // a target must not be decidable by the flat tenant set, or a tenant-wide
    // grant would pass a sibling-branch target.
    metadata(requireAll('sales.order.read'), branchFromParam('branchId'));
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['sales.order.read']),
    });
    targetResolver.resolve.mockResolvedValue({
      outcome: 'target',
      target: { type: 'branch', branchId: 'b-2' },
    });
    scopeAuthorization.assertAuthorized.mockRejectedValue(
      new ForbiddenException('Insufficient permission for this scope.'),
    );
    await expect(guard.canActivate(ctx())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('403s on a `deny` resolution without disclosing which condition failed', async () => {
    metadata(requireAll('a'), branchFromParam('branchId'));
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set(['a']),
    });
    targetResolver.resolve.mockResolvedValue({
      outcome: 'deny',
      reason: 'branch target absent',
    });
    await expect(guard.canActivate(ctx())).rejects.toMatchObject({
      message: 'Insufficient permission for this scope.',
    });
    expect(scopeAuthorization.assertAuthorized).not.toHaveBeenCalled();
  });

  it('defers to the route on an unresolvable target, and records why', async () => {
    const request: Record<string, unknown> = {};
    metadata(requireAll('a'), branchFromParam('branchId'));
    tenantContext.require.mockResolvedValue({
      context: {},
      permissions: new Set<string>(),
    });
    targetResolver.resolve.mockResolvedValue({
      outcome: 'defer',
      reason: 'resource not visible in tenant',
    });
    await expect(guard.canActivate(ctx(request))).resolves.toBe(true);
    expect(request.authorizationTargetDeferred).toBe(
      'resource not visible in tenant',
    );
    expect(scopeAuthorization.assertAuthorized).not.toHaveBeenCalled();
  });

  it('sends an explicit TENANT target through the primitive, not the flat set', async () => {
    const auth = { context: {}, permissions: new Set(['a']) };
    metadata(
      requireAll('a'),
      tenantTarget('a genuinely tenant-wide operation, stated explicitly'),
    );
    tenantContext.require.mockResolvedValue(auth);
    targetResolver.resolve.mockResolvedValue({
      outcome: 'target',
      target: { type: 'tenant' },
    });
    await expect(guard.canActivate(ctx())).resolves.toBe(true);
    expect(scopeAuthorization.assertAuthorized).toHaveBeenCalledWith(
      auth,
      requireAll('a'),
      { type: 'tenant' },
    );
  });
});
