import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenPayload } from './auth.types';

/**
 * Wraps signing/verification of the short-lived access JWT. Secret and TTL come
 * from configuration via the JwtModule registration.
 */
@Injectable()
export class AccessTokenService {
  constructor(private readonly jwt: JwtService) {}

  sign(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }

  /** Rejects (throws) on bad signature or expiry — callers map that to 401. */
  verify(token: string): Promise<AccessTokenPayload> {
    return this.jwt.verifyAsync<AccessTokenPayload>(token);
  }
}
