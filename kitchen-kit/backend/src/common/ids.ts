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
