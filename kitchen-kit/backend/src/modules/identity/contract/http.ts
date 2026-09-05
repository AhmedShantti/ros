/**
 * Identity PUBLIC contract — cross-cutting HTTP/auth plumbing.
 *
 * KDS operator-lifecycle acceptance correction (2026-08-31), Blocker A.
 * Every controller-bearing module needs the SAME authentication/
 * authorization primitives: the guard chain (`JwtAuthGuard` →
 * `TenantContextGuard` → `PermissionGuard`), the `@RequirePermission`
 * decorator, the trusted-principal/tenant-context accessors, the
 * `@AllowPosSession` opt-in, and the `PermissionDef` shape every module's
 * own `<module>.permissions.ts` returns to `PermissionsService.upsertMany`.
 *
 * Before this correction, every controller-bearing module reached these
 * through a PRIVATE Identity path — recorded as a pre-existing
 * `<module>->identity` `KNOWN_DEVIATIONS` entry in
 * `module-boundaries.spec.ts` for sales/catalogue/inventory/organisation/
 * production/treasury alike. That file's own docblock names this exact
 * category "framework plumbing... [that] belongs in `shared/`" and records
 * relocating it as "a dedicated slice" — not something one feature slice
 * should undertake as a side effect. Rather than let Kitchen's first
 * controller add its OWN copy of that same pre-existing debt, this file
 * publishes the identical surface as Identity's own public export: a THIN
 * re-export, never a reimplementation — every symbol below still lives at
 * its one private definition site (`auth/`, `authz/`, `context/`) and nests
 * no additional behaviour — nothing here is declared, decorated, or
 * queried — so `module-boundaries.spec.ts`'s contract-purity check still
 * holds for this directory.
 *
 * This does not retroactively clean up any OTHER module's pre-existing
 * `<module>->identity` entry (out of scope for this correction) — it only
 * means a module importing exclusively from `identity/contract` adds none
 * of its own.
 */
export { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
export { TenantContextGuard } from '../context/tenant-context.guard';
export { PermissionGuard } from '../authz/guards/permission.guard';
export {
  RequirePermission,
  RequireAnyPermission,
} from '../authz/decorators/require-permission.decorator';
export { AllowPosSession } from '../auth/decorators/pos-session.decorator';
export { CurrentPrincipal } from '../auth/decorators/current-principal.decorator';
export {
  CurrentAuthorization,
  CurrentTenantContext,
} from '../context/current-tenant-context.decorator';
export type { AuthenticatedPrincipal } from '../auth/auth.types';
export type {
  RequestAuthorization,
  TenantContext,
} from '../context/tenant-context';
export type { PermissionDef } from '../authz/permissions.constants';
/**
 * D4-1B — Sync's recovery-grant issuance route reuses `TERMINAL_MANAGE`, the
 * SAME permission that already revokes a terminal
 * (`POST /auth/terminals/:terminalId/status`), rather than inventing a
 * recovery-specific code. This is the first cross-module `@RequirePermission`
 * use of an Identity-defined code; exporting the constant (not redeclaring
 * its string) is what keeps that reuse literal rather than a re-typed copy.
 */
export { IDENTITY_PERMISSIONS } from '../authz/permissions.constants';
