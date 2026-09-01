import type { PermissionDef } from '../identity/contract';

/**
 * KDS-R11 (ratified 2026-08-30, `docs/governance/GOVERNANCE_DECISION_REGISTER.md`
 * "KDS MVP Operator Lifecycle Ratification — 2026-08-30").
 *
 * SRS §15.2 contains no `kds.*` code, and §15.2's designated authority for
 * the full catalogue — Appendix C — is absent from the delivered document
 * (exhaustively verified, see the design gate report §7.1). §15.3 requires
 * Kitchen Staff to be "KDS only" and ACT-09/FR-KDS-024/025 require an
 * executable bump/recall surface, so — unlike every other module's
 * permission file — a code could not be deferred here. `kds.operate` is the
 * THIRD explicit user-authorized exception to the zero-invented-codes
 * discipline, alongside `pos.order.fire` and `pos.payment.capture`
 * (`sales.permissions.ts`).
 *
 * ONE coarse code, deliberately. It authorizes: station queue read,
 * first-viewed acknowledgement, item start, bump item, bump all, and ticket
 * recall. KDS-R11 is explicit that station-level scope is NOT carried by
 * this code — it is enforced by the terminal-to-station binding
 * (`KdsStationGuard`) — and that recall is not split into a separate code
 * (UC-KDS-01 alternate flow 4a assigns recall to "staff", not a supervisor).
 *
 * MUST NOT be split into `kds.view` / `kds.ticket.*` / `kds.expedite` variants
 * — KDS-R11 names these explicitly as NOT authorized. A future Expediter
 * (FR-KDS-013 `[S]`) slice may introduce `kds.expedite`; it does not reopen
 * this ratification.
 *
 * No standard-role seeding is performed by this file or by any code seeded
 * from it (KDS-R11 §4.3: recorded as future intent for Kitchen Staff, Head
 * Chef, Branch Manager, Shift Supervisor, Owner — not implemented here).
 */
export const KDS_PERMISSIONS = {
  OPERATE: 'kds.operate',
} as const;

export const KDS_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: KDS_PERMISSIONS.OPERATE,
    module: 'kds',
    description: 'Operate a kitchen display station',
  },
];
