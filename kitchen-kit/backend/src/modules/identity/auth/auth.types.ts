import { SafeUser } from '../users/user.view';

/** Minimal access-token payload. No permissions, no tenant data — authorization
 * is resolved server-side per request, not carried in the token. */
export interface AccessTokenPayload {
  sub: string; // user id
  sid: string; // session id
  tid?: string; // selected tenant id (present once tenant context established)
  mid?: string; // membership id backing the tenant context
  trm?: string; // bound terminal id (present only for POS/terminal sessions)
  emp?: string; // employee id behind a POS session (FR-SEC-021)
  /**
   * Session audience. Absent means a normal dashboard/back-office session, so
   * every existing token keeps working unchanged. `pos` is issued ONLY by PIN
   * authentication and is refused by every route that has not opted in
   * (FR-SEC-021: "SHALL NOT grant access to the web dashboard").
   */
  typ?: 'pos';
  iat?: number;
  exp?: number;
}

/** Trusted, server-established request identity. Only fields that have actually
 * been established are populated (tenant/membership/terminal arrive later). */
export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
  /** `pos` for PIN-issued sessions; undefined for dashboard sessions. */
  sessionType?: 'pos';
  /** Employee behind a POS session (FR-SEC-021 permitted-branch checks). */
  employeeId?: string;
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
