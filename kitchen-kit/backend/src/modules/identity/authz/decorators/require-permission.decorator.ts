import { CustomDecorator, SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'ros:required_permissions';

export interface RequiredPermissions {
  codes: string[];
  /** 'all' = the membership must hold every code (AND); 'any' = at least one (OR). */
  mode: 'all' | 'any';
}

/**
 * Require ALL listed permissions (AND semantics). This is the default; multiple
 * codes are combined with AND.
 *
 *   @RequirePermission('identity.role.read')
 *   @RequirePermission('identity.role.update', 'identity.role.assign') // both
 */
export const RequirePermission = (...codes: string[]): CustomDecorator =>
  SetMetadata(PERMISSIONS_KEY, { codes, mode: 'all' });

/** Require ANY of the listed permissions (OR semantics). */
export const RequireAnyPermission = (...codes: string[]): CustomDecorator =>
  SetMetadata(PERMISSIONS_KEY, { codes, mode: 'any' });
