/**
 * Reserved sentinel tenant for global / anonymous identity-auth events that have
 * no real tenant (login, logout, refresh, password) — see ADR 0007. Global
 * events form a single hash chain under this id; tenant-scoped events chain under
 * their real tenant. Keeps audit_entries.tenant_id NOT NULL with zero schema
 * deviation.
 */
export const SENTINEL_TENANT_ID = '00000000-0000-0000-0000-000000000000';

export type AuditActorType = 'user' | 'anonymous' | 'system' | 'terminal';

export const AUDIT_ACTION = {
  // P1A Sales. Canonical verbs follow the repository's existing
  // <ENTITY>_<PAST_TENSE> convention (FR-AUD-002 "canonical verb").
  ORDER_CREATED: 'ORDER_CREATED',
  ORDER_STATE_CHANGED: 'ORDER_STATE_CHANGED',
  // P1C line capture. Same <ENTITY>_<PAST_TENSE> convention; no new taxonomy
  // shape is introduced, only the two verbs the new commands actually perform.
  ORDER_LINE_ADDED: 'ORDER_LINE_ADDED',
  ORDER_LINE_VOIDED: 'ORDER_LINE_VOIDED',
  // P1E-6 Fire. Same convention; one verb for the one material operational
  // action Fire performs (first Fire and every amendment Fire alike).
  ORDER_FIRED: 'ORDER_FIRED',
  // P1F-1 Payment MVP. Same convention; one verb covers both CASH and
  // MANUAL_EXTERNAL_CARD capture (the tender itself is metadata, not a
  // different action).
  PAYMENT_CAPTURED: 'PAYMENT_CAPTURED',
  // P1F-2 Order Completion. The final-Payment settling transaction: depletion,
  // COGS posting and the Order's completed CAS, all in the same UnitOfWork.
  ORDER_COMPLETED: 'ORDER_COMPLETED',
  // P1D-1 Workforce / Treasury. Same <ENTITY>_<PAST_TENSE> convention; the
  // audit taxonomy is not governance-controlled, so these follow the existing
  // shape rather than inventing one. Opening a shift and taking custody of a
  // drawer are two separately accountable events, hence two verbs.
  SHIFT_OPENED: 'SHIFT_OPENED',
  CASH_SESSION_OPENED: 'CASH_SESSION_OPENED',
  // P1G-0 Mid-shift cash movements (FR-POS-091). One verb covers all three
  // movement types (PAY_IN/PAY_OUT/SAFE_DROP); the type is metadata, not a
  // different action — mirrors STOCK_MOVEMENT_RECORDED's own convention.
  CASH_MOVEMENT_RECORDED: 'CASH_MOVEMENT_RECORDED',
  // Governance Approval runtime (migration 32, FR-SEC-030..033). One verb
  // covers both outcomes (approved/rejected) — the decision is metadata, not
  // a different action, mirroring CASH_MOVEMENT_RECORDED's own convention.
  APPROVAL_REQUEST_CREATED: 'APPROVAL_REQUEST_CREATED',
  APPROVAL_DECISION_RECORDED: 'APPROVAL_DECISION_RECORDED',
  // P1G-1 migration 33 — cash-close policy administration (FR-AUD-006
  // "configuration changes"). One verb: every write is a NEW immutable
  // version, never an edit, so there is no separate _UPDATED counterpart.
  CASH_CLOSE_POLICY_VERSION_CREATED: 'CASH_CLOSE_POLICY_VERSION_CREATED',
  // P1G-1 migration 34 — CashSession Close (FR-FIN-005/006/007, FR-AUD-006
  // "cash variances"). ONE verb covers both close paths (within-tolerance
  // fast path, and an approved above-tolerance finalize) — the route taken
  // is metadata, not a different action, mirroring CASH_MOVEMENT_RECORDED's
  // own convention. A REJECTED decision emits NO separate Treasury event
  // here: Governance's own APPROVAL_REQUEST_CREATED /
  // APPROVAL_DECISION_RECORDED already covers it — a second Treasury-side
  // echo would be exactly the audit duplication the design gate's §32 warns
  // against.
  CASH_SESSION_CLOSED: 'CASH_SESSION_CLOSED',
  // Acceptance closure correction: FR-AUD-006 names "cash variances" as an
  // action that SHALL ALWAYS generate an audit entry, independent of
  // FR-AUD-006's separately-listed "voids"/"refunds"/etc — a variance is
  // computed and durably recorded the instant a NEW close attempt is
  // created (both the within-tolerance fast path AND the above-tolerance
  // freeze), and a frozen session may sit in `closing`, or be rejected and
  // retried, for an unbounded time before any CASH_SESSION_CLOSED entry
  // ever exists. The close attempt ROW is durable business evidence but is
  // not itself a `governance.audit_entries` row — FR-AUD-001/006 require
  // the latter specifically. One verb, written exactly once per NEWLY
  // created attempt (never on a permanent-id replay, mirroring every other
  // audited write in this module); CASH_SESSION_CLOSED remains the
  // separate, later fact that the session actually closed.
  CASH_VARIANCE_DECLARED: 'CASH_VARIANCE_DECLARED',
  // Migration 35 — DayClose. Two DISTINCT verbs for two distinct durable
  // state changes (activation-mechanic final correction §7): activating a
  // branch's DayClose epoch (the FIRST POST for a branch — a durable,
  // committed, audited outcome, never a disguised failure) and sealing a
  // business day (a real close). Never conflated into one verb — an
  // activation writes no DayClose row, and a close never re-activates.
  DAY_CLOSE_ACTIVATED: 'DAY_CLOSE_ACTIVATED',
  DAY_CLOSED: 'DAY_CLOSED',
  // D-2 (amended) PIN substrate. Security-sensitive state changes only; a PIN
  // value never appears in any payload.
  EMPLOYEE_CREATED: 'EMPLOYEE_CREATED',
  EMPLOYEE_BRANCH_ASSIGNED: 'EMPLOYEE_BRANCH_ASSIGNED',
  PIN_SET: 'PIN_SET',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILURE: 'LOGIN_FAILURE',
  LOGOUT: 'LOGOUT',
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
  TENANT_SELECTED: 'TENANT_SELECTED',
  ROLE_ASSIGNED: 'ROLE_ASSIGNED',
  // B1-2 scoped RBAC (FR-AUD-006 "role changes"). The pre-B1-2 world had one
  // shape of role change — assigned/removed — so `ROLE_ASSIGNED` sufficed. A
  // scoped assignment can additionally be RE-SCOPED, have its validity window
  // changed, or be REVIEWED as an inherited migration grant, and those are
  // materially different security events: conflating them would make the audit
  // trail unable to answer "who widened this authority, and when". Same
  // <ENTITY>_<PAST_TENSE> convention as every other verb in this file. NO new
  // permission code is created — the existing `identity.role.assign` remains
  // the authority for all of them (amendment clause 20).
  ROLE_ASSIGNMENT_REMOVED: 'ROLE_ASSIGNMENT_REMOVED',
  ROLE_ASSIGNMENT_RESCOPED: 'ROLE_ASSIGNMENT_RESCOPED',
  ROLE_ASSIGNMENT_VALIDITY_CHANGED: 'ROLE_ASSIGNMENT_VALIDITY_CHANGED',
  ROLE_ASSIGNMENT_REVIEWED: 'ROLE_ASSIGNMENT_REVIEWED',
  TERMINAL_REGISTERED: 'TERMINAL_REGISTERED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',

  // Phase 15 — Organisation configuration mutations (ADR 0008 §15). Reads are
  // deliberately NOT audited.
  BRAND_CREATED: 'BRAND_CREATED',
  BRAND_UPDATED: 'BRAND_UPDATED',
  BRANCH_CREATED: 'BRANCH_CREATED',
  BRANCH_UPDATED: 'BRANCH_UPDATED',
  BRANCH_STATUS_CHANGED: 'BRANCH_STATUS_CHANGED',
  /** FR-PLT-004 requires a full audit record for this operation. */
  BRANCH_BRAND_REASSIGNED: 'BRANCH_BRAND_REASSIGNED',
  WAREHOUSE_CREATED: 'WAREHOUSE_CREATED',
  WAREHOUSE_UPDATED: 'WAREHOUSE_UPDATED',
  CENTRAL_KITCHEN_CREATED: 'CENTRAL_KITCHEN_CREATED',
  CENTRAL_KITCHEN_UPDATED: 'CENTRAL_KITCHEN_UPDATED',
  STATION_CREATED: 'STATION_CREATED',
  STATION_UPDATED: 'STATION_UPDATED',
  TABLE_CREATED: 'TABLE_CREATED',
  TABLE_UPDATED: 'TABLE_UPDATED',
  OPERATING_HOURS_CREATED: 'OPERATING_HOURS_CREATED',
  OPERATING_HOURS_UPDATED: 'OPERATING_HOURS_UPDATED',
  PRINT_ROUTING_CREATED: 'PRINT_ROUTING_CREATED',
  PRINT_ROUTING_UPDATED: 'PRINT_ROUTING_UPDATED',
  STATION_ROUTING_CREATED: 'STATION_ROUTING_CREATED',
  STATION_ROUTING_UPDATED: 'STATION_ROUTING_UPDATED',

  // Phase 16 — Catalogue mutations. Reads are NOT audited.
  MENU_CREATED: 'MENU_CREATED',
  MENU_UPDATED: 'MENU_UPDATED',
  MENU_ACTIVATED: 'MENU_ACTIVATED',
  MENU_DEACTIVATED: 'MENU_DEACTIVATED',
  MENU_BRANCH_ASSIGNED: 'MENU_BRANCH_ASSIGNED',
  MENU_BRANCH_UNASSIGNED: 'MENU_BRANCH_UNASSIGNED',
  CATEGORY_CREATED: 'CATEGORY_CREATED',
  CATEGORY_UPDATED: 'CATEGORY_UPDATED',
  MENU_ITEM_CREATED: 'MENU_ITEM_CREATED',
  MENU_ITEM_UPDATED: 'MENU_ITEM_UPDATED',
  MENU_ITEM_ACTIVATED: 'MENU_ITEM_ACTIVATED',
  MENU_ITEM_DEACTIVATED: 'MENU_ITEM_DEACTIVATED',
  MENU_ITEM_PLACED: 'MENU_ITEM_PLACED',
  MENU_ITEM_UNPLACED: 'MENU_ITEM_UNPLACED',
  VARIANT_CREATED: 'VARIANT_CREATED',
  VARIANT_UPDATED: 'VARIANT_UPDATED',
  VARIANT_ACTIVATED: 'VARIANT_ACTIVATED',
  VARIANT_DEACTIVATED: 'VARIANT_DEACTIVATED',
  MODIFIER_GROUP_CREATED: 'MODIFIER_GROUP_CREATED',
  MODIFIER_GROUP_UPDATED: 'MODIFIER_GROUP_UPDATED',
  MODIFIER_CREATED: 'MODIFIER_CREATED',
  MODIFIER_UPDATED: 'MODIFIER_UPDATED',
  MODIFIER_GROUP_LINKED: 'MODIFIER_GROUP_LINKED',
  PRICE_LIST_CREATED: 'PRICE_LIST_CREATED',
  PRICE_LIST_UPDATED: 'PRICE_LIST_UPDATED',
  /** FR-MNU-024: the audit trail is the system of record for price history. */
  PRICE_ENTRY_SET: 'PRICE_ENTRY_SET',
  AVAILABILITY_RULE_CREATED: 'AVAILABILITY_RULE_CREATED',
  AVAILABILITY_86_TOGGLED: 'AVAILABILITY_86_TOGGLED',

  // Inventory — mutations. Reads are NOT audited.
  STOCK_ITEM_CREATED: 'STOCK_ITEM_CREATED',
  STOCK_ITEM_UPDATED: 'STOCK_ITEM_UPDATED',
  REASON_CODE_CREATED: 'REASON_CODE_CREATED',
  REORDER_CONFIG_SET: 'REORDER_CONFIG_SET',
  STOCK_MOVEMENT_RECORDED: 'STOCK_MOVEMENT_RECORDED',
  STOCK_TRANSFER_DISPATCHED: 'STOCK_TRANSFER_DISPATCHED',
  STOCK_TRANSFER_RECEIVED: 'STOCK_TRANSFER_RECEIVED',
  COUNT_SESSION_OPENED: 'COUNT_SESSION_OPENED',
  COUNT_SESSION_POSTED: 'COUNT_SESSION_POSTED',
  WASTE_RECORDED: 'WASTE_RECORDED',

  // Production Spec — recipe lifecycle.
  RECIPE_CREATED: 'RECIPE_CREATED',
  RECIPE_VERSION_CREATED: 'RECIPE_VERSION_CREATED',
  RECIPE_VERSION_UPDATED: 'RECIPE_VERSION_UPDATED',
  RECIPE_VERSION_PUBLISHED: 'RECIPE_VERSION_PUBLISHED',
  SUBSTITUTE_GROUP_CREATED: 'SUBSTITUTE_GROUP_CREATED',
  SUBSTITUTE_GROUP_UPDATED: 'SUBSTITUTE_GROUP_UPDATED',
  // P1F-2 — D-17-07 resolution: the modifier -> recipe-effect replacement API.
  MODIFIER_RECIPE_EFFECTS_REPLACED: 'MODIFIER_RECIPE_EFFECTS_REPLACED',

  // KDS operator lifecycle (KDS-R11/KDS-R12, ratified 2026-08-30). Same
  // <ENTITY>_<PAST_TENSE> convention. FR-AUD-001 acceptance correction:
  // first-viewed IS a state-changing operation (a write-once persisted
  // stamp) and so IS audited — one entry per newly-viewed Ticket, never a
  // replay. Bump-all is ONE operator action -> ONE entry (metadata carries
  // the affected line ids), mirroring CASH_MOVEMENT_RECORDED's own
  // one-verb-many-instances convention; a per-line echo would be exactly the
  // audit noise that convention already rejects.
  TICKET_VIEWED: 'TICKET_VIEWED',
  TICKET_LINE_STARTED: 'TICKET_LINE_STARTED',
  TICKET_LINE_BUMPED: 'TICKET_LINE_BUMPED',
  TICKET_BUMPED: 'TICKET_BUMPED',
  TICKET_RECALLED: 'TICKET_RECALLED',
  // D4-1A offline/sync protocol kernel (migration 37). Same
  // <ENTITY>_<PAST_TENSE> convention; the audit taxonomy is not
  // governance-controlled, so these follow the existing shape rather than
  // inventing one.
  //
  // FR-OFF-042 requires a device whose clock is out by more than the
  // configured threshold to be RECORDED and the branch manager ALERTED. No
  // notification substrate exists in this repository, so the audit entry IS
  // the alert for now and FR-OFF-042 remains PARTIAL — see the D4-1A report.
  SYNC_CLOCK_SKEW_DETECTED: 'SYNC_CLOCK_SKEW_DETECTED',
  // FR-OFF-044 — every automatic conflict resolution is recorded with BOTH
  // input states and the applied rule. D4-1A ships the writer; D4-1B wires the
  // domain conflict handlers that call it.
  SYNC_CONFLICT_RECORDED: 'SYNC_CONFLICT_RECORDED',
  // FR-OFF-046 — a revalidation mismatch NEVER rejects a sale that physically
  // occurred; it is accepted, both values are recorded, and this is the entry
  // that says so.
  SYNC_REVALIDATION_EXCEPTION_RAISED: 'SYNC_REVALIDATION_EXCEPTION_RAISED',
  // D4-1B — lossless revoked-terminal recovery (migration 38, GD-D1-07). Same
  // <ENTITY>_<PAST_TENSE> convention. Three distinct verbs for three distinct
  // accountable events: an admin authorizing the window, the window being
  // bound to one specific batch, and that batch finishing — each is a
  // separately meaningful fact for "who authorized recovery of what, and did
  // it actually happen".
  TERMINAL_RECOVERY_GRANTED: 'TERMINAL_RECOVERY_GRANTED',
  TERMINAL_RECOVERY_BATCH_ACCEPTED: 'TERMINAL_RECOVERY_BATCH_ACCEPTED',
  TERMINAL_RECOVERY_BATCH_PROCESSED: 'TERMINAL_RECOVERY_BATCH_PROCESSED',

  // AUD-1 — FR-AUD-007 "Audit log access SHALL itself be audited." Two verbs
  // (not one, unlike CASH_MOVEMENT_RECORDED's single-verb-many-types
  // convention) because a search and an export are materially different
  // accountable events for an audit trail specifically: a search is a read, an
  // export is a durable copy leaving the system's own query surface. Written
  // by `AuditQueryService` for EVERY call to either route, success or not.
  AUDIT_LOG_QUERIED: 'AUDIT_LOG_QUERIED',
  AUDIT_LOG_EXPORTED: 'AUDIT_LOG_EXPORTED',

  // POS-FIN-1 — discounts/comps, post-fire void disposition, refunds
  // (FR-AUD-006 "discounts, comps, voids, refunds"). Same
  // <ENTITY>_<PAST_TENSE> convention. DISCOUNT_APPLIED covers both
  // percentage and fixed (the value type is metadata, not a different
  // action, mirroring CASH_MOVEMENT_RECORDED's own convention); COMP_APPLIED
  // is its own verb because FR-POS-050 requires a comp be economically
  // distinct from a discount, not merely a 100% one.
  DISCOUNT_APPLIED: 'DISCOUNT_APPLIED',
  COMP_APPLIED: 'COMP_APPLIED',
  ORDER_LINE_VOIDED_POSTFIRE: 'ORDER_LINE_VOIDED_POSTFIRE',
  REFUND_ISSUED: 'REFUND_ISSUED',
} as const;

export const AUDIT_ENTITY = {
  ORDER: 'order',
  ORDER_LINE: 'order_line',
  ORDER_PAYMENT: 'order_payment',
  SHIFT: 'shift',
  CASH_SESSION: 'cash_session',
  CASH_MOVEMENT: 'cash_movement',
  // P1G-1 migration 33.
  CASH_CLOSE_POLICY: 'cash_close_policy',
  // Migration 35 — DayClose.
  DAY_CLOSE: 'day_close',
  DAY_CLOSE_ACTIVATION: 'day_close_activation',

  // D4-1A offline/sync protocol kernel (migration 37).
  SYNC_DEVICE_STATE: 'sync_device_state',
  SYNC_CONFLICT_RECORD: 'sync_conflict_record',
  SYNC_REVALIDATION_EXCEPTION: 'sync_revalidation_exception',
  APPROVAL_REQUEST: 'approval_request',
  APPROVAL_DECISION: 'approval_decision',
  DRAWER: 'drawer',
  EMPLOYEE: 'employee',
  USER: 'user',
  SESSION: 'session',
  TENANT: 'tenant',
  MEMBERSHIP: 'membership',
  /// B1-2 — a single scoped role assignment (`identity.membership_roles.id`).
  ROLE_ASSIGNMENT: 'role_assignment',
  TERMINAL: 'terminal',
  // D4-1B — migration 38.
  SYNC_RECOVERY_GRANT: 'sync_recovery_grant',

  // Phase 15 — Organisation entities.
  BRAND: 'brand',
  BRANCH: 'branch',
  WAREHOUSE: 'warehouse',
  CENTRAL_KITCHEN: 'central_kitchen',
  STATION: 'station',
  TABLE: 'table',
  OPERATING_HOURS: 'operating_hours',
  PRINT_ROUTING: 'print_routing',
  STATION_ROUTING_RULE: 'station_routing_rule',

  // Phase 16 — Catalogue entities.
  MENU: 'menu',
  MENU_BRANCH: 'menu_branch',
  CATEGORY: 'category',
  MENU_ITEM: 'menu_item',
  MENU_ITEM_PLACEMENT: 'menu_item_placement',
  VARIANT: 'menu_item_variant',
  MODIFIER_GROUP: 'modifier_group',
  MODIFIER: 'modifier',
  MODIFIER_GROUP_LINK: 'modifier_group_link',
  PRICE_LIST: 'price_list',
  PRICE_ENTRY: 'price_entry',
  AVAILABILITY_RULE: 'availability_rule',

  // Inventory entities.
  STOCK_ITEM: 'stock_item',
  REASON_CODE: 'reason_code',
  REORDER_CONFIG: 'reorder_config',
  STOCK_MOVEMENT: 'stock_movement',
  COUNT_SESSION: 'count_session',
  WASTE_RECORD: 'waste_record',

  // Production Spec entities.
  RECIPE: 'recipe',
  RECIPE_VERSION: 'recipe_version',
  SUBSTITUTE_GROUP: 'substitute_group',

  // KDS operator lifecycle entities.
  TICKET: 'ticket',
  TICKET_LINE: 'ticket_line',

  // AUD-1 — the audit log itself, as the object of an access (FR-AUD-007).
  AUDIT_LOG: 'audit_log',

  // POS-FIN-1 entities.
  DISCOUNT: 'discount',
  POST_FIRE_VOID_RECORD: 'post_fire_void_record',
  REFUND: 'refund',
} as const;
