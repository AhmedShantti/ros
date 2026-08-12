import { ulid, ulidToUUID } from 'ulidx';

/**
 * ROS ID strategy (SRS 25.1 / 7.2): surrogate keys are ULIDs stored as UUID.
 * We generate a ULID (time-ordered) and render its 128 bits in canonical UUID
 * form so it lands in a Postgres `uuid` column and remains chronologically
 * sortable by byte order.
 */
export function newId(): string {
  return ulidToUUID(ulid());
}

/**
 * Shape of a Postgres `uuid` (any 32 hex, 8-4-4-4-12). Intentionally lenient:
 * our ULID-derived ids are valid `uuid` values but are NOT RFC-4122 (their
 * version/variant nibbles differ), so RFC-strict validators (`@IsUUID()`) would
 * wrongly reject them. Use this for id-shaped DTO fields.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
