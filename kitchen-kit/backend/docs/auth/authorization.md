# Authorization — RBAC & TenantContext

## Model
```
User ──< Membership >── Tenant
              │
              └─< MembershipRole >── Role ──< RolePermission >── Permission
```
- **Membership** is the authorization boundary (`@@unique(userId, tenantId)`).
- **Roles** are tenant-scoped (`tenantId`) or system (`isSystem`, seeded by the migration role).
- **Permissions** are a global catalog of `code` strings (identity domain only so far).
- There is **no `user_roles`** table and **no `users.tenant_id`** — roles attach to memberships.

## Permission resolution (server-side only)
`TenantContextService.resolve` walks `membershipRoles → role.rolePermissions → permission.code`
into a `Set<string>`. The JWT carries **no** roles or permissions. `@CurrentTenantContext`
exposes `{userId, tenantId, membershipId, permissions}` to controllers/services.

## Guards
Order on tenant-scoped controllers: `JwtAuthGuard → TenantContextGuard → PermissionGuard`.
- `@RequirePermission(code)` — requires all listed codes (AND).
- `@RequireAnyPermission(...codes)` — requires any (OR).
- **401** = unauthenticated (missing/invalid/expired/tampered token). **403** = authenticated but
  lacking context or permission.

## Cross-tenant & system-role safety
- All role/membership lookups are scoped by `ctx.tenantId` (server-derived) and additionally
  constrained by RLS, so foreign-tenant rows are invisible → generic 404/403 (no enumeration).
- System roles are protected: creation forces `isSystem:false`; assign/update reject `isSystem`.
  No API path can set `is_system=true`.
- Client-supplied role/permission data cannot elevate privileges (verified by RBAC e2e #13).

## TenantContext rules
- Exactly **one** authoritative resolver (`TenantContextService`), memoized per request on
  `request.authorization`. No duplicate resolver, **no AsyncLocalStorage**, no global mutable state.
- Context is re-validated from the DB every request; an inactive membership/tenant, or a `mid`
  not belonging to `sub`+`tid`, is rejected even with a valid signature.
- `branchId` is **not** a tenant; branch-level authorization is deferred (ADR-0002/0004).
