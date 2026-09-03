import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SyncOperationRejectedError,
  type SyncOperationContext,
  type SyncOperationHandler,
  type SyncOperationOutcome,
} from '../contract/sync-operation-handler';
import { DeviceStateService } from '../device/device-state.service';
import { parseHlc } from '../hlc/hlc';
import {
  ParentSettlement,
  scheduleOperations,
} from '../operations/operation-scheduler';
import { SyncOperationRegistry } from '../operations/sync-operation.registry';
import {
  SYNC_DEDUP_RETENTION_DAYS,
  SYNC_DEFAULT_CHUNK_SIZE,
  SYNC_MAX_OPERATION_BYTES,
  SYNC_OPERATION_STATUS,
  SYNC_REASON,
  SyncOperationStatus,
  isDefinitiveStatus,
} from '../protocol/protocol.constants';
import { SyncFailpoint } from '../sync.failpoint';
import { SyncBatchDto, SyncOperationDto } from '../sync.dto';
import { BatchReservationService } from './batch-reservation.service';
import { withSavepoint } from './savepoint';

export interface SyncOperationResult {
  readonly opId: string;
  readonly status: SyncOperationStatus;
  readonly definitive: boolean;
  readonly reasonCode?: string;
  readonly reasonDetail?: string;
  readonly conflictId?: string;
  readonly detail?: Record<string, unknown>;
}

export interface SyncBatchResult {
  readonly batchId: string;
  readonly receivedAt: string;
  readonly protocolVersion: number;
  readonly replayed: boolean;
  readonly counts: Record<SyncOperationStatus, number>;
  readonly clockSkewMs: number;
  readonly clockSkewExceededThreshold: boolean;
  readonly results: readonly SyncOperationResult[];
}

interface ChunkBase {
  readonly tenantId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly batchId: string;
  readonly receivedAt: Date;
  readonly expiresAt: Date;
  readonly prepared: readonly PreparedOperation[];
  readonly dedup: ReadonlyMap<string, DedupRow>;
  readonly settledInBatch: Map<string, SyncOperationStatus>;
}

interface DedupRow {
  readonly opId: string;
  readonly fingerprint: string;
  readonly status: string;
  readonly reasonCode: string | null;
  readonly result: Prisma.JsonValue;
}

interface Settlement {
  readonly prepared: PreparedOperation;
  readonly result: SyncOperationResult;
}

interface PreparedOperation {
  readonly index: number;
  readonly dto: SyncOperationDto;
  readonly fingerprint: string;
  readonly bytes: number;
  readonly physicalMs: number;
}

/**
 * The sync batch orchestrator — `POST /v1/sync/batch`.
 *
 * Ordering of the whole request, and every step of it is load-bearing:
 *
 *   1. fingerprint and size the batch;
 *   2. RESERVE it (crash-recoverable lease) — or replay a completed one;
 *   3. read the dedup registry for every opId this batch mentions;
 *   4. schedule causally (`FR-OFF-022`);
 *   5. apply in chunk transactions with a SAVEPOINT per operation;
 *   6. record device state and clock skew (`FR-OFF-042`);
 *   7. PERSIST the response durably;
 *   8. only then return it to the client.
 *
 * Step 7 before step 8 is the whole of `NFR-REL-010` for this path. If the
 * process dies between them the client sees a transport failure — which is
 * NON-definitive, so it retains every operation and retries, and the retry
 * replays the stored response. Reversed, that same crash would hand the client
 * a 200 for work the server has no record of accepting, and the client would
 * delete it from the outbox: a lost sale, which is exactly `CT-01`'s failure.
 */
@Injectable()
export class SyncBatchService {
  private readonly logger = new Logger(SyncBatchService.name);
  private savepointCounter = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: BatchReservationService,
    private readonly registry: SyncOperationRegistry,
    private readonly deviceState: DeviceStateService,
    private readonly failpoint: SyncFailpoint,
  ) {}

  private static canonical(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value))
      return `[${value.map((v) => SyncBatchService.canonical(v)).join(',')}]`;
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${SyncBatchService.canonical(obj[k])}`)
      .join(',')}}`;
  }

  /**
   * Server-computed, deterministic under key reordering. A client-supplied
   * fingerprint is unverifiable, so none is accepted.
   */
  private static fingerprint(value: unknown): string {
    return createHash('sha256')
      .update(SyncBatchService.canonical(value))
      .digest('hex');
  }

  async process(input: {
    tenantId: string;
    terminalId: string;
    branchId: string;
    batch: SyncBatchDto;
  }): Promise<SyncBatchResult> {
    const startedAt = Date.now();
    const receivedAt = new Date();
    const { tenantId, terminalId, branchId, batch } = input;

    const batchFingerprint = SyncBatchService.fingerprint({
      deviceId: batch.deviceId,
      batchId: batch.batchId,
      protocolVersion: batch.protocolVersion,
      lastServerCursor: batch.lastServerCursor ?? null,
      operations: batch.operations,
    });
    const byteSize = Buffer.byteLength(JSON.stringify(batch), 'utf8');

    const reservation = await this.reservations.reserve({
      tenantId,
      batchId: batch.batchId,
      terminalId,
      fingerprint: batchFingerprint,
      protocolVersion: batch.protocolVersion,
      operationCount: batch.operations.length,
      byteSize,
    });

    if (reservation.kind === 'replay') {
      // FR-API-022 / FR-OFF-025 — the identical stored response, verbatim.
      // Nothing is re-applied.
      return { ...(reservation.response as SyncBatchResult), replayed: true };
    }

    const { leaseOwner } = reservation;
    try {
      const result = await this.run({
        tenantId,
        terminalId,
        branchId,
        batch,
        receivedAt,
        leaseOwner,
      });

      const durationMs = Date.now() - startedAt;
      // DURABLE BEFORE ACKNOWLEDGED.
      await this.reservations.complete({
        tenantId,
        batchId: batch.batchId,
        leaseOwner,
        response: result,
        durationMs,
        counts: result.counts,
        maxClockSkewMs: BigInt(result.clockSkewMs),
      });
      return result;
    } catch (error) {
      // A HANDLED failure gives the lease up immediately so the client's retry
      // reclaims at once rather than waiting the lease out. The batch row and
      // every committed operation stay exactly as they are: the resumed attempt
      // answers `duplicate` for them from the dedup registry.
      await this.reservations
        .releaseLease(tenantId, batch.batchId, leaseOwner)
        .catch(() => undefined);
      throw error;
    }
  }

  private async run(input: {
    tenantId: string;
    terminalId: string;
    branchId: string;
    batch: SyncBatchDto;
    receivedAt: Date;
    leaseOwner: string;
  }): Promise<SyncBatchResult> {
    const { tenantId, terminalId, branchId, batch, receivedAt } = input;

    // ── prepare: fingerprint, size and parse each operation's HLC ──────────
    const prepared: PreparedOperation[] = batch.operations.map(
      (dto, index) => ({
        index,
        dto,
        fingerprint: SyncBatchService.fingerprint(dto),
        bytes: Buffer.byteLength(JSON.stringify(dto), 'utf8'),
        // The DTO pattern already guarantees the shape, so this cannot throw for
        // a body that reached here; parsing yields the physical component needed
        // for FR-OFF-042 skew detection.
        physicalMs: parseHlc(dto.hlc).physicalMs,
      }),
    );

    const results = new Array<SyncOperationResult | undefined>(prepared.length);
    const settledInBatch = new Map<string, SyncOperationStatus>();

    // ── dedup pre-read: everything this batch mentions, in one query ───────
    const mentioned = new Set<string>();
    for (const p of prepared) {
      mentioned.add(p.dto.opId);
      if (p.dto.causedBy) mentioned.add(p.dto.causedBy);
    }
    const dedupRows = await this.prisma.withAuthContext({ tenantId }, (tx) =>
      tx.syncOperationDedup.findMany({
        where: { tenantId, opId: { in: [...mentioned] } },
      }),
    );
    const dedup = new Map(dedupRows.map((row) => [row.opId, row]));

    const parentSettlement = (opId: string): ParentSettlement => {
      const row = dedup.get(opId);
      if (!row) return 'unknown';
      // `accepted` means applied. `rejected` is settled definitively WITHOUT
      // being applied and structurally never can be — see `operation-
      // scheduler.ts`'s docblock for why `conflict` is classified separately
      // (D4-1B review of D4-1A's own flagged §15 concern): a conflict may
      // still be resolved in the parent's favour outside this batch, so its
      // children are retried, not permanently dead-lettered.
      if (row.status === 'accepted') return 'applied';
      if (row.status === 'rejected') return 'not-applied';
      return 'conflicted';
    };

    const schedule = scheduleOperations(
      prepared.map((p) => ({
        opId: p.dto.opId,
        hlc: p.dto.hlc,
        causedBy: p.dto.causedBy ?? null,
      })),
      parentSettlement,
    );

    for (const [index, block] of schedule.blocked) {
      results[index] = {
        opId: prepared[index].dto.opId,
        status: block.status,
        definitive: isDefinitiveStatus(block.status),
        reasonCode: block.reasonCode,
        reasonDetail: block.reasonDetail,
      };
      settledInBatch.set(prepared[index].dto.opId, block.status);
    }

    // ── apply, in chunk transactions ──────────────────────────────────────
    //
    // FAST PATH, then SAFE PATH. Correction 3 of the ratification requires
    // per-operation failure ISOLATION, not per-operation physical COMMIT, and
    // that freedom is what makes NFR-PERF-032 reachable at all: the naive
    // shape — a SAVEPOINT round trip either side of every operation plus two
    // single-row INSERTs — costs four round trips per operation, or two
    // thousand for a 500-operation batch, and measured over the 3 s budget
    // before a single domain handler existed.
    //
    // So a chunk is first attempted WITHOUT savepoints, with its settlement
    // rows flushed set-oriented at the end. If anything at all goes wrong the
    // chunk transaction is discarded — NOTHING COMMITTED, so nothing can have
    // been half-applied — and the identical chunk is re-run with a SAVEPOINT
    // around each operation and one insert at a time. The common case is
    // cheap; the pathological case is exactly as isolated as before.
    const expiresAt = new Date(
      receivedAt.getTime() + SYNC_DEDUP_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const order = [...schedule.order];
    for (
      let start = 0;
      start < order.length;
      start += SYNC_DEFAULT_CHUNK_SIZE
    ) {
      const chunk = order.slice(start, start + SYNC_DEFAULT_CHUNK_SIZE);
      const base = {
        tenantId,
        terminalId,
        branchId,
        batchId: batch.batchId,
        receivedAt,
        expiresAt,
        prepared,
        dedup,
        settledInBatch,
      };
      // Snapshot, so a fast-path abort cannot leave half of the chunk's
      // statuses recorded before the safe re-run recomputes them.
      const settledBefore = new Map(settledInBatch);

      // Results are merged ONLY after the chunk commits: until then an
      // `accepted` is not externally final, and a rollback means those
      // operations were never accepted at all.
      let chunkResults: Array<{ index: number; result: SyncOperationResult }>;
      try {
        chunkResults = await this.prisma.withAuthContext({ tenantId }, (tx) =>
          this.runChunk(tx, chunk, base, 'fast'),
        );
      } catch (error) {
        this.logger.debug(
          `Sync chunk ${start / SYNC_DEFAULT_CHUNK_SIZE} fell back to the ` +
            `isolated path: ${error instanceof Error ? error.message : String(error)}`,
        );
        settledInBatch.clear();
        for (const [k, v] of settledBefore) settledInBatch.set(k, v);
        chunkResults = await this.prisma.withAuthContext({ tenantId }, (tx) =>
          this.runChunk(tx, chunk, base, 'safe'),
        );
      }

      for (const { index, result } of chunkResults) {
        results[index] = result;
      }
      // A long batch must not have its lease expire underneath it while it is
      // legitimately still working; an expired lease would invite a concurrent
      // reclaim of a batch nobody abandoned.
      await this.reservations
        .renew(tenantId, batch.batchId, input.leaseOwner)
        .catch(() => undefined);
      // Deterministic test seam — inert in production (nothing assigns the
      // hook), and the mechanism by which the crash-recovery suite simulates a
      // process death after a chunk has committed.
      await this.failpoint.afterChunk?.(start / SYNC_DEFAULT_CHUNK_SIZE);
    }

    // ── repeats: a second submission of the same opId INSIDE this batch ────
    for (const [index, firstIndex] of schedule.repeats) {
      const first = results[firstIndex];
      results[index] = {
        opId: prepared[index].dto.opId,
        status: SYNC_OPERATION_STATUS.DUPLICATE,
        definitive: true,
        reasonCode: 'duplicate_within_batch',
        reasonDetail:
          'This opId appears more than once in this batch; the answer is the ' +
          'first occurrence’s result.',
        detail: first?.detail,
      };
    }

    // ── FR-OFF-042 clock skew ─────────────────────────────────────────────
    const skew = await this.deviceState.recordBatch({
      tenantId,
      terminalId,
      branchId,
      batchId: batch.batchId,
      protocolVersion: batch.protocolVersion,
      lastCursor: batch.lastServerCursor ?? null,
      devicePhysicalMs: prepared.map((p) => p.physicalMs),
      serverNow: receivedAt,
    });

    const final = results.map(
      (r, i) => r ?? this.internalError(prepared[i].dto.opId),
    );
    const counts: Record<SyncOperationStatus, number> = {
      accepted: 0,
      duplicate: 0,
      conflict: 0,
      rejected: 0,
      deferred: 0,
    };
    for (const r of final) counts[r.status] += 1;

    return {
      batchId: batch.batchId,
      receivedAt: receivedAt.toISOString(),
      protocolVersion: batch.protocolVersion,
      replayed: false,
      counts,
      clockSkewMs: skew.clockSkewMs,
      clockSkewExceededThreshold: skew.exceededThreshold,
      results: final,
    };
  }

  private internalError(opId: string): SyncOperationResult {
    // Unreachable by construction: every index is either scheduled, blocked or
    // a repeat. Present so a future refactor cannot silently drop an operation
    // from the response — a missing result is non-definitive to the client, but
    // an unexplained one is a bug we want to see.
    this.logger.error(
      `Operation ${opId} produced no result; reporting as deferred.`,
    );
    return {
      opId,
      status: SYNC_OPERATION_STATUS.DEFERRED,
      definitive: false,
      reasonCode: 'internal_no_result',
      reasonDetail:
        'The server produced no result for this operation. Retry it.',
    };
  }

  // ─────────────────────────────────────────────────────── chunk execution

  private async runChunk(
    tx: Prisma.TransactionClient,
    chunk: readonly number[],
    base: ChunkBase,
    mode: 'fast' | 'safe',
  ): Promise<Array<{ index: number; result: SyncOperationResult }>> {
    const acc: Array<{ index: number; result: SyncOperationResult }> = [];
    const settlements: Settlement[] = [];

    for (const index of chunk) {
      const prepared = base.prepared[index];
      const decision = this.preflight(prepared, base);

      if (decision.kind === 'result') {
        acc.push({ index, result: decision.result });
        if (decision.settle) {
          settlements.push({ prepared, result: decision.result });
        }
        base.settledInBatch.set(prepared.dto.opId, decision.result.status);
        continue;
      }

      const result =
        mode === 'fast'
          ? await this.applyFast(
              tx,
              prepared,
              base,
              decision.handler,
              settlements,
            )
          : await this.applyIsolated(tx, prepared, base, decision.handler);

      acc.push({ index, result });
      base.settledInBatch.set(prepared.dto.opId, result.status);
    }

    if (settlements.length > 0) {
      if (mode === 'fast') {
        // Two statements for the whole chunk instead of two per operation.
        await this.flushSettlements(tx, base, settlements);
      } else {
        for (const settlement of settlements) {
          await this.flushSettlements(tx, base, [settlement]);
        }
      }
    }
    return acc;
  }

  /**
   * Fast path: call the handler directly, with no savepoint. Any throw abandons
   * the WHOLE chunk transaction, which is safe precisely because nothing in it
   * has committed — the caller then re-runs the same chunk isolated.
   */
  private async applyFast(
    tx: Prisma.TransactionClient,
    prepared: PreparedOperation,
    base: ChunkBase,
    handler: SyncOperationHandler,
    settlements: Settlement[],
  ): Promise<SyncOperationResult> {
    const outcome = await handler.apply(
      this.handlerContext(tx, prepared, base),
    );
    const result = this.resultFrom(prepared, outcome ?? undefined);
    settlements.push({ prepared, result });
    return result;
  }

  /**
   * Isolated path: a SAVEPOINT around the handler, so one failing operation
   * rolls back only itself and its siblings in the same transaction survive —
   * `FR-OFF-023`, "a single failing operation SHALL NOT fail the batch".
   */
  private async applyIsolated(
    tx: Prisma.TransactionClient,
    prepared: PreparedOperation,
    base: ChunkBase,
    handler: SyncOperationHandler,
  ): Promise<SyncOperationResult> {
    const name = `sync_sp_${(this.savepointCounter += 1)}`;
    const attempt = await withSavepoint(tx, name, async () => {
      const outcome = await handler.apply(
        this.handlerContext(tx, prepared, base),
      );
      const result = this.resultFrom(prepared, outcome ?? undefined);
      // THE ATOMICITY POINT: the authoritative dedup row is written inside the
      // same savepoint and the same transaction as the handler's business
      // effect. There is no window in which one exists without the other.
      await this.flushSettlements(tx, base, [{ prepared, result }]);
      return result;
    });
    if (attempt.ok) return attempt.value;

    // The handler threw, or the settlement collided. Distinguish the two: a
    // dedup row that now exists means a concurrent worker settled this opId.
    const concurrent = await tx.syncOperationDedup.findUnique({
      where: {
        tenantId_opId: { tenantId: base.tenantId, opId: prepared.dto.opId },
      },
    });
    if (concurrent) return this.duplicateResult(prepared.dto.opId);

    const message =
      attempt.error instanceof Error
        ? attempt.error.message
        : String(attempt.error);
    this.logger.warn(
      `Operation ${prepared.dto.opId} (${prepared.dto.type}) rejected: ${message}`,
    );
    // A handler that threw `SyncOperationRejectedError` gets ITS reasonCode —
    // e.g. `authorization_denied`, `resource_not_found` — instead of the
    // generic `handler_error` bucket, so the CONFLICT CONTRACT (§14) stays
    // machine-readable for a production rejection, not just a kernel fault.
    const rejected =
      attempt.error instanceof SyncOperationRejectedError
        ? this.rejectedResult(
            prepared.dto.opId,
            attempt.error.reasonCode,
            attempt.error.message,
          )
        : this.rejectedResult(
            prepared.dto.opId,
            SYNC_REASON.HANDLER_ERROR,
            message,
          );
    // Recorded in its OWN savepoint, so a collision here cannot abort the chunk
    // and take its successful siblings down with it.
    const settleName = `sync_sp_${(this.savepointCounter += 1)}`;
    const written = await withSavepoint(tx, settleName, () =>
      this.flushSettlements(tx, base, [{ prepared, result: rejected }]),
    );
    if (!written.ok) {
      const raced = await tx.syncOperationDedup.findUnique({
        where: {
          tenantId_opId: { tenantId: base.tenantId, opId: prepared.dto.opId },
        },
      });
      if (raced) return this.duplicateResult(prepared.dto.opId);
      throw written.error;
    }
    return rejected;
  }

  // ───────────────────────────────────────────────────────────── preflight

  /**
   * Everything decidable BEFORE the handler runs: an already-settled opId, a
   * causal parent that did not end up applied, an oversized operation, an
   * unknown type, an unsupported payload version. None of these writes anything
   * except through the returned settlement, so none of them can fail a chunk.
   */
  private preflight(
    prepared: PreparedOperation,
    base: ChunkBase,
  ):
    | { kind: 'result'; result: SyncOperationResult; settle: boolean }
    | { kind: 'apply'; handler: SyncOperationHandler } {
    const dto = prepared.dto;

    // ── already settled? FR-OFF-021 ───────────────────────────────────────
    const existing = base.dedup.get(dto.opId);
    if (existing) {
      if (existing.fingerprint !== prepared.fingerprint) {
        // Same key, different operation. Deterministic client-defect rejection;
        // the original effect is NEVER re-applied and nothing is overwritten.
        return {
          kind: 'result',
          settle: false,
          result: this.rejectedResult(
            dto.opId,
            SYNC_REASON.DUPLICATE_OP_ID_DIFFERENT_FINGERPRINT,
            'This opId was already settled for a different operation body. ' +
              'Reusing an opId with a different payload indicates a client defect.',
          ),
        };
      }
      return {
        kind: 'result',
        settle: false,
        result: {
          ...this.duplicateResult(dto.opId),
          detail: (
            existing.result as { detail?: Record<string, unknown> } | null
          )?.detail,
        },
      };
    }

    // ── runtime causal cascade ────────────────────────────────────────────
    // The scheduler ordered parents first, but a parent's OUTCOME is only known
    // once it has run. A child of a parent that did not end up applied must not
    // be applied either.
    //
    // D4-1B — a parent that settled `conflict` gets the SAME treatment here as
    // `parentSettlement()` above gives a parent already in the dedup registry
    // (see that closure's comment, and operation-scheduler.ts's "WHY A
    // CONFLICTED PARENT DEFERS, NOT REJECTS"): `conflict` is not proof the
    // parent's effect can never apply, so its child is DEFERRED — retryable —
    // rather than definitively REJECTED. Only `rejected` (and the scheduler's
    // own pre-computed `deferred`) get their prior treatment unchanged.
    if (dto.causedBy) {
      const parentStatus = base.settledInBatch.get(dto.causedBy);
      if (
        parentStatus !== undefined &&
        parentStatus !== SYNC_OPERATION_STATUS.ACCEPTED &&
        parentStatus !== SYNC_OPERATION_STATUS.DUPLICATE
      ) {
        const nonDefinitive =
          parentStatus === SYNC_OPERATION_STATUS.DEFERRED ||
          parentStatus === SYNC_OPERATION_STATUS.CONFLICT;
        return {
          kind: 'result',
          settle: false,
          result: {
            opId: dto.opId,
            status: nonDefinitive
              ? SYNC_OPERATION_STATUS.DEFERRED
              : SYNC_OPERATION_STATUS.REJECTED,
            definitive: !nonDefinitive,
            reasonCode:
              parentStatus === SYNC_OPERATION_STATUS.CONFLICT
                ? SYNC_REASON.CAUSAL_PARENT_CONFLICTED
                : parentStatus === SYNC_OPERATION_STATUS.DEFERRED
                  ? SYNC_REASON.CAUSAL_PARENT_MISSING
                  : SYNC_REASON.CAUSAL_PARENT_REJECTED,
            reasonDetail: `Causal parent ${dto.causedBy} resolved as ${parentStatus}.`,
          },
        };
      }
    }

    // A per-operation size cap is a per-operation rejection, never a batch one:
    // one fat operation must not cost a terminal its whole batch.
    if (prepared.bytes > SYNC_MAX_OPERATION_BYTES) {
      return {
        kind: 'result',
        settle: true,
        result: this.rejectedResult(
          dto.opId,
          SYNC_REASON.PAYLOAD_TOO_LARGE,
          `Operation is ${prepared.bytes} bytes; the limit is ${SYNC_MAX_OPERATION_BYTES}.`,
        ),
      };
    }

    const handler = this.registry.get(dto.type);
    if (!handler) {
      return {
        kind: 'result',
        settle: true,
        result: this.rejectedResult(
          dto.opId,
          SYNC_REASON.UNKNOWN_OPERATION_TYPE,
          `No handler is registered for operation type '${dto.type}'.`,
        ),
      };
    }
    if (!handler.supportedSchemaVersions.includes(dto.schemaVersion)) {
      // Strict, both ways. Silently ignoring an unrecognised payload version
      // would mean discarding part of a financial operation.
      return {
        kind: 'result',
        settle: true,
        result: this.rejectedResult(
          dto.opId,
          SYNC_REASON.SCHEMA_VERSION_UNSUPPORTED,
          `Operation type '${dto.type}' does not support schemaVersion ` +
            `${dto.schemaVersion} (supported: ${handler.supportedSchemaVersions.join(', ')}).`,
        ),
      };
    }

    return { kind: 'apply', handler };
  }

  // ────────────────────────────────────────────────────────────── plumbing

  private handlerContext(
    tx: Prisma.TransactionClient,
    prepared: PreparedOperation,
    base: ChunkBase,
  ): SyncOperationContext {
    const dto = prepared.dto;
    return {
      tx,
      tenantId: base.tenantId,
      terminalId: base.terminalId,
      branchId: base.branchId,
      opId: dto.opId,
      entityId: dto.entityId,
      actorEmployeeId: dto.actorEmployeeId ?? null,
      causedBy: dto.causedBy ?? null,
      hlc: dto.hlc,
      occurredAt: new Date(dto.occurredAt),
      schemaVersion: dto.schemaVersion,
      payload: dto.payload,
    };
  }

  private resultFrom(
    prepared: PreparedOperation,
    outcome: SyncOperationOutcome | undefined,
  ): SyncOperationResult {
    return {
      opId: prepared.dto.opId,
      status: outcome?.status ?? SYNC_OPERATION_STATUS.ACCEPTED,
      definitive: true,
      reasonCode: outcome?.reasonCode,
      reasonDetail: outcome?.reasonDetail,
      conflictId: outcome?.conflictId,
      detail: outcome?.detail,
    };
  }

  private duplicateResult(opId: string): SyncOperationResult {
    return {
      opId,
      status: SYNC_OPERATION_STATUS.DUPLICATE,
      definitive: true,
      reasonDetail:
        'Already applied; the original result is returned unchanged.',
    };
  }

  private rejectedResult(
    opId: string,
    reasonCode: string,
    reasonDetail: string,
  ): SyncOperationResult {
    return {
      opId,
      status: SYNC_OPERATION_STATUS.REJECTED,
      definitive: true,
      reasonCode,
      reasonDetail,
    };
  }

  /**
   * Write BOTH halves of each settlement: the authoritative dedup identity, and
   * the history row used for inspection, conflict analysis and replay
   * investigation. History is written only for operations the server actually
   * PROCESSED — a `duplicate` adds no new fact, and a `deferred` settles nothing
   * at all, which is why neither reaches this method.
   */
  private async flushSettlements(
    tx: Prisma.TransactionClient,
    base: ChunkBase,
    settlements: readonly Settlement[],
  ): Promise<void> {
    await tx.syncOperationDedup.createMany({
      data: settlements.map(({ prepared, result }) => ({
        tenantId: base.tenantId,
        opId: prepared.dto.opId,
        fingerprint: prepared.fingerprint,
        status: result.status,
        reasonCode: result.reasonCode ?? null,
        result: result as unknown as Prisma.InputJsonValue,
        batchId: base.batchId,
        terminalId: base.terminalId,
        settledAt: base.receivedAt,
        expiresAt: base.expiresAt,
      })),
    });
    await tx.syncOperation.createMany({
      data: settlements.map(({ prepared, result }) => ({
        tenantId: base.tenantId,
        opId: prepared.dto.opId,
        receivedAt: base.receivedAt,
        batchId: base.batchId,
        terminalId: base.terminalId,
        branchId: base.branchId,
        actorEmployeeId: prepared.dto.actorEmployeeId ?? null,
        type: prepared.dto.type,
        entityType: prepared.dto.type.split('.')[0],
        entityId: prepared.dto.entityId,
        causedBy: prepared.dto.causedBy ?? null,
        hlc: prepared.dto.hlc,
        originDeviceTime: new Date(prepared.dto.occurredAt),
        schemaVersion: prepared.dto.schemaVersion,
        payload: prepared.dto.payload as Prisma.InputJsonValue,
        fingerprint: prepared.fingerprint,
        status: result.status,
        reasonCode: result.reasonCode ?? null,
      })),
    });
  }
}
