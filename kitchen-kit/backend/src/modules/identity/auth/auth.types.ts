import { SafeUser } from '../users/user.view';

/** Minimal access-token payload. No permissions, no tenant data — authorization
 * is resolved server-side per request, not carried in the token. */
export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
  tid?: string; // selected tenant id (present once tenant context established)
  mid?: string; // membership id backing the tenant context
  iat?: number;
  exp?: number;
}

/** Trusted, server-established request identity. Only fields that have actually
 * been established are populated (tenant/membership/terminal arrive later). */
export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
  tenantId?: string;
  membershipId?: string;
  terminalId?: string;
}

export interface AuthTokens {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // access-token lifetime in seconds
  user: SafeUser;
}
