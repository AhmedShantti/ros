import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AccessTokenService } from '../access-token.service';
import { AuthenticatedPrincipal } from '../auth.types';

type AuthedRequest = Request & { principal?: AuthenticatedPrincipal };

/**
 * Authentication only: verifies the Bearer access token's signature + expiry and
 * establishes a typed principal on the request. A valid token means "who", not
 * "allowed to" — authorization is a separate guard.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: AccessTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }
    const token = header.slice('Bearer '.length).trim();

    try {
      const payload = await this.tokens.verify(token);
      request.principal = { userId: payload.sub, sessionId: payload.sid };
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }
}
