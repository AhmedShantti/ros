# Authentication Flow

## Login — `POST /auth/login`
1. `LoginDto{email,password}` validated by the global pipe.
2. `verifyPasswordSafe` always runs an Argon2id verify (dummy verify if the user/credential is
   absent) — timing-safe, enumeration-safe. Unknown email / wrong password / inactive user all
   collapse to a single generic **401**.
3. On success: create a `Session` with a hashed refresh token; sign an access JWT `{sub,sid}`.
4. Response: `{tokenType:'Bearer', accessToken, refreshToken, expiresIn, user: SafeUser}`.
   The refresh token plaintext is returned **once**; only its SHA-256 hash is stored.

## Tenant selection — `POST /auth/tenant`
- `GET /auth/tenants` lists the caller's **active** memberships.
- `POST /auth/tenant{tenantId}` validates that the caller has an **active membership** in an
  **active tenant**, then mints an access JWT with `{sub,sid,tid,mid}`. The client-supplied
  `tenantId` only *chooses among the caller's own memberships* — it is never trusted as identity.

## Per-request context
`JwtAuthGuard` verifies the token and lifts claims to `request.principal`. For tenant-scoped
routes, `TenantContextGuard` → `TenantContextService.resolve` re-queries the membership
(`id=mid AND userId=sub AND tenantId=tid AND status=active AND tenant.status=active`) and computes
permissions server-side. Nothing from the token is trusted without this DB re-validation.

## Refresh — `POST /auth/refresh`
- Opaque token (512-bit) looked up by SHA-256 hash. Rotation is a **compare-and-swap**: the
  presented session is revoked and a child session minted atomically; concurrent refresh with the
  same token → exactly one winner, the rest 401.
- **Reuse detection:** presenting an already-rotated/flagged token revokes the entire rotation
  chain (`replacedBySessionId` lineage) and 401s.
- On refresh the token re-validates the user (active), membership/tenant (active → keep `tid/mid`),
  and terminal (active → keep `trm`); inactive drops the corresponding context.

## Logout — `POST /auth/logout`
Revokes the current session (its refresh token can no longer rotate). Access tokens remain valid
until `exp` (short-lived; access-token revocation is intentionally not implemented).
