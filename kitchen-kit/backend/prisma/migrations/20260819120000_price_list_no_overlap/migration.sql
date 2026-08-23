-- ---------------------------------------------------------------------------
-- SRS §7.3 aggregate #10 — PriceList
--   Contained entities: PriceEntries, ValidityWindow
--   Key invariant:      "No overlapping windows of same priority for same scope"
--
-- Until now that invariant had no enforcement at any layer: two price lists on
-- the same scope with the same priority and overlapping validity could both be
-- created, producing exactly the ambiguous state the resolver has to refuse to
-- resolve. This migration makes the invalid state unrepresentable.
--
-- WHY A DATABASE CONSTRAINT RATHER THAN A SERVICE CHECK
-- An application "does an overlap already exist?" pre-check is not concurrency
-- safe: two simultaneous writers can both observe no conflict and both commit.
-- An exclusion constraint is evaluated by the index, so the second writer fails
-- deterministically no matter the interleaving. The service keeps a friendly
-- pre-check for a clear 409; this constraint is the actual guarantee.
--
-- KEY COMPOSITION — and one documented reading of the SRS
--   tenant_id   : tenant isolation. Because it leads the key, two rows from
--                 different tenants can NEVER conflict, so the constraint can
--                 never leak the existence of another tenant's price list.
--   scope_type  : tenant | brand | branch (branch_group is deferred, ADR 0008 D-10).
--   scope_id    : the actual target. Branch X and Branch Y are DIFFERENT scopes
--                 even though both are `branch`. NULL (tenant scope) is folded
--                 to the nil UUID because a NULL key column would otherwise make
--                 the exclusion constraint skip the row entirely — two
--                 tenant-scope lists would then never conflict, which is the
--                 opposite of the invariant.
--   order_type  : DELIBERATELY NOT IN THE KEY. FR-MNU-020 enumerates scope as
--                 tenant | brand | branch | branch group; `order_type` is a
--                 separate concern introduced by FR-MNU-021, and the approved SQL
--                 likewise carries it as its own column. No SRS text, ADR, design
--                 gate or ratified governance decision makes order type part of
--                 "scope" — verified by exhaustive search. Adding it would narrow
--                 the invariant so that a dine-in list and a delivery list could
--                 share a scope, priority and window; the SRS forbids that, and
--                 FR-MNU-021 nowhere requires two order-type-specific lists to
--                 carry the SAME priority. Distinct priorities satisfy both
--                 requirements. A repository default (`priority` defaults to 0)
--                 is not a requirement and must not reshape the invariant.
--   priority    : the invariant's own discriminator.
--   window      : tstzrange(valid_from, valid_to) with `&&`. NULL endpoints
--                 become unbounded, which is the correct meaning of an open
--                 window. The range is half-open [from, to), so two adjacent
--                 windows that merely touch at an instant do NOT overlap — the
--                 SRS does not state boundary semantics, so this matches the
--                 half-open convention already documented in the resolver.
--
-- `recurrence_rule` is deliberately NOT part of the key. Its grammar is
-- undefined by the SRS, governance and this repository, so it cannot be
-- evaluated; folding an unparseable value into an overlap test would be
-- inventing semantics. Recurrence-bearing lists remain undeterminable at
-- resolution time, exactly as before.
--
-- `status` is likewise not part of the key: §7.3 #10 conditions the invariant on
-- scope, priority and window only.
-- ---------------------------------------------------------------------------

-- Required for the `=` operators on uuid / enum / smallint inside a GiST index.
-- btree_gist is a standard PostgreSQL contrib extension, present in the project's
-- postgres:16 image (verified: available 1.7 on PostgreSQL 16.15).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ExclusionConstraint
ALTER TABLE "catalogue"."price_lists"
  ADD CONSTRAINT "ex_price_list_no_overlap"
  EXCLUDE USING gist (
    "tenant_id" WITH =,
    "scope_type" WITH =,
    COALESCE("scope_id", '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    "priority" WITH =,
    tstzrange("valid_from", "valid_to") WITH &&
  );

COMMENT ON CONSTRAINT "ex_price_list_no_overlap" ON "catalogue"."price_lists" IS
  'SRS 7.3 #10: no overlapping validity windows of the same priority for the same scope.';
