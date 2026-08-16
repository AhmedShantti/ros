# Organisation — domain model

Field-level specification: see `PHASE_15_DISCOVERY_REPORT.md` §6, which this
implementation follows exactly. Notable points:

## Immutability

- `branches.code` is **immutable after creation**. FR-POS-002 embeds
  `<branch_code>` in offline-generated order numbers, so changing it would make
  historical human-readable identifiers ambiguous. `UpdateBranchDto` has no
  `code` field, so an attempt is a 400.
- `tenant_id` is immutable everywhere (FR-PLT-003) and is never accepted from a
  client.

## Branch lifecycle

`status` is `active | inactive` (D-03) — an **availability flag, not a state
machine**. The SRS defines no branch lifecycle; no transition graph, guard or
side effect is implemented. Changing it is an explicit `POST
/org/branches/:id/status`, not a PATCH field.

## Operating hours

- `day_of_week` is **0 = Sunday … 6 = Saturday** (D-04), aligned with PostgreSQL
  `EXTRACT(DOW)`, with a DB `CHECK (day_of_week BETWEEN 0 AND 6)`.
- **Overnight is SRS-mandated**, not inferred: the glossary defines the business
  day as "an operational day, which may not align with the calendar day. A branch
  closing at 03:00 attributes those sales to the previous business day." So
  `closes_at <= opens_at` denotes an interval crossing midnight.
- **Split shifts are allowed** (multiple intervals per weekday — the approved SQL
  deliberately carries no unique constraint); **overlapping intervals are
  rejected with 400**.
- Whether an overnight interval conflicts with the *next* day's morning interval
  is **not defined by the SRS**; the check is scoped to one weekday and no policy
  is invented.

## Warehouse

`warehouse_type` is an enum (`branch | central | virtual`) with values taken
verbatim from the approved SQL comment (D-17). **No CHECK correlates it with
`branch_id`** — no source states such a rule. Two open items are recorded for
Inventory: the meaning of each `warehouse_type`/`branch_id` combination, and the
fact that a single nullable `branch_id` cannot express BR-PLT-001's
two-branches-share-one-warehouse model.
