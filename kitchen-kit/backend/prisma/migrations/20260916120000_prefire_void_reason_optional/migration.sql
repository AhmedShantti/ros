-- PREFIRE-VOID-NO-REASON-P0 — a pre-fire void no longer carries a reason
-- (see docs/governance/GOVERNANCE_DECISION_REGISTER.md, the "Pre-Fire Void
-- Reason Removed" entry: a ratified, narrow exception to FR-POS-075 for
-- this one operation only). A POST-fire void MUST still carry one —
-- unchanged.
--
-- `ck_order_line_void_reason` could not previously tell the two apart (both
-- transition `state` to 'voided'); it is replaced with an equivalent check
-- that additionally accepts a null `void_reason_id` when `fired_at IS
-- NULL` — which `ck_order_line_fired_at` (unchanged, same migration that
-- created this table) already guarantees is true for every pre-fire void
-- and false for every post-fire void, so this remains real DB-level
-- enforcement, not a blanket relaxation: a voided line that WAS fired still
-- requires a reason.
ALTER TABLE "sales"."order_lines" DROP CONSTRAINT "ck_order_line_void_reason";
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "ck_order_line_void_reason" CHECK ("state" <> 'voided' OR "void_reason_id" IS NOT NULL OR "fired_at" IS NULL);
