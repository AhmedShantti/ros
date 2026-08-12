# ADR 0001 — Identity tenancy model & session refresh-token storage

- Status: Accepted
- Date: 2026-08-12
- Deciders: Product owner (ratified interactively), implementing engineer

## Context

The authoritative ROS database design (`ROS_DrawDB_Compatible_v3.sql`, derived
from ROS-SRS-001 v1.0) models identity as **single-tenant users**:

- `identity.users.tenant_id NOT NULL` — every user belongs to exactly one tenant.
- Authorization via `identity.user_roles(user_id, role_id, branch_id)`.
- No `memberships` table.

The two ROS Auth master guides, by contrast, are built around a **multi-tenant
membership model** (`User → Membership → Tenant`, `Membership → Role`), an
explicit tenant-selection flow, and a mandatory multi-tenant isolation test.

Separately, the approved `identity.sessions` table has **no column for a
refresh-token hash**, yet rotating, hashed refresh tokens are a non-negotiable
security requirement.

These are direct conflicts between two authoritative-looking inputs.

## Decision

Two deliberate overrides of the approved SQL, ratified by the product owner:

1. **Tenancy → membership model.** Users are tenant-agnostic. Introduce:
   - `identity.memberships(user_id, tenant_id, status)` — a user↔tenant link.
   - `identity.membership_roles(membership_id, role_id, branch_id?)` — replaces
     `user_roles`; roles are assigned per membership, optionally branch-scoped.

   Roles remain tenant-scoped (`roles.tenant_id` nullable ⇒ system role);
   permissions remain global (`permissions.code` unique). Tenant context is
   **never** taken from the client: it is derived from a validated membership of
   the authenticated user. User email becomes globally unique (there is no
   per-tenant scoping to key it by).

2. **Sessions → extended.** Add refresh-token rotation/reuse fields to
   `identity.sessions`: `refresh_token_hash`, `last_used_at`,
   `replaced_by_session_id` (rotation lineage), `reuse_detected_at`, and a
   nullable `membership_id` (the active tenant context for the session).

Additionally, RLS tenant context is applied **transaction-locally**
(`SET LOCAL app.tenant_id`), which is stricter than the session-level
`set_config(..., false)` shown in the SQL comments and is safe under connection
pooling.

## Consequences

- The identity schema diverges from the rest of the approved SQL, which assumes
  `users.tenant_id` and `user_roles`. When the other bounded contexts are built,
  their references to identity must follow this membership model (or the broader
  schema is revisited). This divergence is intentional and tracked here.
- Everything else in `ROS_DrawDB_Compatible_v3.sql` remains the reference:
  ULIDs stored as `UUID`, money as `BIGINT` minor units, per-tenant RLS,
  hash-chained append-only `governance.audit_entries`, terminals separate from
  users.
