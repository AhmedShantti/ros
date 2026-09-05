import {
  SYNC_OPERATION_STATUS,
  SYNC_REASON,
} from '../protocol/protocol.constants';

/**
 * Causal scheduling — `FR-OFF-022` [M]: "Operations within a batch SHALL be
 * applied in causal order. An operation whose causal parent has not been applied
 * SHALL be deferred, not rejected."
 *
 * Pure and dependency-free, so it is unit-testable without a database and can be
 * driven from a conformance corpus later.
 *
 * ── ORDERING ──────────────────────────────────────────────────────────────
 * Kahn's algorithm over the `causedBy` edges, with independent nodes broken
 * deterministically by HLC and then by opId. Because the ratified HLC encoding
 * is fixed-width, a plain string comparison of `hlc` IS the causal order — no
 * parsing needed here, and the client can predict the server's order exactly.
 *
 * ── WHY A REJECTED PARENT REJECTS ITS CHILD ───────────────────────────────
 * `FR-OFF-022` says a child whose parent "has not been applied" is deferred.
 * That is right when the parent MIGHT still arrive. It is wrong when the parent
 * has already been settled definitively as `rejected`: a handler THREW, the
 * kernel rolled that attempt back to its savepoint, and `sync.operation_dedup`
 * replays that exact outcome forever — the parent's effect did not happen and
 * structurally cannot ever happen through this protocol. Deferring the child
 * would stall it in the outbox forever, and `FR-OFF-024` would then never let
 * the client clear it. The child is therefore REJECTED with
 * `causal_parent_rejected` — definitive, so the client can dead-letter it
 * instead of retrying until the end of time.
 *
 * ── WHY A CONFLICTED PARENT DEFERS, NOT REJECTS (D4-1B review of the above) ──
 * D4-1A's own report flagged this exact line for D4-1B review, and this task's
 * brief (§10) independently requires the distinction: a parent settled as
 * `conflict` is NOT the same fact as one settled `rejected`. A handler
 * returning `{status: 'conflict', ...}` records a `sync.conflict_records` row
 * whose `resolution` may be `manual_pending` — a manager has not yet decided
 * the outcome, and manual resolution can still cause the conflicted change to
 * take effect through a path outside this batch. Treating that the same as a
 * structurally-impossible rejection would permanently dead-letter a child
 * whose parent might yet be resolved in its favour — the exact
 * over-propagation this task instructs against ("do not blanket-propagate
 * from a generic conflict bucket"). Such a child is therefore DEFERRED with
 * `causal_parent_conflicted`, not rejected: retried on the client's normal
 * outbox cadence, at the (accepted) cost that a conflict resolved as
 * "permanently not applied" leaves the child retrying until an operator
 * intervenes — the safer failure mode of the two, and named explicitly rather
 * than silently chosen (D4-1B report, "causal-parent semantics").
 */

/** What the dedup registry knows about an operation the batch refers to. */
export type ParentSettlement =
  /** Settled as `accepted` (or already answered `duplicate`) — the parent IS applied. */
  | 'applied'
  /** Settled definitively as `rejected` — structurally can never be applied. */
  | 'not-applied'
  /** Settled as `conflict` — did not apply as submitted, but NOT proven to be
   * permanently unresolvable (see the class docblock). Treated as retryable. */
  | 'conflicted'
  /** No definitive record. It may still arrive in a later batch. */
  | 'unknown';

export interface SchedulableOperation {
  readonly opId: string;
  /** Canonical, already-validated HLC. Compared as a string. */
  readonly hlc: string;
  readonly causedBy: string | null;
}

export interface ScheduleBlock {
  readonly status:
    | typeof SYNC_OPERATION_STATUS.DEFERRED
    | typeof SYNC_OPERATION_STATUS.REJECTED;
  readonly reasonCode: string;
  readonly reasonDetail: string;
}

export interface Schedule {
  /** Indices into the input array, in the order they must be processed. */
  readonly order: readonly number[];
  /** Indices that must NOT be processed, with their predetermined outcome. */
  readonly blocked: ReadonlyMap<number, ScheduleBlock>;
  /**
   * Index -> index of the FIRST submission of the same opId in this batch.
   * A repeated opId inside one batch is answered `duplicate` from the first
   * occurrence's result, exactly as a repeat in a later batch would be.
   */
  readonly repeats: ReadonlyMap<number, number>;
}

function compareForOrder(
  a: SchedulableOperation,
  b: SchedulableOperation,
): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.opId === b.opId) return 0;
  return a.opId < b.opId ? -1 : 1;
}

export function scheduleOperations(
  operations: readonly SchedulableOperation[],
  parentSettlement: (opId: string) => ParentSettlement,
): Schedule {
  const blocked = new Map<number, ScheduleBlock>();
  const repeats = new Map<number, number>();

  // First submission wins the node; later submissions of the same opId are
  // answered from its result rather than becoming separate graph nodes.
  const firstIndexByOpId = new Map<string, number>();
  const nodes: number[] = [];
  operations.forEach((op, index) => {
    const first = firstIndexByOpId.get(op.opId);
    if (first === undefined) {
      firstIndexByOpId.set(op.opId, index);
      nodes.push(index);
    } else {
      repeats.set(index, first);
    }
  });

  // ── Phase A: parents that are NOT in this batch ─────────────────────────
  for (const index of nodes) {
    const parent = operations[index].causedBy;
    if (parent === null || firstIndexByOpId.has(parent)) continue;
    const settlement = parentSettlement(parent);
    if (settlement === 'applied') continue;
    blocked.set(
      index,
      settlement === 'not-applied'
        ? {
            status: SYNC_OPERATION_STATUS.REJECTED,
            reasonCode: SYNC_REASON.CAUSAL_PARENT_REJECTED,
            reasonDetail:
              `Causal parent ${parent} was settled definitively without being ` +
              'applied, so this operation can never become applicable.',
          }
        : settlement === 'conflicted'
          ? {
              status: SYNC_OPERATION_STATUS.DEFERRED,
              reasonCode: SYNC_REASON.CAUSAL_PARENT_CONFLICTED,
              reasonDetail:
                `Causal parent ${parent} settled as a conflict, not a ` +
                'definitive rejection — it may yet be resolved. Retain this ' +
                'operation and resend it once the parent settles as accepted ' +
                'or is definitively rejected.',
            }
          : {
              status: SYNC_OPERATION_STATUS.DEFERRED,
              reasonCode: SYNC_REASON.CAUSAL_PARENT_MISSING,
              reasonDetail:
                `Causal parent ${parent} has not been applied. Retain this ` +
                'operation and resend it once the parent is accepted.',
            },
    );
  }

  // ── Phase B: propagate a block down the in-batch edges ──────────────────
  // A child of a blocked parent inherits its fate: deferred stays deferred
  // (the parent may yet arrive), rejected stays rejected (it never will).
  const childrenOf = new Map<number, number[]>();
  for (const index of nodes) {
    const parent = operations[index].causedBy;
    if (parent === null) continue;
    const parentIndex = firstIndexByOpId.get(parent);
    if (parentIndex === undefined || parentIndex === index) continue;
    const bucket = childrenOf.get(parentIndex);
    if (bucket) bucket.push(index);
    else childrenOf.set(parentIndex, [index]);
  }

  const queue = [...blocked.keys()];
  while (queue.length > 0) {
    const parentIndex = queue.shift() as number;
    const block = blocked.get(parentIndex) as ScheduleBlock;
    for (const childIndex of childrenOf.get(parentIndex) ?? []) {
      if (blocked.has(childIndex)) continue;
      blocked.set(childIndex, {
        status: block.status,
        reasonCode: block.reasonCode,
        reasonDetail:
          `Causal ancestor ${operations[parentIndex].opId} is ` +
          `${block.status}; this operation inherits that outcome.`,
      });
      queue.push(childIndex);
    }
  }

  // ── Phase C: topological order over what remains ────────────────────────
  const live = nodes.filter((index) => !blocked.has(index));
  const liveSet = new Set(live);
  const indegree = new Map<number, number>();
  for (const index of live) {
    const parent = operations[index].causedBy;
    const parentIndex =
      parent === null ? undefined : firstIndexByOpId.get(parent);
    // A self-edge is a one-node cycle; it must not count as a root.
    const hasLiveParent = parentIndex !== undefined && liveSet.has(parentIndex);
    indegree.set(index, hasLiveParent ? 1 : 0);
  }

  const ready = live
    .filter((index) => indegree.get(index) === 0)
    .sort((a, b) => compareForOrder(operations[a], operations[b]));

  const order: number[] = [];
  while (ready.length > 0) {
    const index = ready.shift() as number;
    order.push(index);
    const unlocked: number[] = [];
    for (const childIndex of childrenOf.get(index) ?? []) {
      if (!liveSet.has(childIndex)) continue;
      const next = (indegree.get(childIndex) ?? 0) - 1;
      indegree.set(childIndex, next);
      if (next === 0) unlocked.push(childIndex);
    }
    if (unlocked.length > 0) {
      ready.push(...unlocked);
      ready.sort((a, b) => compareForOrder(operations[a], operations[b]));
    }
  }

  // Anything Kahn could not reach is in — or downstream of — a `causedBy`
  // cycle. A cycle is a client defect that deferral could never resolve, so it
  // is definitively rejected rather than left to retry forever.
  if (order.length !== live.length) {
    const scheduled = new Set(order);
    for (const index of live) {
      if (scheduled.has(index)) continue;
      blocked.set(index, {
        status: SYNC_OPERATION_STATUS.REJECTED,
        reasonCode: SYNC_REASON.CAUSAL_CYCLE,
        reasonDetail:
          'This operation is part of, or descends from, a cycle in the ' +
          'causedBy graph. A cycle can never be resolved by deferral.',
      });
    }
  }

  return { order, blocked, repeats };
}
