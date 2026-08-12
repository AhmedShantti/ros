import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AccessTokenService } from '../access-token.service';
import { AuthenticatedPrincipal } from '../auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';

function contextWithHeaders(
  headers: Record<string, string>,
): [ExecutionContext, { principal?: AuthenticatedPrincipal }] {
  const request: {
    headers: Record<string, string>;
    principal?: AuthenticatedPrincipal;
  } = {
    headers,
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return [ctx, request];
}

describe('JwtAuthGuard', () => {
  let tokens: { verify: jest.Mock };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    tokens = { verify: jest.fn() };
    guard = new JwtAuthGuard(tokens as unknown as AccessTokenService);
  });

  it('rejects a missing Authorization header with 401', async () => {
    const [ctx] = contextWithHeaders({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an invalid/tampered token with 401', async () => {
    tokens.verify.mockRejectedValue(new Error('bad signature'));
    const [ctx] = contextWithHeaders({ authorization: 'Bearer tampered' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('establishes the principal for a valid token', async () => {
    tokens.verify.mockResolvedValue({ sub: 'user-1', sid: 'sid-1' });
    const [ctx, request] = contextWithHeaders({
      authorization: 'Bearer good',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.principal).toEqual({ userId: 'user-1', sessionId: 'sid-1' });
  });
});
