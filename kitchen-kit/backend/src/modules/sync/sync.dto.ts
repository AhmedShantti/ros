import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { UUID_PATTERN } from '../../common/ids';
import {
  SYNC_MAX_OPERATIONS_PER_BATCH,
  SYNC_MIN_PROTOCOL_VERSION,
  SYNC_PROTOCOL_VERSION,
} from './protocol/protocol.constants';

/**
 * The ratified sync envelope — `POST /v1/sync/batch`.
 *
 * ── WHAT IS ABSENT IS PART OF THE CONTRACT ────────────────────────────────
 * There is deliberately no `tenantId`, no `branchId` and no client-supplied
 * `fingerprint` field anywhere below. Tenant identity comes from the
 * authenticated principal, branch from the terminal's live server-side state,
 * and the fingerprint is computed server-side (a client-supplied one is
 * unverifiable and therefore worthless). Because the global `ValidationPipe`
 * runs with `whitelist: true, forbidNonWhitelisted: true`, a body carrying any
 * of them is REJECTED at the edge with 400 rather than silently stripped —
 * strict rejection, not lenient ignoring, exactly as the ratification requires
 * for financial envelopes. `test/sync-protocol.e2e-spec.ts` proves it.
 *
 * There is also no `clientSeq`: causality is carried by `causedBy` + `hlc`, and
 * idempotency by `opId` + `batchId`, so a per-device sequence would add a
 * gap-detection obligation the SRS never asks for.
 */

/** `<physical_ms>.<logical>.<node>` — 13 digits, 5 digits, 32 lowercase hex. */
const HLC_PATTERN = /^\d{13}\.\d{5}\.[0-9a-f]{32}$/;

/** `<aggregate>.<operation>`, e.g. `order.create`. */
const OPERATION_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class SyncOperationDto {
  /**
   * `FR-OFF-021` / SRS §21.5.1 — "idempotency key for the operation". There is
   * no separate idempotency field: `opId` IS it.
   */
  @Matches(UUID_PATTERN, { message: 'opId must be a ULID rendered as a UUID.' })
  opId!: string;

  /** `FR-OFF-041`. Stored verbatim; the server never rewrites it. */
  @Matches(HLC_PATTERN, {
    message:
      'hlc must be <13 digits>.<5 digits>.<32 lowercase hex>, e.g. ' +
      '1722765753000.00042.0f1e2d3c4b5a69788796a5b4c3d2e1f0.',
  })
  hlc!: string;

  @Matches(OPERATION_TYPE_PATTERN, {
    message: 'type must be a dotted <aggregate>.<operation> identifier.',
  })
  @MaxLength(64)
  type!: string;

  /** The aggregate this operation concerns. Never reassigned (`FR-OFF-015`). */
  @Matches(UUID_PATTERN, {
    message: 'entityId must be a ULID rendered as a UUID.',
  })
  entityId!: string;

  /**
   * `FR-OFF-022` — the opId of the causal parent. A child whose parent has not
   * been applied is DEFERRED, never rejected.
   */
  @IsOptional()
  @Matches(UUID_PATTERN, {
    message: 'causedBy must be a ULID rendered as a UUID.',
  })
  causedBy?: string | null;

  /**
   * Per-OPERATION, not per-batch: a 72-hour batch spans shift changes
   * (`UC-OFF-01` step 8), and a batch-level actor would attribute a whole
   * outage to one employee.
   */
  @IsOptional()
  @Matches(UUID_PATTERN, {
    message: 'actorEmployeeId must be a ULID rendered as a UUID.',
  })
  actorEmployeeId?: string | null;

  /**
   * The DEVICE's wall clock, preserved alongside the server's receipt time
   * (`FR-OFF-042`). Distinct from `hlc`: one is causal, one is what the receipt
   * says.
   */
  @IsISO8601({ strict: true })
  occurredAt!: string;

  /** Payload shape version for THIS operation type. */
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  schemaVersion!: number;

  /** Handler-specific. Validated by the registered handler, not here. */
  @IsObject()
  payload!: Record<string, unknown>;
}

export class SyncBatchDto {
  @IsInt()
  @Min(SYNC_MIN_PROTOCOL_VERSION)
  @Max(SYNC_PROTOCOL_VERSION)
  protocolVersion!: number;

  /** Must equal the authenticated terminal. A mismatch is 403, not a hint. */
  @Matches(UUID_PATTERN, {
    message: 'deviceId must be a ULID rendered as a UUID.',
  })
  deviceId!: string;

  /** SRS §21.5.1 — "idempotency key for the batch". */
  @Matches(UUID_PATTERN, {
    message: 'batchId must be a ULID rendered as a UUID.',
  })
  batchId!: string;

  /** Opaque to the client; `null` on a first sync. D4-2 gives it meaning. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastServerCursor?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SYNC_MAX_OPERATIONS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => SyncOperationDto)
  operations!: SyncOperationDto[];
}
