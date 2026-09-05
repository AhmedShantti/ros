import type { PermittedBranchSet } from '../authz/scope';
import { SafeUser } from '../users/user.view';

/**
 * Access-token payload.
 *
 * ── T-4-LIVE (ratified 2026-09-02, D-2 REOPENED IN PART (2) clause 7) ───────
 * A TENANT-BOUND token carries the SRS-required authorization snapshot that
 * `FR-API-012` clause 1 mandates — subject (`sub`), tenant (`tid`), scope set
 * (`scp`) and permitted branch set (`pbr`) — plus an authorization epoch
 * (`epo`) that makes a stale snapshot DETECTABLE.
 *
 * **THE SNAPSHOT IS NOT THE AUTHORIZATION SOURCE.** Every protected request
 * re-resolves the current scoped assignments server-side
 * (`TenantContextService`), and the live database state decides. `scp` and
 * `pbr` are never read to grant anything; `epo` is only ever used to REFUSE a
 * token whose snapshot no longer matches the membership. A validly signed token
 * claiming Branch A is still denied at Branch A once the live assignment is
 * gone.
 *
 * A token with no `tid` (pre-tenant-selection) carries no snapshot: there is no
 * tenant, so there is no scope set to describe.
 */
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
  /**
   * FR-API-012 "scope set" — the assignment scopes held at mint time, rendered
   * compactly (`tenant`, `brand:<id>`, `branch:<id>`). Present on tenant-bound
   * tokens. NOT an authorization source.
   */
  scp?: string[];
  /**
   * FR-API-012 "permitted branch set" — SYMBOLIC, so a tenant's branch COUNT
   * never drives token size: `{ all: true }` for tenant-wide, brand ids for
   * brand-wide, explicit ids only for branch-scoped grants. `all: false` with
   * empty lists means ZERO permitted branches; omission NEVER means
   * unrestricted. NOT an authorization source.
   */
  pbr?: PermittedBranchSet;
  /** Authorization epoch at mint time. A mismatch with the live membership is refused. */
  epo?: number;
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
  /**
   * The authorization epoch the token was minted at (T-4-LIVE). Absent on a
   * tenant-bound token means the snapshot predates B1-2 and is treated as
   * STALE — fail closed.
   */
  authzEpoch?: number;
}

export interface AuthTokens {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // access-token lifetime in seconds
  user: SafeUser;
}
