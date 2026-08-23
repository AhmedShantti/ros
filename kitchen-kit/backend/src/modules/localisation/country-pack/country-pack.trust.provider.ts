/**
 * Trusted release-key configuration adapter.
 *
 * ENGINEERING IMPLEMENTATION CHOICE, not a product decision. Carried item P1C-3
 * ratified the signing scheme and the trust MODEL — public keys only, an
 * `active | revoked` lifecycle, historical keys retained — and left storage
 * mechanics to follow existing secure-configuration convention. This repository
 * already loads deployment-supplied artefacts from a path named by an optional
 * environment variable (`COUNTRY_PACK_DIR`), so the trust manifest does the same.
 *
 * Manifest shape:
 *
 *   {
 *     "keys": [
 *       {
 *         "keyId":     "ros-release-2026",
 *         "algorithm": "Ed25519",
 *         "publicKey": "<raw 32-byte Ed25519 public key, base64url>",
 *         "status":    "active"
 *       }
 *     ]
 *   }
 *
 * PUBLIC KEYS ONLY. `parseTrustManifest` refuses a manifest carrying anything
 * that looks like private key material, and no signing function exists anywhere
 * in this runtime to use one with.
 *
 * FAIL CLOSED, in every failure mode: unset variable, unreadable file, invalid
 * JSON, malformed entry, unusable key bytes. Each yields an EMPTY trust store,
 * which makes every signature verification return false, which means no pack
 * activates and no sale is priced. A misconfigured deployment refuses to trade;
 * it never trades under an unverified rate.
 */

import { readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CountryPackTrustStore,
  InMemoryCountryPackTrustStore,
  TrustedReleaseKey,
  parseTrustManifest,
} from './country-pack.signature';

@Injectable()
export class ConfiguredCountryPackTrustStore implements CountryPackTrustStore {
  private readonly logger = new Logger(ConfiguredCountryPackTrustStore.name);
  private readonly delegate: CountryPackTrustStore;

  constructor(config: ConfigService) {
    this.delegate = new InMemoryCountryPackTrustStore(this.load(config));
  }

  private load(config: ConfigService): TrustedReleaseKey[] {
    const path = config.get<string>('COUNTRY_PACK_TRUST_MANIFEST')?.trim();
    if (!path) {
      this.logger.warn(
        'No country-pack trust manifest configured. Every pack signature will ' +
          'be rejected and no order can be opened (FR-LOC-022).',
      );
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Never log the path or the parser error: both are configuration detail.
      this.logger.error(
        'The country-pack trust manifest could not be read as JSON. No release ' +
          'key is trusted.',
      );
      return [];
    }
    try {
      const keys = parseTrustManifest(raw);
      const active = keys.filter((k) => k.status === 'active').length;
      this.logger.log(
        `Country-pack trust manifest loaded: ${keys.length} release key(s), ` +
          `${active} active.`,
      );
      return keys;
    } catch (error) {
      this.logger.error(
        `The country-pack trust manifest is malformed: ${(error as Error).message} ` +
          'No release key is trusted.',
      );
      return [];
    }
  }

  find(keyId: string): TrustedReleaseKey | null {
    return this.delegate.find(keyId);
  }

  get size(): number {
    return this.delegate.size;
  }
}
