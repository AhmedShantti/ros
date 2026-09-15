-- CASH-SESSION-RESUME-AND-CLOSE-P0
--
-- `uq_one_open_session_per_drawer` (20260820160000_shift_drawer_cash_session_open)
-- scoped FR-FIN-001's "one open cash session per drawer at any time" to
-- `WHERE status = 'open'`. That was correct THEN: `closing` did not exist as
-- a CashSession status until 20260830020000_treasury_cashsession_close added
-- it (the above-tolerance freeze between `declareClose` and `finalizeClose`,
-- P1G-1/FR-FIN-006) — and that later migration never revisited this index.
--
-- The gap: a session in `closing` has NOT been closed. It is frozen awaiting
-- a manager's decision, `finalizeClose` can reject it and leave it right back
-- in `closing` for a retry (R-6(a)), and the drawer's cash is still
-- uncounted-out of that session's custody. `CashSessionsService.open`'s own
-- 409 message already says "close the existing session first" — a session
-- that is merely `closing` has not done that. With the old index, a second
-- `POST /cash-sessions` on the SAME drawer while the first session sat in
-- `closing` was NOT rejected: two cash sessions could simultaneously claim
-- custody of one physical drawer.
--
-- Widened to `WHERE status IN ('open', 'closing')`: a drawer stays occupied
-- until its session actually reaches `closed`, matching what the 409 message
-- already told callers. Still a PARTIAL index (not `UNIQUE(drawer_id,
-- status)`), for the same reason as before: an unrestricted composite would
-- permit only one CLOSED row per drawer for the life of the system.
DROP INDEX "treasury"."uq_one_open_session_per_drawer";

CREATE UNIQUE INDEX "uq_one_active_session_per_drawer"
  ON "treasury"."cash_sessions"("drawer_id")
  WHERE "status" IN ('open', 'closing');
