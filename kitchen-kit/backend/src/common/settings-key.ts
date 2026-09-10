/**
 * Settings-hierarchy key SYNTAX — the shared-kernel primitive P2A-R1 clause 2
 * assigns to `src/common/`.
 *
 * This is business-logic-free: it defines what a settings-hierarchy key
 * string LOOKS like, never which keys exist or what they mean. `platform-
 * settings` (the generic key/value store) and `localisation` (the Country
 * Pack CLOSED key vocabulary, `country-pack/country-pack.setting-keys.ts`)
 * both validate against this one pattern instead of each keeping its own
 * copy. Living here, outside `src/modules/`, keeps this file structurally
 * outside `module-boundaries.spec.ts`'s tracked module graph — the same
 * shared-kernel home as `Currency`/`RoundingMode`/`UUID_PATTERN` — so either
 * module may import it without creating a module-to-module edge.
 *
 * No NestJS imports, no HTTP exceptions, no domain logic: a syntax check
 * only. `platform-settings/settings-key.util.ts` is what turns a failed
 * check into an HTTP-shaped rejection; the Country Pack parser turns one into
 * a `CountryPackValidationError`. Neither behaviour belongs here.
 */

/**
 * `platform.setting_values.setting_key` / `platform_default_settings.setting_key`
 * are `VARCHAR(120)`. Lower-snake dotted segments (`payments.cash_rounding_policy`)
 * keep keys stable, greppable, and safe as a URL path segment without
 * encoding.
 */
export const SETTING_KEY_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export const SETTING_KEY_MAX_LENGTH = 120;

export function isValidSettingKeySyntax(key: string): boolean {
  return key.length <= SETTING_KEY_MAX_LENGTH && SETTING_KEY_PATTERN.test(key);
}
