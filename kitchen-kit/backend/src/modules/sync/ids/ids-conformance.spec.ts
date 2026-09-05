import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulidToUUID } from 'ulidx';
import { UUID_PATTERN, newId } from '../../../common/ids';

/**
 * The TypeScript half of the shared identifier conformance suite —
 * `FR-OFF-015` and `GD-D1-01` (ratified 2026-09-02).
 *
 * Only the decisions this slice actually implements are graded. There is no
 * vector here for anything D4-1A does not do.
 */
const CORPUS = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'ids',
  'ids-rendering.corpus.json',
);

interface IdsCorpus {
  readonly corpusVersion: string;
  readonly rendering: readonly { id: string; ulid: string; uuid: string }[];
  readonly acceptedWireForm: readonly {
    id: string;
    value: string;
    valid: boolean;
  }[];
  readonly serverNeverRemaps: readonly {
    id: string;
    opId: string;
    entityId: string;
  }[];
}

describe('FR-OFF-015 / GD-D1-01 identifier conformance corpus', () => {
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as IdsCorpus;

  it('lives outside the backend package', () => {
    expect(CORPUS).toMatch(/kitchen-kit\/conformance\/ids\//);
    expect(corpus.corpusVersion).toBe('1');
  });

  for (const c of corpus.rendering) {
    it(`renders the same 128 bits: ${c.id}`, () => {
      expect(ulidToUUID(c.ulid)).toBe(c.uuid);
    });
  }

  for (const c of corpus.acceptedWireForm) {
    it(`wire form ${c.valid ? 'accepted' : 'rejected'}: ${c.id}`, () => {
      expect(UUID_PATTERN.test(c.value)).toBe(c.valid);
    });
  }

  it('generates ids that satisfy the wire contract', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(UUID_PATTERN.test(newId())).toBe(true);
    }
  });

  it('generates ids that are time-ordered, so index locality holds (ADR-009)', () => {
    // ULIDs are timestamp-prefixed; ids minted in different milliseconds must
    // sort in creation order as plain strings.
    const first = newId();
    const start = Date.now();
    while (Date.now() === start) {
      /* spin to the next millisecond */
    }
    const second = newId();
    expect(first < second).toBe(true);
  });
});
