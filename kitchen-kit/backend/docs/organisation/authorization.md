# Organisation — authorization

## Permission codes (ADR 0008 D-01)

Exactly four. Two are the SRS's own (§15.2); two are invented read companions and
are **provisional**.

| Code | Source | Entities | Operations |
|---|---|---|---|
| `settings.tenant.read` | **invented (provisional)** | Brand, Warehouse, Central Kitchen | list, get |
| `settings.tenant.manage` | SRS §15.2 | Brand, Warehouse, Central Kitchen, **branch↔brand reassignment** | create, update |
| `settings.branch.read` | **invented (provisional)** | Branch, Station, Table, Hours, Print/Station Routing | list, get |
| `settings.branch.manage` | SRS §15.2 | Branch, Station, Table, Hours, Print/Station Routing | create, update, status change |

The SRS states its catalogue is "representative rather than exhaustive; the full
catalogue is maintained in **Appendix C**" — and Appendix C is **not in the
document**. If it later names these differently, remap per D-01; because tenants
can compose custom roles (FR-SEC-011), a rename is a *silent privilege change*
and must be an audited migration, not an edit.

Seeded via the existing `PermissionsService.upsertMany(ORGANISATION_PERMISSION_DEFS)`.

## KNOWN GAP — authorization is tenant-scoped only

**ADR 0008 D-02 defers branch-scoped RBAC to a dedicated later phase.** Within one
tenant, any principal holding `settings.branch.manage` can mutate **every**
branch, not only the branches they operate.

- This is an **intra-tenant** gap. It is **not** cross-tenant: RLS,
  `withAuthContext`, the guard chain and the composite FKs are unchanged and
  fully enforced.
- FR-SEC-002 / FR-SEC-003 / FR-SEC-004 are **[M]** and remain **unimplemented**.
- Phase 15 therefore does **not**: populate `TenantContext.branchId`, read
  `membership_roles.branch_id` in any authorization path, add a branch parameter
  to `PermissionGuard` / `@RequirePermission` / `TenantContextService.require`,
  or add per-branch checks in Organisation services.

Carry this into every subsequent security review until the RBAC-scope phase closes it.

## Related pre-existing finding

`PHASE_15_READINESS_AUDIT.md` F-H1: `RolesService.addPermissions` does not require
the granting user to already hold the permission being granted. Now that
`settings.*` codes exist in the global catalogue, a holder of
`identity.role.update` + `identity.role.assign` can self-grant full Organisation
control **within their own tenant**. Unresolved; decision pending.
