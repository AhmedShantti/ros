/**
 * Country Pack loader — reads signed pack bundles from the directory named by
 * `COUNTRY_PACK_DIR` and offers each one to the registry's activation gate.
 *
 * Packs are FILE artefacts rather than rows because that is what the SRS
 * describes: FR-LOC-024 requires packs to be "distributed to offline terminals
 * in advance of their effective date", and a bundle is what one distributes.
 * The approved SQL's `fiscal.country_packs` (code, name, version, signature,
 * is_active) is a server-side REGISTRY of which pack is live, not the pack's
 * content — it has no payload column at all — and no consumer of that registry
 * exists in this slice, so no table is created for it here.
 *
 * The variable is OPTIONAL and unset by default. An unconfigured deployment
 * activates nothing, which — combined with the deny-all verifier — means the
 * system refuses to price sales rather than pricing them wrongly.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CountryPackService } from './country-pack.service';

const PACK_FILE_SUFFIX = '.pack.json';

@Injectable()
export class CountryPackLoader implements OnModuleInit {
  private readonly logger = new Logger(CountryPackLoader.name);

  constructor(
    private readonly config: ConfigService,
    private readonly packs: CountryPackService,
  ) {}

  async onModuleInit(): Promise<void> {
    const dir = this.config.get<string>('COUNTRY_PACK_DIR')?.trim();
    if (!dir) {
      this.packs.logActivationSummary();
      return;
    }
    await this.loadFrom(dir);
    this.packs.logActivationSummary();
  }

  /**
   * Load every `*.pack.json` in `dir`.
   *
   * One bad file never stops the others: an unreadable, malformed or
   * unverifiable pack is logged by NAME and skipped, and the rest still
   * activate. The failure message never carries the file's contents or the
   * underlying crypto error, both of which could disclose key material.
   */
  async loadFrom(dir: string): Promise<void> {
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) {
        this.logger.error(
          'COUNTRY_PACK_DIR is not a directory; no pack loaded.',
        );
        return;
      }
      entries = readdirSync(dir);
    } catch {
      this.logger.error('COUNTRY_PACK_DIR could not be read; no pack loaded.');
      return;
    }

    for (const entry of entries
      .filter((e) => e.endsWith(PACK_FILE_SUFFIX))
      .sort()) {
      let document: unknown;
      try {
        document = JSON.parse(readFileSync(join(dir, entry), 'utf8'));
      } catch {
        this.logger.error(
          `Country pack ${entry} is not readable JSON; skipped.`,
        );
        continue;
      }
      try {
        const pack = await this.packs.activate(document);
        this.logger.log(`Activated country pack ${pack.code}-${pack.version}.`);
      } catch (error) {
        this.logger.error(
          `Country pack ${entry} was rejected: ${(error as Error).message}`,
        );
      }
    }
  }
}
