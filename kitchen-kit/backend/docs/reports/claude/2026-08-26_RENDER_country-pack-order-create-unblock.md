# Country Pack Runtime Provisioning — Render Order-Create Unblock

**Report type:** Implementation/verification report (operationalizes the existing, already-accepted Country Pack design — no redesign, no new capability)
**Authority statement:** This report is non-authoritative evidence. The SRS (`ROS_SRS_v1.0.pdf`, §22.2, FR-LOC-020/021/022, FR-FIN-030..035, FR-BRN-002/003) and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` (CARRIED ITEM P1C-3) remain the sole authority for requirements and architecture decisions. Nothing in this document creates, amends, or ratifies governance.
**Date:** 2026-08-26
**HEAD:** `18a155fed18795cf44bcd3ba46eb4efe344d7b68` (unchanged, no commit made this task)
**Branch:** `feat/production-spec` (confirmed via `git branch --show-current` before any work)
**Working tree summary:** see §H for the exact file list; no historical migration edited, no destructive git command run, no branch switch, no commit, no push
**Task identifier:** Country Pack runtime provisioning for Render — operationalize ONE signed, effective demo Country Pack through the existing implementation so `POST /orders` can succeed on the deployed backend. Explicitly excludes P1F-2/Completion/receipt/fiscal submission/new governance/production certification/key-management service.

---

## A. Starting state

- Branch confirmed `feat/production-spec` via `git branch --show-current` before any action.
- `git status --short` showed exactly one pre-existing local modification, made outside this task: `prisma.config.ts` (see §M — flagged, not touched).
- No `*.pack.json`, no trust manifest, and no private key material existed anywhere in the repository (tracked or untracked) before this task — confirmed by repo-wide `find`/`grep`.
- No destructive git command (`stash`/`reset`/`checkout`/`restore`/`clean`/`rebase`/force-push/`commit --amend`) was used at any point.
- No historical migration was edited. No branch switch. No commit. No push.

## B. Exact runtime blocker

Two related warnings, both fail-closed by design (P1C-3):

```
ConfiguredCountryPackTrustStore: "No country-pack trust manifest configured.
Every pack signature will be rejected and no order can be opened (FR-LOC-022)."

CountryPackService: "No country pack is active. Tax computation and order
capture will refuse to run until a signed, effective pack is activated."
```

Root cause: `COUNTRY_PACK_TRUST_MANIFEST` and `COUNTRY_PACK_DIR` are optional
environment variables (`src/config/env.validation.ts`) that were never set on
Render, so no release key is trusted and no pack file is loaded. This is the
intended fail-closed behavior, not a bug — the system is designed to refuse to
price a sale under an unverified rate rather than guess.

## C. Existing trust-manifest schema (verified from source, not inferred)

`src/modules/localisation/country-pack/country-pack.trust.provider.ts`
(`ConfiguredCountryPackTrustStore`): `COUNTRY_PACK_TRUST_MANIFEST` is a **file
path** (`readFileSync(path, 'utf8')` then `JSON.parse`), not inline JSON.
Resolved the same way Node resolves any relative `fs` path — against the
process's current working directory at runtime.

Exact shape, enforced by `parseTrustManifest` in
`country-pack.signature.ts:240-280`:

```json
{
  "keys": [
    {
      "keyId": "<non-empty string>",
      "algorithm": "Ed25519",
      "publicKey": "<raw 32-byte Ed25519 public key, base64url, no padding>",
      "status": "active" | "revoked"
    }
  ]
}
```

- `algorithm` must be the literal string `Ed25519` (v1's only supported value).
- `publicKey` must decode to exactly 32 raw bytes; decode is strict base64url
  (standard-base64 characters or padding are rejected).
- Any of `privateKey` / `secretKey` / `d` / `seed` present on a key entry
  throws immediately — the parser refuses a manifest carrying private material
  outright, by design.
- Any failure mode (unset variable, unreadable file, invalid JSON, malformed
  entry, unusable key bytes) yields an **empty** trust store — fail closed,
  never a partial/best-effort store.

## D. Existing CountryPack JSON parser/schema (verified from source, not inferred)

`src/modules/localisation/country-pack/country-pack.parser.ts` +
`country-pack.model.ts`. Required top-level fields:

| Field | Rule |
|---|---|
| `code` | `^[A-Z]{2,8}$` |
| `version` | `^[A-Za-z0-9][A-Za-z0-9._-]*$`, max 24 chars (`sales.orders.country_pack_version` is `VARCHAR(24)`) |
| `effectiveFrom` | strict `YYYY-MM-DD`, real calendar date, no roll-forward |
| `currency.code` / `currency.exponent` | ISO-4217-shaped code (3 letters) + integer exponent 0-4; **no currency whitelist** — any code/exponent pair `Currency.create` accepts is valid |
| `currency.cashRounding.enabled` | boolean; `stepMinorUnits` required (positive integer) only if `enabled: true` |
| `tax.engine` | must be one of the REGISTERED tax-engine ids — today exactly one: `vat_standard` (`tax-engine.registry.ts`) |
| `tax.pricingMode` | `tax_inclusive` \| `tax_exclusive` |
| `tax.computationLevel` | must be exactly `line` (FR-FIN-034) |
| `tax.roundingMode` | one of the `RoundingMode` enum values (`HALF_UP`, `HALF_DOWN`, `HALF_EVEN`, `UP`, `DOWN`) |
| `tax.roundingPrecision` | integer, `0 <= p <= currency.exponent` |
| `tax.classes[]` | non-empty; each has `code` (lower_snake_case) + either `rate` (string, exact-decimal, or `null` for exempt) or a non-empty `components[]` — never both, never neither |
| rate values | **must be JSON strings** (e.g. `"14.0"`), never JSON numbers — a number is a hard validation error, because IEEE-754 cannot represent every decimal rate exactly |
| `tax.orderTypeOverrides[]` | optional; each references an existing `classCode` |

**Signature envelope** is handled separately, not by `parseCountryPack` itself:
`readSignature`/`stripSignature` (`country-pack.signature.ts`) read/strip a
`signature: { algorithm, keyId, signature }` object at the pack document's top
level. `CountryPackRegistry.activate()` calls the structural parser first,
then verifies the signature, then registers — a malformed pack reports its
malformation, never a signature failure.

**Loader** (`country-pack.loader.ts`): `COUNTRY_PACK_DIR` is a directory path;
every file matching `*.pack.json` in it is loaded, **sorted by filename**, each
independently. One bad file is logged by name and skipped; the rest still
activate — a naming convention like `<CODE>-<VERSION>.pack.json` is a
readability convention only, not a structural requirement (the loader reads
`code`/`version` from the JSON body, not the filename).

## E. Demo branch country/currency — evidence, not assumption

Read directly from the existing, already-committed
`src/scripts/seed-dev-data.ts` (lines 107-183) — **not** inferred, **not**
defaulted to the SRS §22.2 Egypt example:

```ts
const tenant = await tenants.create({
  ...
  defaultCurrency: 'EGP',
  countryPackCode: 'EG',
});
...
const branch = await branches.create(tenant.id, owner.id, {
  ...
  baseCurrency: 'EGP',
  countryCode: 'EG',
});
```

The demo branch's jurisdiction is **EG / EGP**, an existing, already-committed
decision in the seed script — not something this task chose. It happens to
coincide with the SRS §22.2 worked example, which is a fortunate coincidence
that also makes the SRS's own sample tax data legitimately source-backed
content for this exact jurisdiction (see §F) — not a substitution of Egypt "by
default."

The seed script's own comments (lines 306-321) already anticipated this exact
gap: *"No country pack is activated ... `POST /orders` will fail with
`CountryPackUnavailableError` (422) ... Ask if you want a dev-only
pack-activation bootstrap added."*

## F. Pack-content source / authority

Content is the **SRS §22.2 sample data**, which is also byte-identical to the
existing test fixture `country-pack.fixture.ts`'s `makePackDocument()` (already
reviewed and relied upon across the parser/registry/tax test suites) and to
the shape `test/sales.e2e-spec.ts` signs and activates for its own e2e Fire/
Payment tests:

```json
{
  "code": "EG", "version": "2026.1", "effectiveFrom": "2026-01-01",
  "currency": { "code": "EGP", "exponent": 2, "symbolPosition": "suffix",
                "cashRounding": { "enabled": false } },
  "tax": {
    "engine": "vat_standard", "pricingMode": "tax_inclusive",
    "computationLevel": "line", "roundingMode": "HALF_UP", "roundingPrecision": 2,
    "classes": [
      { "code": "standard", "rate": "14.0", "label": { "en": "Standard" } },
      { "code": "reduced", "rate": "5.0" },
      { "code": "zero", "rate": "0.0" },
      { "code": "exempt", "rate": null }
    ],
    "serviceChargeTaxable": true, "orderTypeOverrides": []
  }
}
```

No jurisdiction tax rule was invented from general knowledge. `effectiveFrom`
(`2026-01-01`) is already in the past relative to today (2026-08-26), so the
pack is immediately "in force" per `CountryPackRegistry.resolveEffective`'s
rule (latest `effectiveFrom` not in the future).

## G. Signing workflow

**No signing capability was added to the Nest runtime.** A new, narrow,
framework-independent CLI tool — `src/scripts/sign-country-pack.ts` — performs
signing entirely outside the application:

- Reuses the exact production canonicalisation functions
  (`stripSignature`, `canonicalCountryPackBytes` from `country-pack.signature.ts`)
  so the bytes signed are byte-identical to what the verifier re-derives —
  there is no second canonicalisation implementation to drift from the
  ratified RFC-8785/JCS scheme.
- Reads a private key **only** from an explicit local file path argument;
  never generates, logs, or persists a key anywhere.
- Refuses to write its signed-pack output over the private-key input path.
- Two subcommands: `sign <unsigned.json> <key.pem> <keyId> <out.json>` and
  `trust-entry <key.pem> <keyId> [active|revoked]` (derives and prints the
  **public**-key trust-manifest entry only; writes nothing to disk).
- File header explicitly labels it "DEVELOPMENT/DEMO PROVISIONING ONLY... NOT
  a production Country Pack certification pipeline."

**Key generation** used plain `openssl genpkey -algorithm ed25519` (the
standard, auditable way to produce an Ed25519 PKCS8 key — no custom code
needed for this step), written to `secrets/country-pack/demo-signing-key.pem`.

**`.gitignore`** — appended (existing content preserved verbatim above the
addition):
```
# Country Pack signing key material — NEVER committed. Signing happens outside
# the application runtime (P1C-3); only the signed pack + public key artefacts
# under config/country-packs/ are deployable.
/secrets/
```
Verified via `git check-ignore -v secrets/country-pack/demo-signing-key.pem` →
matched by this new rule. Verified via `git status --porcelain --ignored` that
`secrets/` reports as ignored (`!!`), never as untracked-committable. Repo-wide
`grep`/`git grep` for `BEGIN PRIVATE KEY` across tracked **and** untracked (but
not git-ignored) files found nothing.

Commands actually run:
```
openssl genpkey -algorithm ed25519 -out secrets/country-pack/demo-signing-key.pem
npx ts-node -r tsconfig-paths/register src/scripts/sign-country-pack.ts \
  sign /tmp/EG-2026.1.unsigned.json secrets/country-pack/demo-signing-key.pem \
  ros-demo-2026 config/country-packs/EG-2026.1.pack.json
npx ts-node -r tsconfig-paths/register src/scripts/sign-country-pack.ts \
  trust-entry secrets/country-pack/demo-signing-key.pem ros-demo-2026 active
```

## H. Files changed (complete list)

New (untracked), all reviewed and content-scanned for private-key markers —
none found:
- `src/scripts/sign-country-pack.ts` — the offline signing CLI (no Nest, no DB, no HTTP; not wired into any module).
- `config/country-packs/EG-2026.1.pack.json` — the signed demo pack. SHA-256 `6d0e15549382a33732dddfd365b2a4accf14c12aaa957ce784deff77c095c787`.
- `config/country-packs/trust-manifest.json` — the public-key-only trust manifest. SHA-256 `df7e4ca16cba899ac65ea4b87fc841a13df58e995aab2cc128eadafdca794436`.
- `src/modules/localisation/country-pack/country-pack.deployment-artifacts.spec.ts` — proves the exact committed files above activate through the real production pipeline.
- `src/modules/localisation/country-pack/country-pack.service.spec.ts` — new focused coverage for `CountryPackService.requireEffectiveFor` (branch country/currency resolution and mismatch refusal) — a pure method with no prior spec.

Modified:
- `.gitignore` — one appended block (`/secrets/`), existing content untouched.

**Not part of this task's deliverable, pre-existing, left untouched:**
- `prisma.config.ts` — was already locally modified (uncommitted) before this task started; see §M.

Nothing under `src/modules/**` business logic was changed. No controller, no
new HTTP route, no DI wiring change to `LocalisationModule`. No historical
migration touched. `secrets/` is never committed (see §G).

## I. TaxClass provisioning status

Read `src/modules/identity/tenants/tenants.service.ts` (`TenantsService.create`)
and `src/modules/localisation/tax/tax-class.provisioner.ts` directly.

**Confirmed mechanism:** `TenantsService.create` calls
`TaxClassProvisioningService.provisionForTenant(tenant.id, tenant.countryPackCode)`
**immediately after** creating the tenant row, best-effort (a provisioning
failure is logged, not thrown — the tenant is still created). That method
calls `registry.resolveEffective(countryPackCode, new Date())` — if the pack
is not active **at that exact moment**, **zero** tax classes are provisioned,
permanently, for that tenant; there is no automatic retry and no re-trigger
elsewhere in the codebase. `ensureFromPack` (`tax-class.service.ts`) is
idempotent per `(tenant_id, country_pack_code, code)` and never rewrites an
existing row's id/code — safe to invoke multiple times, but nothing currently
invokes it again after tenant creation.

**Consequence for the existing demo path:** `seed-dev-data.ts` creates a
**brand-new, timestamp-suffixed tenant on every run** (by explicit design —
its own comment: *"Safe to re-run ... each run creates a fresh, independent
tenant"*). This sidesteps any retrofit question entirely: **there is no
"existing demo tenant" that predates the pack** unless the seed script was
already run against Render before this task. This session has no visibility
into Render's database and cannot confirm or rule that out.

- **If no demo tenant exists yet on Render:** set the two env vars (§K),
  redeploy, then run `node dist/scripts/seed-dev-data.js` once. Its
  `TenantsService.create` call will find the now-active EG pack via
  `resolveEffective` and provision `standard`/`reduced`/`zero`/`exempt` tax
  classes automatically — no extra step, no new script.
- **If a stale pre-pack tenant already exists** (from an earlier run before
  the pack existed): per this task's explicit instruction to prefer an
  existing mechanism over inventing a production admin API, the correct fix is
  to **re-run `seed-dev-data.ts` again** — it produces an entirely new,
  correctly-provisioned tenant/branch/menu item, rather than requiring any
  retrofit of the old one. The old tenant is simply not the one used for the
  demo going forward.

No production admin API was invented. No tax-class UUID was fabricated.

## J. Verification evidence

All commands were run locally; **the persistent local dev database
(`ros`, `ros-postgres` container) was never migrated or written to.** A
disposable scratch database (`ros_country_pack_smoke_scratch`) was created on
the same container, migrated, exercised, and dropped.

1. **New unit specs** (localisation module, no DB):
   ```
   npx jest src/modules/localisation --silent
   Test Suites: 7 passed, 7 total
   Tests:       160 passed, 160 total
   ```
   Includes the two new spec files (9 new tests total) covering: trust
   manifest parse of the real committed manifest; genuine signature accepted
   for the real committed pack; effective-date resolution (today → resolves,
   2025 → null); tampered-payload rejection; unknown-key rejection (empty
   trust store); revoked-key rejection; branch country+currency match
   resolves; branch currency mismatch refused (`CountryPackUnavailableError`);
   branch with no activated pack for its country refused.

2. **Scratch-DB e2e verification** (`ros_country_pack_smoke_scratch`, dropped
   after use):
   - `prisma migrate deploy` — all 27 migrations applied cleanly.
   - `sales.e2e-spec.ts` — **56/56 passing**, including the existing
     production-verifier + ephemeral-key `POST /orders` flow (order creation
     end-to-end with an activated EG/EGP pack — the equivalent smoke test
     already exists here and passes unmodified).
   - `tax-class-rls.e2e-spec.ts`, `sales-lines.e2e-spec.ts`,
     `catalogue.e2e-spec.ts` — **122/122 passing**.
   - No existing negative test was weakened; all continue to assert rejection.

3. **`npm run build`** (`nest build`) — succeeded, no errors.
4. **`npx tsc --noEmit`** — exactly one pre-existing baseline error, unrelated
   to this task (`access-token.service.spec.ts:28`, a pre-existing type
   mismatch predating this session — matches prior reports' documented
   baseline).
5. **`eslint`** on both new source files — clean (0 errors after two rounds of
   fixes: Prettier formatting and one `no-unsafe-return`/`require-await` each).
6. **`git diff --check`** — clean, no whitespace errors.

## K. Exact Render environment variables / paths

Assuming Render's service root directory is `kitchen-kit/backend` (consistent
with the prior Render task, where `DATABASE_URL`/`APP_DATABASE_URL` already
resolved correctly from that root) — `node dist/main` runs with that directory
as its working directory, and both env vars are read as plain `fs` paths
relative to it:

```
COUNTRY_PACK_DIR=config/country-packs
COUNTRY_PACK_TRUST_MANIFEST=config/country-packs/trust-manifest.json
```

Both values are relative paths into files **already present in this repo**
(`config/country-packs/EG-2026.1.pack.json`,
`config/country-packs/trust-manifest.json`) — nothing else needs to be
uploaded to Render; they ship with the git-built image once this branch is
pushed. No private key material is referenced by either variable or exists
anywhere these paths point to.

**Render must be redeployed** after setting these two variables — they are
read once, in `CountryPackLoader.onModuleInit()` and
`ConfiguredCountryPackTrustStore`'s constructor, at process boot. Setting them
without a restart/redeploy has no effect on an already-running process.

## L. Order-create smoke-test procedure (post-deploy, on Render)

1. Set the two variables above in Render's environment settings.
2. Trigger a redeploy (or restart if Render doesn't require a full rebuild for
   env-var-only changes — confirm in Render's own docs for this service type).
3. Check startup logs for:
   - Absence of `"No country-pack trust manifest configured"`.
   - Presence of `"Country-pack trust manifest loaded: 1 release key(s), 1 active."` (from `ConfiguredCountryPackTrustStore`).
   - Presence of `"Activated country pack EG-2026.1."` (from `CountryPackLoader`).
   - Presence of `"Active country packs: {\"EG\":[\"2026.1\"]}"` (from `CountryPackService.logActivationSummary`), **not** the "No country pack is active" warning.
4. `GET /health` (or whatever the existing health route is) still returns healthy.
5. Existing PIN/operator auth flow (`POST /auth/pin`, `POST /auth/login` +
   `POST /auth/tenant`) still authenticates — unaffected by this change.
6. Run (or re-run) `node dist/scripts/seed-dev-data.js` against the Render
   database to get/refresh a demo tenant + branch + menu item, using the
   credentials it writes to `credentials.md` (not committed).
7. `POST /orders` for the seeded branch should now proceed past
   `CountryPackUnavailableError` into normal order creation.
8. Confirm the created order's `country_pack_version` column is pinned to
   `2026.1`.
9. Add a taxable line (the seeded "Classic Burger" item, `standard` tax class)
   and confirm a non-zero VAT breakdown is computed (14% inclusive on 250.00 EGP).

## M. Residual blockers — reported, not papered over

1. **`prisma.config.ts` is currently, locally, modified (uncommitted) to read
   `APP_DATABASE_URL` (the `ros_app` runtime role) instead of `DATABASE_URL`
   (the `ros_migrator` owner role) for Prisma CLI operations.** This predates
   this task and was not made by it. It actively broke this session's first
   attempt to `prisma migrate deploy` against a scratch database (`permission
   denied for table _prisma_migrations`, because `ros_app` has no DDL rights —
   architecturally correct, since `ros_app` is deliberately the
   RLS-constrained, non-superuser runtime role everywhere else in this
   codebase). This change is **not committed** and was **not pushed**, so it
   has not affected Render. If it were ever committed and pushed, it would
   break `prisma migrate deploy` on Render the same way it broke it here. This
   was worked around locally (an env-var override) for this task's own
   verification only, without editing the file, since fixing it was outside
   this task's scope. **Recommend the user review and likely revert this
   change before it is committed.**
2. **Whether a stale, pre-pack demo tenant already exists on Render** could
   not be determined from this session (no Render database access). §I gives
   the resolution either way: none needed if no tenant exists yet; re-run the
   existing seed script if one does.
3. Nothing else was found to block order creation once the pack is active —
   RBAC, menu pricing, and cash-session paths were not touched or found broken
   by this change; they were exercised unmodified by the e2e suites in §J.2.

## N. Requirement classification

- FR-LOC-020/021/022 (Country Pack existence, versioning/effective dates,
  signed integrity): unchanged design; this task provisions one conforming
  instance. Still **NOT** claiming FR-LOC-023/031 (full conformance
  certification) — unchanged from all prior reports.
- FR-FIN-030..035 (pricing mode, line-level computation, per-component
  rate/base/rounding, rounding point): satisfied by the pack content exactly
  as already implemented and tested; no engine/parser change.
- FR-BRN-002/003 (branch jurisdiction/pack assignment, per-branch packs within
  one tenant): unchanged; newly covered by an explicit unit test (§I above had
  no direct coverage before this task).
- CARRIED ITEM P1C-3 (Ed25519/JCS signing, public-key-only trust, no runtime
  signing capability): preserved exactly; no weakening, no new signing surface
  in the application.

## O. Final verdict

**READY TO CONFIGURE RENDER**
