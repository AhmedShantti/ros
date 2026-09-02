import { ParentSettlement, scheduleOperations } from './operation-scheduler';
import {
  SYNC_OPERATION_STATUS,
  SYNC_REASON,
} from '../protocol/protocol.constants';

const NODE = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const hlcAt = (ms: number, logical = 0) =>
  `${String(ms).padStart(13, '0')}.${String(logical).padStart(5, '0')}.${NODE}`;

const op = (opId: string, ms: number, causedBy: string | null = null) => ({
  opId,
  hlc: hlcAt(ms),
  causedBy,
});

const noParents = (): ParentSettlement => 'unknown';

describe('FR-OFF-022 causal scheduling', () => {
  it('orders independent operations deterministically by HLC', () => {
    const ops = [op('c', 300), op('a', 100), op('b', 200)];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order.map((i) => ops[i].opId)).toEqual(['a', 'b', 'c']);
    expect(schedule.blocked.size).toBe(0);
  });

  it('breaks an exact HLC tie on opId, so the order is total', () => {
    const ops = [
      { opId: 'b', hlc: hlcAt(100), causedBy: null },
      { opId: 'a', hlc: hlcAt(100), causedBy: null },
    ];
    expect(
      scheduleOperations(ops, noParents).order.map((i) => ops[i].opId),
    ).toEqual(['a', 'b']);
  });

  it('places a parent before its child even when the child was submitted first', () => {
    // The child also carries the EARLIER HLC, so ordering by HLC alone would
    // get this wrong — causality has to win.
    const ops = [op('child', 100, 'parent'), op('parent', 900)];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order.map((i) => ops[i].opId)).toEqual(['parent', 'child']);
    expect(schedule.blocked.size).toBe(0);
  });

  it('defers — never rejects — an operation whose parent is simply absent', () => {
    const ops = [op('child', 100, 'absent-parent')];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order).toHaveLength(0);
    const block = schedule.blocked.get(0);
    expect(block?.status).toBe(SYNC_OPERATION_STATUS.DEFERRED);
    expect(block?.reasonCode).toBe(SYNC_REASON.CAUSAL_PARENT_MISSING);
  });

  it('proceeds when the absent parent was already applied in an earlier batch', () => {
    const ops = [op('child', 100, 'earlier-parent')];
    const schedule = scheduleOperations(ops, (id) =>
      id === 'earlier-parent' ? 'applied' : 'unknown',
    );
    expect(schedule.order.map((i) => ops[i].opId)).toEqual(['child']);
  });

  it('rejects — does not defer — a child whose parent was settled without being applied', () => {
    // Deferring here would strand the operation in the outbox forever, because
    // the parent can never become applied. FR-OFF-024 would then never let the
    // client clear it.
    const ops = [op('child', 100, 'dead-parent')];
    const schedule = scheduleOperations(ops, (id) =>
      id === 'dead-parent' ? 'not-applied' : 'unknown',
    );
    const block = schedule.blocked.get(0);
    expect(block?.status).toBe(SYNC_OPERATION_STATUS.REJECTED);
    expect(block?.reasonCode).toBe(SYNC_REASON.CAUSAL_PARENT_REJECTED);
  });

  it('cascades a block down a chain, and does not schedule the descendants', () => {
    const ops = [op('a', 100, 'absent'), op('b', 200, 'a'), op('c', 300, 'b')];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order).toHaveLength(0);
    expect([...schedule.blocked.keys()].sort()).toEqual([0, 1, 2]);
    for (const block of schedule.blocked.values()) {
      expect(block.status).toBe(SYNC_OPERATION_STATUS.DEFERRED);
    }
  });

  it('rejects a causedBy cycle rather than deferring it forever', () => {
    const ops = [op('a', 100, 'b'), op('b', 200, 'a')];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order).toHaveLength(0);
    for (const block of schedule.blocked.values()) {
      expect(block.status).toBe(SYNC_OPERATION_STATUS.REJECTED);
      expect(block.reasonCode).toBe(SYNC_REASON.CAUSAL_CYCLE);
    }
  });

  it('rejects a self-referencing operation as a one-node cycle', () => {
    const ops = [op('a', 100, 'a')];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order).toHaveLength(0);
    expect(schedule.blocked.get(0)?.reasonCode).toBe(SYNC_REASON.CAUSAL_CYCLE);
  });

  it('keeps an independent operation schedulable alongside a cycle', () => {
    const ops = [op('a', 100, 'b'), op('b', 200, 'a'), op('free', 50)];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order.map((i) => ops[i].opId)).toEqual(['free']);
    expect(schedule.blocked.size).toBe(2);
  });

  it('answers a repeated opId inside one batch from the first occurrence', () => {
    const ops = [op('a', 100), op('a', 100)];
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order).toEqual([0]);
    expect(schedule.repeats.get(1)).toBe(0);
  });

  it('schedules a 500-operation chain in exact causal order', () => {
    // The NFR-PERF-032 batch size, arranged worst-case: every operation depends
    // on the previous one and they are submitted in reverse.
    const ops = Array.from({ length: 500 }, (_, i) =>
      op(`op-${i}`, 1000 + i, i === 0 ? null : `op-${i - 1}`),
    ).reverse();
    const schedule = scheduleOperations(ops, noParents);
    expect(schedule.order).toHaveLength(500);
    expect(schedule.order.map((i) => ops[i].opId)).toEqual(
      Array.from({ length: 500 }, (_, i) => `op-${i}`),
    );
  });
});
