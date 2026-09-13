import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AccessTokenService } from '../access-token.service';
import { AuthenticatedPrincipal } from '../auth.types';
import { ALLOW_POS_SESSION } from '../decorators/pos-session.decorator';
import { ALLOW_KDS_SESSION } from '../decorators/kds-session.decorator';

type AuthedRequest = Request & { principal?: AuthenticatedPrincipal };

/**
 * Authentication only: verifies the Bearer access token's signature + expiry and
 * establishes a typed principal on the request. A valid token means "who", not
 * "allowed to" — authorization is a separate guard.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }
    const token = header.slice('Bearer '.length).trim();

    try {
      const payload = await this.tokens.verify(token);
      request.principal = {
        userId: payload.sub,
        sessionId: payload.sid,
        // Tenant context is only present after a validated tenant selection.
        ...(payload.tid ? { tenantId: payload.tid } : {}),
        ...(payload.mid ? { membershipId: payload.mid } : {}),
        // The operating branch CLAIMED at PIN login (POS/KDS sessions only).
        // Re-verified live by TenantContextService on every request — see
        // AuthenticatedPrincipal.branchId's own docblock.
        ...(payload.brc ? { branchId: payload.brc } : {}),
        // Bound terminal id — Sync/offline device channel ONLY. Never set
        // by PIN login. See AuthenticatedPrincipal.terminalId's docblock.
        ...(payload.trm ? { terminalId: payload.trm } : {}),
        // Employee identity is only present for PIN-issued POS/KDS sessions.
        ...(payload.emp ? { employeeId: payload.emp } : {}),
        ...(payload.typ === 'pos' || payload.typ === 'kds'
          ? { sessionType: payload.typ }
          : {}),
        // T-4-LIVE: carried through so TenantContextService can DETECT a stale
        // snapshot. The scope set (`scp`) and permitted branch set (`pbr`) are
        // deliberately NOT copied onto the principal — nothing server-side may
        // read them to authorize, and the surest way to guarantee that is for
        // the authorization path never to receive them.
        ...(payload.epo !== undefined ? { authzEpoch: payload.epo } : {}),
      };
    } catch {
      throw new UnauthorizedException();
    }

    // FR-SEC-021: a PIN-issued session reaches its own opted-in routes only.
    // Denied by default, so no dashboard or back-office route — including
    // one added later — is ever exposed to a PIN session by omission. `pos`
    // and `kds` are DISJOINT audiences (CROSSCUT-POS-KDS-TERMINAL-
    // DECOUPLING-P0): a route opts into exactly the session type(s) it
    // actually serves.
    if (request.principal?.sessionType === 'pos') {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_POS_SESSION,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed) {
        throw new ForbiddenException(
          'PIN (POS) sessions cannot access dashboard or back-office endpoints.',
        );
      }
    } else if (request.principal?.sessionType === 'kds') {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_KDS_SESSION,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed) {
        throw new ForbiddenException(
          'PIN (KDS) sessions cannot access dashboard, back-office, or POS endpoints.',
        );
      }
    }
    return true;
  }
}
