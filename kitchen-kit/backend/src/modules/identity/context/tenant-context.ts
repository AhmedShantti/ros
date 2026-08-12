/**
 * Strongly-typed, server-derived authorization context for a tenant-scoped
 * request. Every field originates from the signed access token (established by
 * JwtAuthGuard) and is validated server-side by TenantContextService — never
 * from client body, query, or headers.
 *
 * Field classification:
 *  - userId, sessionId   → authentication identity
 *  - tenantId, membershipId → tenant authorization (the active membership)
 *  - terminalId          → device/terminal identity (present for terminal sessions)
 *  - branchId            → branch scope (RESERVED — not populated this phase; see
 *      docs/adr/0002. A tenant may contain many branches; tenantId != branchId
 *      and membership does not imply access to every branch. Branch-level
 *      authorization is deferred until the org/branch context and SRS branch
 *      rules are available.)
 */
export interface TenantContext {
  userId: string;
  sessionId: string;
  tenantId: string;
  membershipId: string;
  terminalId?: string;
  branchId?: string;
}

/**
 * The resolved authorization for a request, attached exactly once at
 * `request.authorization`. `permissions` are the effective permission codes of
 * the active membership, loaded in the same query that validates the context.
 */
export interface RequestAuthorization {
  context: TenantContext;
  permissions: ReadonlySet<string>;
}
