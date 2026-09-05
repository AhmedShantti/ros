import { newId, UUID_PATTERN } from './ids';

/**
 * A1-3B integration hard-review item: newId() moved from plain ulid() to a
 * module-level monotonicFactory() because synchronous same-millisecond
 * generation (multiple movement/allocation ids per group, no DB round trip
 * between calls) exposed that plain ulid() does not guarantee strict
 * generation-order sorting within one millisecond. This proves the fix and
 * pins the unchanged wire contract.
 */
describe('newId()', () => {
  it('produces IDs matching the existing UUID_PATTERN wire contract', () => {
    for (let i = 0; i < 50; i++) {
      expect(newId()).toMatch(UUID_PATTERN);
    }
  });

  it('generates many IDs synchronously in the same millisecond, each strictly greater than the last', () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(newId());
    }

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] > ids[i - 1]).toBe(true);
    }
  });

  it('never produces a duplicate across a large same-process batch', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      ids.add(newId());
    }
    expect(ids.size).toBe(5000);
  });

  it('every generated id still validates against UUID_PATTERN (parse/validation helpers unaffected)', () => {
    const ids = Array.from({ length: 200 }, () => newId());
    expect(ids.every((id) => UUID_PATTERN.test(id))).toBe(true);
  });
});
