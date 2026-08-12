import { Matches } from 'class-validator';
import { UUID_PATTERN } from '../../../../common/ids';

export class SelectTenantDto {
  // UUID-shaped (Postgres uuid), not RFC-strict. Well-formed but unknown ids
  // pass validation and resolve to a generic 403 (no tenant enumeration);
  // malformed ids are a 400.
  @Matches(UUID_PATTERN, { message: 'tenantId must be a UUID' })
  tenantId!: string;
}
