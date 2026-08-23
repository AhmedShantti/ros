-- P1E-5 — FR-POS-021 [M] semantic modifier kind (addition | removal |
-- substitution). `catalogue.modifiers` has carried no such column until now.
--
-- SAFE MIGRATION STRATEGY (P1E-5 acceptance correction — do not backfill by
-- heuristic): the 18 pre-existing `catalogue.modifiers` rows in this
-- environment carry NO non-heuristic source of truth for their kind. The
-- only candidate signals — price sign, name text, group name, recipe_delta —
-- are each explicitly rejected as backfill evidence (recorded in the P1E-5
-- report §C): FR-POS-021 itself states a removal may be "0 or − delta" and a
-- substitution "± delta", so price sign does not distinguish; name text
-- ("Chicken instead of Beef") is a human-language heuristic, not a source
-- fact, and is rejected even where it looks obvious; recipe_delta is
-- nullable and, per the column's own repository comment, not interpreted by
-- anything in this phase.
--
-- `kind` is therefore added NULLABLE, with NO backfill and NO default. Every
-- one of the 18 existing rows keeps `kind IS NULL` — a true, honest
-- "unknown", not a fabricated "addition". `ModifierGroupsService.addModifier`
-- (application layer, this same slice) requires a `kind` argument for every
-- NEW modifier from this point forward; the database does not enforce
-- NOT NULL because doing so would also reject legacy rows on any future
-- unrelated UPDATE that does not touch this column.
-- ============================================================================

CREATE TYPE "catalogue"."ModifierKind" AS ENUM ('addition', 'removal', 'substitution');

ALTER TABLE "catalogue"."modifiers" ADD COLUMN "kind" "catalogue"."ModifierKind";
