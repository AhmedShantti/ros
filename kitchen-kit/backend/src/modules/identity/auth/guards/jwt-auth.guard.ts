import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AccessTokenService } from '../access-token.service';
import { AuthenticatedPrincipal } from '../auth.types';
import { ALLOW_POS_SESSION } from '../decorators/pos-session.decorator';
import { ALLOW_KDS_SESSION } from '../decorators/kds-session.decorator';
import { SessionsService } from '../../sessions/sessions.service';

type AuthedRequest = Request & { principal?: AuthenticatedPrincipal };

/**
 * Authentication only: verifies the Bearer access token's signature + expiry and
 * establishes a typed principal on the request. A valid token means "who", not
 * "allowed to" — authorization is a separate guard.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly tokens: AccessTokenService,
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
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

    // POS-KDS-SESSION-CONTINUITY-P0 (FR-SEC-026 idle model) — authenticated
    // POS/KDS traffic (including ordinary ticket polling — this counts as
    // operational activity by explicit product decision, see the design
    // report's Phase 4) keeps the session alive. `SessionsService.touch()`
    // is itself debounced/atomic, so calling it on every request is cheap;
    // it is additionally fire-and-forget here (never awaited, errors only
    // logged) so a transient DB hiccup on this best-effort write can never
    // fail or slow down an otherwise-valid authenticated request. Console
    // requests are deliberately NOT touched here — dashboard idle
    // enforcement is a separate, pre-existing, not-yet-addressed gap (see
    // the design report); scoping this to POS/KDS only avoids changing any
    // console behaviour in this task.
    if (
      request.principal?.sessionType === 'pos' ||
      request.principal?.sessionType === 'kds'
    ) {
      this.sessions.touch(request.principal.sessionId).catch((err: unknown) => {
        this.logger.warn(`Session activity touch failed: ${String(err)}`);
      });
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
