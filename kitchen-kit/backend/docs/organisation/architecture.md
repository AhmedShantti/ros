# Organisation — architecture

## Layering

Unchanged from Identity:

```
Controller (thin)  →  Service  →  Prisma (withAuthContext)  →  PostgreSQL + RLS
      ↑
JwtAuthGuard (401) → TenantContextGuard (403) → PermissionGuard (403)
```

`OrganisationModule` imports `IdentityModule` (to reuse the existing guards) and
`AuditModule` (to reuse the existing audit writer). **Neither is modified.** No
new tenant-context mechanism, no second audit implementation, no change to
authentication or RBAC.

## Aggregates

| Root | Children | Basis |
|---|---|---|
| Brand | — | SRS §7.3 #4 |
| Branch | OperatingHours, Table, PrintRouting | SRS §7.3 #5 |
| Station | StationRoutingRule | SRS §7.3 #24 structure + D-07 |
| Warehouse | — | SRS §7.3 #6 |
| CentralKitchen | — | Not established by source; rooted because the approved SQL gives it its own tenant-scoped table |

SRS §7.3 lists Station **twice** — as a Branch-contained entity (#5) and as a
Kitchen Ops aggregate root (#24). D-07 resolved this in favour of an Organisation
root, because §25.1 places the table in `org` and four future contexts
(`kitchen.tickets`, `catalogue.menu_items`, `workforce.scheduled_shifts`,
`org.print_routing`) reference `org.stations(id)` directly.

## Transactions

One `withAuthContext` per aggregate operation. The audit write uses
`AuditService.record(tx, …)` **inside that same transaction**, so a failed audit
rolls the mutation back — required for FR-PLT-004, which states branch
reassignment SHALL carry a full audit record.

## Conventions followed

- IDs: `newId()` (ULID-as-UUID). DTO id fields validate with `UUID_PATTERN`, never
  `@IsUUID()` — ULID-derived UUIDs are not RFC-4122.
- Errors: 401 unauthenticated · 403 no context / missing permission · **404 for
  cross-tenant** (no existence disclosure) · 409 uniqueness · 400 malformed.
- No DTO accepts `tenantId` or any server-derived ownership field; unknown
  properties are rejected by the global `ValidationPipe`.
