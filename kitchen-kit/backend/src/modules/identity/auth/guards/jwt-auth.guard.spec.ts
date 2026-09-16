import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenService } from '../access-token.service';
import { AuthenticatedPrincipal } from '../auth.types';
import { SessionsService } from '../../sessions/sessions.service';
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
    // The guard consults route metadata for the POS-session opt-in
    // (FR-SEC-021), so the fake context must expose these.
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return [ctx, request];
}

describe('JwtAuthGuard', () => {
  let tokens: { verify: jest.Mock };
  let sessions: { touch: jest.Mock };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    tokens = { verify: jest.fn() };
    // POS-KDS-SESSION-CONTINUITY-P0: fire-and-forget activity touch — these
    // specs assert authn/route-gating behaviour, not the touch mechanism
    // itself (that has its own coverage in sessions.service.spec.ts), so a
    // resolved stub suffices.
    sessions = { touch: jest.fn().mockResolvedValue(undefined) };
    guard = new JwtAuthGuard(
      tokens as unknown as AccessTokenService,
      // A dashboard route never opts in, so the reflector yields undefined.
      { getAllAndOverride: () => undefined } as unknown as Reflector,
      sessions as unknown as SessionsService,
    );
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

  describe('FR-SEC-021 — PIN sessions cannot reach dashboard routes', () => {
    it('refuses a typ=pos token on a route that has not opted in', async () => {
      tokens.verify.mockResolvedValue({ sub: 'u', sid: 's', typ: 'pos' });
      const [ctx] = contextWithHeaders({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows a typ=pos token on a route that opts in', async () => {
      tokens.verify.mockResolvedValue({ sub: 'u', sid: 's', typ: 'pos' });
      const optedIn = new JwtAuthGuard(
        tokens as unknown as AccessTokenService,
        { getAllAndOverride: () => true } as unknown as Reflector,
        sessions as unknown as SessionsService,
      );
      const [ctx] = contextWithHeaders({ authorization: 'Bearer t' });
      await expect(optedIn.canActivate(ctx)).resolves.toBe(true);
    });

    it('still allows a normal dashboard token', async () => {
      tokens.verify.mockResolvedValue({ sub: 'u', sid: 's' });
      const [ctx] = contextWithHeaders({ authorization: 'Bearer t' });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });
  });

  describe('POS-KDS-SESSION-CONTINUITY-P0 — activity touch', () => {
    it('touches the session for a pos-typed principal', async () => {
      tokens.verify.mockResolvedValue({ sub: 'u', sid: 's-pos', typ: 'pos' });
      const optedIn = new JwtAuthGuard(
        tokens as unknown as AccessTokenService,
        { getAllAndOverride: () => true } as unknown as Reflector,
        sessions as unknown as SessionsService,
      );
      const [ctx] = contextWithHeaders({ authorization: 'Bearer t' });
      await optedIn.canActivate(ctx);
      expect(sessions.touch).toHaveBeenCalledWith('s-pos');
    });

    it('touches the session for a kds-typed principal', async () => {
      tokens.verify.mockResolvedValue({ sub: 'u', sid: 's-kds', typ: 'kds' });
      const optedIn = new JwtAuthGuard(
        tokens as unknown as AccessTokenService,
        { getAllAndOverride: () => true } as unknown as Reflector,
        sessions as unknown as SessionsService,
      );
      const [ctx] = contextWithHeaders({ authorization: 'Bearer t' });
      await optedIn.canActivate(ctx);
      expect(sessions.touch).toHaveBeenCalledWith('s-kds');
    });

    it('does NOT touch the session for a console/dashboard principal', async () => {
      tokens.verify.mockResolvedValue({ sub: 'u', sid: 's-console' });
      const [ctx] = contextWithHeaders({ authorization: 'Bearer t' });
      await guard.canActivate(ctx);
      expect(sessions.touch).not.toHaveBeenCalled();
    });

    it('never fails the request when the touch write itself fails', async () => {
      sessions.touch.mockRejectedValue(new Error('db hiccup'));
      tokens.verify.mockResolvedValue({ sub: 'u', sid: 's-pos', typ: 'pos' });
      const optedIn = new JwtAuthGuard(
        tokens as unknown as AccessTokenService,
        { getAllAndOverride: () => true } as unknown as Reflector,
        sessions as unknown as SessionsService,
      );
      const [ctx] = contextWithHeaders({ authorization: 'Bearer t' });
      await expect(optedIn.canActivate(ctx)).resolves.toBe(true);
    });
  });
});
