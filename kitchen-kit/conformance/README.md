# Shared conformance corpus

Language-neutral test data for the logic that **must** produce identical results
on the Dart POS client and the TypeScript server.

- `FR-OFF-050 [M]` — "Business logic that must produce identical results on
  client and server SHALL be specified as a language-neutral test corpus,
  executed by both the Dart client test suite and the TypeScript server test
  suite in CI."
- `FR-OFF-051 [M]` — any divergence on the corpus blocks release.
- `BR-FIN-005` — client and server SHALL produce byte-identical monetary results.

The corpus lives **outside** `backend/` deliberately: it belongs to neither
runtime, and a corpus owned by one of them stops being a neutral referee.

## Current status

| Consumer | State |
|---|---|
| TypeScript server | **Running** — `backend/src/modules/localisation/tax/conformance.spec.ts` |
| Dart client | **Absent** — no Flutter client exists in this repository yet |
| CI executing both | **Absent** |

FR-OFF-050 and FR-OFF-051 are therefore **PARTIAL**. The server matching the
corpus proves the server is self-consistent and deterministic; it does not prove
client/server agreement, and this file exists partly so that distinction is not
quietly lost.

## Scope

SRS §21.9 lists the full corpus scope: price resolution, modifier price
computation, discount application and distribution, promotion evaluation, tax
computation and rounding, service charge, cash rounding, loyalty accrual, and
recipe expansion to base ingredients.

Only **tax computation and rounding** are covered so far — `tax/`. The other
areas get directories when the logic they describe exists; an empty directory
would claim coverage that is not there.

## Encoding rules

These are what make a case reproducible in a second language:

1. **Every monetary amount, quantity and rate is a decimal STRING.** A JSON
   number is IEEE-754. It cannot carry an amount above 2^53, and it cannot carry
   every rate exactly. A corpus encoded in floats would itself become a source of
   the divergence it exists to detect.
2. **Money is in minor units.** `"12000"` is EGP 120.00. The currency's exponent
   comes from the pack, never from the reader's assumption that it is 2.
3. **The only JSON numbers permitted** are structural integers that cannot lose
   precision: `exponent`, `roundingPrecision`, `cashRounding.stepMinorUnits`. The
   TypeScript runner asserts this over the raw file, so a float cannot creep in.
4. **`corpusVersion` is a string**, for the same reason.
5. **Jurisdiction codes are DATA.** `EG` appears in a pack document because a
   pack has a code; no implementation may branch on it (CR-03, ADR-005), and the
   server suite has a static test proving the tax engine contains no such branch.

## Case shape

```jsonc
{
  "corpusVersion": "1",
  "cases": [
    {
      "id": "tax-inclusive-standard-001",
      "description": "why this case exists",
      "pack": { /* a full SRS §22.2 country pack document */ },
      "lines": [
        {
          "unitPrice": "12000",
          "quantity": "1",
          "taxClass": "standard",
          "orderType": null
        }
      ],
      "expected": {
        "lines": [
          {
            "net": "10526",
            "tax": "1474",
            "gross": "12000",
            "exempt": false,
            "zeroRated": false,
            "components": [
              { "code": "standard", "ratePercent": "14.0", "amount": "1474" }
            ]
          }
        ],
        "taxTotal": "1474"
      }
    }
  ]
}
```

`exempt` and `zeroRated` are both present on every expectation because
FR-FIN-033 treats them as different classes: a zero-rated supply is inside the
scope of the tax at 0%, an exempt supply is outside it. Both yield zero money, so
the amount alone cannot tell them apart — the flags can.

## Adding a case

FR-OFF-052 requires a new case whenever a production discrepancy reveals a logic
divergence, **before** the fix merges. Add it to the matching file, give it an id
that says what it covers, and run:

```
cd backend && npx jest src/modules/localisation/tax/conformance.spec.ts
```

Expectations are hand-derived from the requirement, never pasted from an
implementation's output — a corpus that records what the code does cannot detect
what the code gets wrong.
