/**
 * Offline sync protocol constants — D4-1A.
 *
 * Authority: `docs/governance/GOVERNANCE_DECISION_REGISTER.md`, "D1-1 — Offline
 * / Sync Protocol Foundation Ratification — 2026-09-02".
 */

/**
 * Wire protocol version. Bumped only when the ENVELOPE shape, the status
 * vocabulary or the batch semantics change — never because one operation's
 * payload changed (that is the per-operation `schemaVersion`). Splitting the two
 * axes is what stops a payload addition forcing every offline device to speak a
 * new protocol.
 */
export const SYNC_PROTOCOL_VERSION = 1;

/** The oldest protocol version this server still accepts. */
export const SYNC_MIN_PROTOCOL_VERSION = 1;

/**
 * `NFR-PERF-032` grades exactly 500 operations, and `UC-OFF-01` step 10 says
 * "batches of 500". This is a protocol limit, not a business constant.
 */
export const SYNC_MAX_OPERATIONS_PER_BATCH = 500;

/**
 * Ratified STARTING DEFAULTS, explicitly "implementation-testable defaults, not
 * immutable business semantics" (GD-D1-06). They may be revised on measurement
 * without a further governance action, provided NFR-PERF-020 and NFR-PERF-032
 * still hold.
 */
export const SYNC_MAX_BATCH_BYTES = 4 * 1024 * 1024;
export const SYNC_MAX_OPERATION_BYTES = 64 * 1024;

/**
 * How many operations share one physical transaction.
 *
 * Correction 3 of the ratification: `FR-OFF-023` requires per-operation FAILURE
 * ISOLATION, not per-operation physical COMMIT. Isolation inside a chunk comes
 * from a SAVEPOINT per operation; the chunk boundary is purely a performance
 * dial, and no operation in a chunk is acknowledged as `accepted` until that
 * chunk commits.
 */
export const SYNC_DEFAULT_CHUNK_SIZE = 50;

/**
 * `FR-OFF-042` — "device clock skew exceeding a configurable threshold (default
 * 5 minutes)".
 */
export const SYNC_CLOCK_SKEW_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * `FR-OFF-021` / `FR-API-021` floor. Also the ratified rule that server dedup
 * retention must never be shorter than a client outbox horizon that could
 * legitimately replay an operation (`FR-OFF-013`'s default is 30 days).
 */
export const SYNC_DEDUP_RETENTION_DAYS = 30;

/**
 * How long a processing attempt holds its batch lease. Past this, the owner is
 * presumed dead and the batch is reclaimable — the mechanism that makes a batch
 * survive a process death instead of being trapped at 409 forever.
 */
export const SYNC_BATCH_LEASE_MS = 60_000;

/** Per-operation outcome vocabulary — `FR-OFF-023` plus the ratified fifth. */
export const SYNC_OPERATION_STATUS = {
  ACCEPTED: 'accepted',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  REJECTED: 'rejected',
  /**
   * RATIFIED 2026-09-02 (GD-D1-04) as a fifth, NON-DEFINITIVE status.
   *
   * `FR-OFF-022` requires a child whose causal parent has not been applied to be
   * "deferred, not rejected"; `FR-OFF-024` lets the client discard only on a
   * DEFINITIVE response; and all four of `FR-OFF-023`'s statuses are definitive.
   * Without a fifth state the two mandatory clauses are not jointly
   * implementable — mapping deferral onto `rejected` makes the client discard a
   * sale the server promised to accept later.
   */
  DEFERRED: 'deferred',
} as const;

export type SyncOperationStatus =
  (typeof SYNC_OPERATION_STATUS)[keyof typeof SYNC_OPERATION_STATUS];

/**
 * The statuses on which a client MAY delete an operation from its outbox
 * (`FR-OFF-024`). Everything else — `deferred`, a missing result, any transport
 * failure, any 5xx — means KEEP AND RETRY.
 */
export const SYNC_DEFINITIVE_STATUSES: readonly SyncOperationStatus[] = [
  SYNC_OPERATION_STATUS.ACCEPTED,
  SYNC_OPERATION_STATUS.DUPLICATE,
  SYNC_OPERATION_STATUS.CONFLICT,
  SYNC_OPERATION_STATUS.REJECTED,
];

export function isDefinitiveStatus(status: SyncOperationStatus): boolean {
  return SYNC_DEFINITIVE_STATUSES.includes(status);
}

/**
 * Machine-readable reason codes. A rejection always carries one: a client that
 * only receives prose cannot decide whether to dead-letter, fix and resend, or
 * escalate to an operator.
 */
export const SYNC_REASON = {
  UNKNOWN_OPERATION_TYPE: 'unknown_operation_type',
  SCHEMA_VERSION_UNSUPPORTED: 'schema_version_unsupported',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  PAYLOAD_INVALID: 'payload_invalid',
  CAUSAL_PARENT_MISSING: 'causal_parent_missing',
  CAUSAL_PARENT_REJECTED: 'causal_parent_rejected',
  CAUSAL_CYCLE: 'causal_cycle',
  DUPLICATE_OP_ID_DIFFERENT_FINGERPRINT:
    'duplicate_op_id_different_fingerprint',
  HANDLER_ERROR: 'handler_error',
  MALFORMED_HLC: 'malformed_hlc',
} as const;

export type SyncReasonCode = (typeof SYNC_REASON)[keyof typeof SYNC_REASON];
