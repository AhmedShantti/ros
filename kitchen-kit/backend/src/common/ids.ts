import { monotonicFactory, ulidToUUID } from 'ulidx';

/**
 * ROS ID strategy (SRS 25.1 / 7.2): surrogate keys are ULIDs stored as UUID.
 * We generate a ULID (time-ordered) and render its 128 bits in canonical UUID
 * form so it lands in a Postgres `uuid` column and remains chronologically
 * sortable by byte order.
 *
 * `monotonicFactory()` (not plain `ulid()`) is required to actually keep that
 * promise: `ulidx`'s plain `ulid()` only orders by its millisecond timestamp
 * component — two ids generated within the same millisecond carry independent
 * random tails and are NOT guaranteed to sort in generation order (confirmed
 * empirically: a tight loop of `ulid()` calls is not strictly increasing).
 * A1-3B's set-oriented writes generate every movement/allocation id for a
 * whole stock-key group synchronously, with no DB round trip between calls,
 * which reaches that same-millisecond case far more often than the previous
 * one-id-per-round-trip pattern did. The monotonic factory increments the
 * random tail whenever the clock has not advanced, so same-process id
 * generation order and byte-sort order are always identical — a strict
 * correctness fix, not a behavior change callers should ever observe.
 */
const monotonicUlid = monotonicFactory();

export function newId(): string {
  return ulidToUUID(monotonicUlid());
}

/**
 * Shape of a Postgres `uuid` (any 32 hex, 8-4-4-4-12). Intentionally lenient:
 * our ULID-derived ids are valid `uuid` values but are NOT RFC-4122 (their
 * version/variant nibbles differ), so RFC-strict validators (`@IsUUID()`) would
 * wrongly reject them. Use this for id-shaped DTO fields.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
