/**
 * Country Pack registry — activation policy and version resolution.
 *
 * FR-LOC-021 [M]: "Country packs SHALL be versioned with effective dates, and
 * historical transactions SHALL be interpreted under the pack version in force
 * at their transaction time." Two lookups implement exactly that sentence:
 *
 *   · {@link CountryPackRegistry.resolveEffective} — which version was in force
 *     at instant `t`. Used ONCE, when an order is created, to pin the version.
 *   · {@link CountryPackRegistry.resolveExact} — the pack a historical order
 *     already names. Used for every later interpretation of that order.
 *
 * Because an order stores the version it was priced under, activating a newer
 * pack cannot reinterpret a single historical sale: nothing re-derives a version
 * from "the code plus today's date".
 *
 * ── ACTIVATION IS FAIL-CLOSED ───────────────────────────────────────────────
 * `activate` verifies the signature BEFORE the pack becomes reachable. A pack
 * that is unsigned, invalidly signed, or offered while no verifier is configured
 * never enters the map, so `resolveEffective` cannot return it and no sale can
 * be priced under it (FR-LOC-022, FR-LOC-031).
 */

import {
  COUNTRY_PACK_VERSION_MAX_LENGTH,
  CountryPack,
  packLabel,
} from './country-pack.model';
import {
  ParseCountryPackOptions,
  parseCountryPack,
} from './country-pack.parser';
import {
  CountryPackSignatureVerifier,
  canonicalCountryPackBytes,
  readSignature,
  stripSignature,
} from './country-pack.signature';

/** Raised when a pack is structurally valid but may not be activated. */
export class CountryPackActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountryPackActivationError';
  }
}

/** Raised when no pack can be resolved for a jurisdiction and instant. */
export class CountryPackUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountryPackUnavailableError';
  }
}

export class CountryPackRegistry {
  /** code -> version -> pack. Versions within a code are kept whole. */
  private readonly byCode = new Map<string, Map<string, CountryPack>>();

  constructor(
    private readonly verifier: CountryPackSignatureVerifier,
    private readonly parseOptions: ParseCountryPackOptions,
  ) {}

  /**
   * Validate, verify and register a pack document.
   *
   * Order matters: structure first (a malformed document should report its
   * malformation, not a signature failure), then the signature gate, then
   * registration. Nothing is registered unless both pass.
   *
   * @throws CountryPackValidationError when the document is malformed.
   * @throws CountryPackActivationError when the signature does not verify.
   */
  async activate(document: unknown): Promise<CountryPack> {
    const pack = parseCountryPack(document, this.parseOptions);
    const payload = stripSignature(document);
    const signature = readSignature(document);

    let verified = false;
    try {
      verified = await this.verifier.verify({
        code: pack.code,
        version: pack.version,
        document: payload,
        canonicalBytes: canonicalCountryPackBytes(payload),
        signature,
      });
    } catch {
      // A verifier that throws is a verifier that did not attest. Never let an
      // exception path become an accidental "accepted", and never surface the
      // underlying crypto error, which can leak key material or paths.
      verified = false;
    }

    if (!verified) {
      throw new CountryPackActivationError(
        `Country pack ${packLabel(pack)} was not activated: its signature was not ` +
          'accepted by an authorised release key (FR-LOC-022). An unsigned or ' +
          'invalidly-signed pack is rejected.',
      );
    }

    const versions =
      this.byCode.get(pack.code) ?? new Map<string, CountryPack>();
    const existing = versions.get(pack.version);
    if (
      existing &&
      existing.effectiveFrom.getTime() !== pack.effectiveFrom.getTime()
    ) {
      // Re-registering a version with a different effective date would silently
      // rewrite history for every order already pinned to it.
      throw new CountryPackActivationError(
        `Country pack ${packLabel(pack)} is already active with a different ` +
          'effective date. A published version is immutable (FR-LOC-021).',
      );
    }
    versions.set(pack.version, pack);
    this.byCode.set(pack.code, versions);
    return pack;
  }

  /**
   * FR-LOC-021 — the version in force at `at` for `code`.
   *
   * "In force" means the latest `effectiveFrom` that is not in the future
   * relative to `at`. A pack whose effective date has not arrived is invisible,
   * so distributing it early (FR-LOC-024) cannot activate it early.
   *
   * Ties on `effectiveFrom` are broken by descending version string, which is
   * deterministic; two versions of one jurisdiction sharing an effective date is
   * a pack-authoring error rather than a runtime decision.
   */
  resolveEffective(code: string, at: Date): CountryPack | null {
    const versions = this.byCode.get(code);
    if (!versions) return null;
    let best: CountryPack | null = null;
    for (const pack of versions.values()) {
      if (pack.effectiveFrom.getTime() > at.getTime()) continue;
      if (
        best === null ||
        pack.effectiveFrom.getTime() > best.effectiveFrom.getTime() ||
        (pack.effectiveFrom.getTime() === best.effectiveFrom.getTime() &&
          pack.version > best.version)
      ) {
        best = pack;
      }
    }
    return best;
  }

  /** The exact version a historical transaction names. Never date-dependent. */
  resolveExact(code: string, version: string): CountryPack | null {
    return this.byCode.get(code)?.get(version) ?? null;
  }

  /**
   * Like {@link resolveEffective} but throwing, for call sites that must not
   * proceed without a pack.
   */
  requireEffective(code: string, at: Date): CountryPack {
    const pack = this.resolveEffective(code, at);
    if (!pack) {
      throw new CountryPackUnavailableError(
        `No activated country pack is in force for ${code} at ` +
          `${at.toISOString()}. A pack must be signed by an authorised release ` +
          'key and effective on or before the transaction time before it can be used.',
      );
    }
    return pack;
  }

  /** Diagnostic only: the activated `code -> versions` map. */
  describe(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [code, versions] of this.byCode) {
      out[code] = [...versions.keys()].sort();
    }
    return out;
  }

  get size(): number {
    let total = 0;
    for (const versions of this.byCode.values()) total += versions.size;
    return total;
  }
}

/** Re-exported so callers validating a version string share one bound. */
export { COUNTRY_PACK_VERSION_MAX_LENGTH };
