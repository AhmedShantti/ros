import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared HLC conformance corpus runner — `FR-OFF-050` [M], `CT-06`, `CT-10`.
 *
 * The corpus lives OUTSIDE this package — `kitchen-kit/conformance/hlc/` — so it
 * belongs to neither runtime, exactly as the tax corpus already does. This file
 * is the TypeScript half. The Dart half does not exist yet, and neither does the
 * CI job that would run both, so `FR-OFF-050`/`FR-OFF-051` remain PARTIAL: the
 * server matching the corpus proves the server is self-consistent, not that
 * client and server agree.
 *
 * ── ENCODING RULES, INHERITED FROM `conformance/README.md` ────────────────
 * HLC states and messages are carried as their CANONICAL STRING form, which is
 * the whole point of the fixed-width encoding — no structural decomposition to
 * disagree about. `physicalMs` and `logical` are decimal STRINGS rather than
 * JSON numbers, for the same reason the tax corpus forbids floats: a corpus that
 * can itself lose precision becomes a source of the divergence it exists to
 * detect.
 *
 * The runner is deliberately STRICT: a malformed case throws rather than being
 * skipped, because a case that silently does not run is worse than no case.
 */

export class HlcCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlcCorpusError';
  }
}

export interface HlcLocalEventCase {
  readonly id: string;
  readonly description?: string;
  readonly state: string;
  readonly physicalMs: string;
  readonly expected?: string;
  readonly expectError?: boolean;
}

export interface HlcReceiveEventCase extends HlcLocalEventCase {
  readonly message: string;
}

export interface HlcCompareCase {
  readonly id: string;
  readonly description?: string;
  readonly a: string;
  readonly b: string;
  readonly expected: 'lt' | 'eq' | 'gt';
}

export interface HlcSortCase {
  readonly id: string;
  readonly description?: string;
  readonly input: readonly string[];
  readonly expectedOrder: readonly string[];
}

export interface HlcEncodingCase {
  readonly id: string;
  readonly description?: string;
  readonly physicalMs: string;
  readonly logical: string;
  readonly node: string;
  readonly expected: string;
}

export interface HlcMalformedCase {
  readonly id: string;
  readonly raw: string;
}

export interface HlcCorpusFile {
  readonly corpusVersion: string;
  readonly description?: string;
  readonly localEvent?: readonly HlcLocalEventCase[];
  readonly receiveEvent?: readonly HlcReceiveEventCase[];
  readonly sequence?: readonly HlcReceiveEventCase[];
  readonly compare?: readonly HlcCompareCase[];
  readonly ordering?: readonly HlcCompareCase[];
  readonly sort?: readonly HlcSortCase[];
  readonly encoding?: readonly HlcEncodingCase[];
  readonly malformed?: readonly HlcMalformedCase[];
}

/** `kitchen-kit/conformance/hlc` — four levels up from `src/modules/sync/hlc`. */
export const HLC_CORPUS_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'hlc',
);

function assertNoFloats(raw: string, file: string): void {
  // A decimal point outside a string literal would mean a JSON number carrying
  // fractional precision — forbidden by the corpus encoding rules.
  const withoutStrings = raw.replace(/"(?:\\.|[^"\\])*"/g, '""');
  if (/[:\s[,]\s*-?\d+\.\d/.test(withoutStrings)) {
    throw new HlcCorpusError(
      `${file}: a non-string JSON number with a decimal point was found. ` +
        'Corpus values must be decimal strings.',
    );
  }
}

export function loadHlcCorpus(dir: string = HLC_CORPUS_DIR): {
  file: string;
  corpus: HlcCorpusFile;
}[] {
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.corpus.json'))
    .sort();
  if (names.length === 0) {
    throw new HlcCorpusError(`No HLC corpus files found in ${dir}.`);
  }
  return names.map((name) => {
    const raw = readFileSync(join(dir, name), 'utf8');
    assertNoFloats(raw, name);
    const corpus = JSON.parse(raw) as HlcCorpusFile;
    if (typeof corpus.corpusVersion !== 'string') {
      throw new HlcCorpusError(`${name}: corpusVersion must be a string.`);
    }
    return { file: name, corpus };
  });
}

/** Parse a corpus decimal string into an exact integer, or throw. */
export function corpusInt(value: string, field: string): number {
  if (!/^\d+$/.test(value)) {
    throw new HlcCorpusError(
      `${field} must be a decimal digit string; got '${value}'.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HlcCorpusError(
      `${field} '${value}' is not an exactly representable integer.`,
    );
  }
  return parsed;
}
