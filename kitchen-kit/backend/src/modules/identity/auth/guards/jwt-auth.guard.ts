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
        // Terminal binding is only present for POS/terminal sessions.
        ...(payload.trm ? { terminalId: payload.trm } : {}),
        // Employee identity is only present for PIN-issued POS sessions.
        ...(payload.emp ? { employeeId: payload.emp } : {}),
        ...(payload.typ === 'pos' ? { sessionType: 'pos' as const } : {}),
      };
    } catch {
      throw new UnauthorizedException();
    }

    // FR-SEC-021: a PIN-issued session reaches POS routes only. Denied by
    // default, so no dashboard or back-office route — including one added
    // later — is ever exposed to a PIN session by omission.
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
    }
    return true;
  }
}
