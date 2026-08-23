-- P1E-5 — BR-POS-004 sale-time snapshot of `catalogue.modifiers.kind`
-- (FR-POS-021). Nullable for the identical reason the source column is
-- nullable: a line captured against a legacy, unclassified Modifier
-- snapshots that same unknown-ness rather than inventing a value.
--
-- No additive unique index is required on `sales.order_line_modifiers` for
-- P1E-5's Kitchen FK (`kitchen.ticket_line_modifiers.source_order_line_
-- modifier_id`): `order_line_modifiers_tenant_id_id_key` — `UNIQUE
-- (tenant_id, id)` — already exists (added when this table was first
-- created) and is exactly the D-09 composite target Kitchen needs.
-- ============================================================================

ALTER TABLE "sales"."order_line_modifiers"
  ADD COLUMN "kind_snapshot" "catalogue"."ModifierKind";
