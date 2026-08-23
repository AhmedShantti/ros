# Country Pack & Tax — source audit and open blockers

**Slice:** P1B — Country Pack runtime, tax engine, Sales capture unblock
**Date:** 2026-08-20
**Status of this document:** a record of what the authoritative sources decide,
what they do not, and what was consequently refused. It creates no governance
decision and changes none. D-1…D-20, P-1, PL, SB and the P0/P1A carried items
are untouched.

Authority order used throughout: SRS → ratified governance → approved design
(`ROS_DrawDB_Compatible_v3.sql`, ADRs) → executable repository state.

---

## 1. What the sources decide

| Question | Source | Answer |
|---|---|---|
| What is a Country Pack? | SRS §22.2 | A **signed, versioned configuration bundle**. Its content shape is given verbatim: `code`, `version`, `effectiveFrom`, `signature`, a `currency` block, a `tax` block (`engine`, `pricingMode`, `computationLevel`, `roundingMode`, `roundingPrecision`, `classes`, `serviceChargeTaxable`, `orderTypeOverrides`), plus invoice/fiscal/labour/calendar/legal blocks. |
| Where do country rules live? | CR-03, ADR-005, FR-LOC-020 | In pack **data**, plus a small **registered set** of strategy implementations. No jurisdiction branch may be compiled into core. |
| Versioning and history | FR-LOC-021 | Packs are versioned with effective dates; a historical transaction is interpreted under the version in force **at its transaction time**. |
| Pack registry table | Approved SQL | `fiscal.country_packs(code PK, name, version, signature BYTEA, is_active)` — a registry of which pack is live. It has **no payload column**; it does not hold pack content. |
| Which branch uses which pack | FR-BRN-002, FR-BRN-003, approved SQL | A branch holds a country-pack assignment, and two branches of one tenant in different countries use different packs. `org.branches` carries exactly one jurisdiction attribute, `country_code CHAR(2)`, and `fiscal.country_packs.code` is the primary key. Branch → jurisdiction → pack. |
| Tax engine selection | FR-LOC-025, SRS §22.2 sample | The pack names one of a **registered** set of strategies. `vat_standard` is the one the SRS names. |
| Pricing modes | FR-FIN-031 | Tax-inclusive and tax-exclusive, configurable per branch **and per price list**. |
| Tax classes | FR-FIN-033, §22.2 sample | standard / reduced / zero-rated / exempt, discriminated in DATA: `rate: 0.0` is zero-rated, `rate: null` is exempt. Order-type-dependent rates are required where a jurisdiction differentiates. |
| Order-type override storage | Approved SQL | `fiscal.tax_rules(country_pack_code, tax_class_id, rate, applies_to_order_type, effective_from, effective_to)` — a rate keyed by (class, order type, period). |
| Computation level | FR-FIN-034 | **Line level, then summed.** The rationale calls it non-negotiable. |
| Rounding | FR-FIN-035, BR-FIN-001/002 | Mode and point come from the pack; percentages are carried at full precision and rounded **exactly once**; the default mode is HALF_UP. |
| Business-day boundary | FR-FIN-024, approved SQL | Configurable per branch; stored as `org.operating_hours.business_day_cutover TIME` defaulting to `'00:00'`. |
| Conformance corpus | FR-OFF-050/051 | A language-neutral corpus executed by BOTH the Dart client and the TypeScript server in CI. Tax computation and rounding are explicitly in scope. |

---

## 2. What the sources do NOT decide

Each of these was left unimplemented or deliberately narrowed rather than
guessed. None is an oversight.

### 2.1 The signature's concrete cryptography — `NOT SOURCE-DECIDABLE`

FR-LOC-022 states the security property ("SHALL reject an unsigned or
invalidly-signed pack") and the approved SQL gives the storage
(`signature BYTEA`). Nothing anywhere selects:

- a signature algorithm (Ed25519 / RSA-PSS / ECDSA / …);
- a canonical byte representation of the pack document;
- a key encoding, key-id scheme, or rotation policy;
- a trust store for authorised release keys.

The repository's only crypto precedent for tokens is **HS256 — a symmetric
session secret**. It decides nothing here, and reading it as precedent would let
any deployment that can read its own configuration mint a pack that changes the
VAT rate on live sales.

**Implemented instead:** a `CountryPackSignatureVerifier` **port**, and an
activation gate that registers a pack only when a verifier attests it. The
default binding is `DenyAllCountryPackSignatureVerifier`, which refuses
everything. There is no always-true verifier anywhere in `src/`.

**Consequence, stated plainly:** with the shipped default no pack activates, so
no order can be opened. That is the correct reading of "SHALL reject an unsigned
pack" — the system refuses to price a sale rather than pricing one under an
unverified rate.

### 2.2 Multi-component base semantics — `PARTIAL`

FR-FIN-032 [M] mandates multiple simultaneous components "each with its own rate,
base, and rounding". Neither the SRS sample (one `rate` per class) nor the
approved SQL (`tax_rules.rate`, one rate per row) gives a storage grammar or any
compounding rule. Undefined: whether component B taxes component A, whether a fee
enters VAT's base, whether a service charge is inside or outside it.

**Implemented:** a component list where each component carries its own rate,
rounding mode and rounding precision, all combined on one exact denominator so
nothing rounds twice. `base` accepts **only** `line_net`; any other value is a
validation error naming this gap. No expression language was invented.

FR-FIN-032 is reported **PARTIAL**, not complete.

### 2.3 `order_lines.tax_class_id` UUID identity — `BLOCKER`

The column is `UUID NOT NULL`. A pack identifies a tax class by semantic **code**
(`standard`, `zero`, …). Bridging the two has no source:

- `fiscal.tax_classes(id, tenant_id, name, country_pack_code)` exists in the
  approved SQL, but has **no column binding a row to a pack class code**. `name`
  is a display name (`VARCHAR(64)`), and treating a localised display name as a
  semantic key would break the first time someone renames it.
- Populating that table needs a tenant-scoped authoring workflow the SRS never
  specifies, and inventing an administrative endpoint for it is out of scope.
- `catalogue.menu_items.tax_class_id` is **nullable and FK-less by ratified
  C-04** — "informational until Fiscal lands; never validated or resolved".

Refused, and deliberately so: hashing a code into a UUID, generating a random
one, widening the column to VARCHAR, or dropping NOT NULL. The tax engine
therefore works in semantic class codes internally, and the order-line writer
stays unexposed.

### 2.4 `order_lines.unit_cost_snapshot` — `GOVERNANCE-BLOCKED (D-17-05)`

FR-CST-001/002 define the value as the recipe's cost, recorded on the line and
never retroactively recomputed. **D-17-05 defers costing entirely**:
`production.recipe_versions.computed_cost` exists and is provably never written
(asserted by the Production E2E suite).

BR-MNU-012 permits selling an item with an **incomplete or absent** recipe at
zero or partial cost. It does **not** authorise zero cost for a complete recipe
whose cost merely has not been computed, and it is not being read that way here.

Reopening D-17-05 is a governance act, not an implementation one.

### 2.5 Per-branch / per-price-list pricing mode — `PARTIAL`

FR-FIN-031 requires the inclusive/exclusive choice to be configurable per branch
**and per price list**. The pack carries `tax.pricingMode`; neither
`org.branches` nor `catalogue.price_lists` has a column for an override, in this
repository or in the approved SQL.

The tax engine takes `pricingMode` as an **input** rather than reading ambient
configuration, so a branch- or list-level column feeds straight in once one
exists. The two override levels are unimplemented and reported as such.

### 2.6 POS session refresh semantics — known limitation

A PIN session's access token now carries `mid` (membership) and `emp`
(employee), without which no POS route could resolve a permission at all. The
membership is deliberately **not** persisted onto the session row: `refresh`
rebuilds a token from `session.membership_id` and does not carry the `pos`
audience forward, so storing it there would let a PIN session refresh itself into
a full dashboard session — exactly the escalation FR-SEC-021 forbids.

The consequence is that a POS session ends with its access token and the employee
re-enters their PIN. POS refresh semantics are not source-decided; a smaller
capability was chosen over an escalation path.

---

## 3. Requirements NOT claimed

| Requirement | Why not |
|---|---|
| FR-LOC-022 | Concrete cryptography unratified; only the fail-closed policy exists. |
| FR-LOC-023 | Conformance must cover tax, rounding, **invoice field completeness and QR generation**. The last two subsystems do not exist. |
| FR-LOC-024 | Offline distribution to terminals is out of this slice. |
| FR-LOC-031 | Depends on FR-LOC-023 and on release-key infrastructure. |
| FR-FIN-032 | Component base semantics undefined (§2.2). |
| FR-OFF-050 / FR-OFF-051 / BR-FIN-005 | The corpus runs in TypeScript only. No Dart consumer, no CI job running both. |
| BR-POS-004 | Two of five mandatory snapshots have no truthful producer (§2.3, §2.4). |

---

## 4. Routes deliberately not exposed

| Route | Reason |
|---|---|
| `POST /orders/{id}/lines` | §2.3 and §2.4 — two mandatory BR-POS-004 snapshots have no source. |
| `DELETE /orders/{id}/lines/{lineId}` | Nothing to delete while lines cannot be created. |
| `POST /orders/{id}/fire` | Firing has real KDS/ticket consequences; no kitchen context exists. A state flip would misrepresent production. |
| `POST /orders/{id}/complete` | BR-POS-002 gates COMPLETED on payment, and completion must also drive fiscal documents, inventory depletion, COGS and drawer attribution. None exist. |
| `POST /country-packs`, `/country-packs/{id}/activate`, `/tax/calculate` | No authoritative API contract defines them. FR-LOC-030's authoring tool is [S] and out of scope. Country Pack and tax are internal domain behaviour. |
