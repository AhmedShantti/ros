import type { DmlImpossible, RowOverride } from './synthesize';

/**
 * FR-PLT-013 fixture-builder registry.
 *
 * Every entry here exists because the *generic* schema-driven synthesizer in
 * synthesize.ts (FK graph + type-driven column filling) produces a row that
 * violates one of this table's CHECK/EXCLUDE constraints — never because a
 * table was arbitrarily judged "too hard": the `reason` on each entry names
 * the exact constraint. As of the run that produced this file, 50/83 root
 * tenant tables synthesize with no override at all; these are the remaining
 * 16 whose domain invariants a blind generic pass cannot satisfy.
 *
 * generated-cross-tenant.e2e-spec.ts enforces two things this file must keep
 * true: (1) every entry's `reason` is non-empty, and (2) every discovered
 * root tenant table resolves to either a working generic pass, an entry
 * here, or a DML_IMPOSSIBLE entry below — a table with none of the three
 * fails the suite instead of being silently skipped.
 */

const overrides: RowOverride[] = [
  {
    key: 'fiscal.tax_classes',
    reason:
      'ck_tax_class_code_shape requires `code` to match ^[a-z][a-z0-9_]*$; ' +
      'ck_tax_class_pack_code_shape requires `country_pack_code` to match ' +
      '^[A-Z]{2,8}$. The generic text filler produces neither shape.',
    columns: (ctx) => ({
      code: `fx_tax_${ctx.seq}`,
      country_pack_code: 'EG',
    }),
  },
  {
    key: 'catalogue.availability_rules',
    reason:
      'ck_availability_target_xor requires exactly one of menu_item_id/' +
      'variant_id set; both are nullable so the generic pass (which only ' +
      'resolves FKs where every column of the constraint is NOT NULL) ' +
      'leaves both NULL.',
    columns: async (ctx) => {
      const menuItem = await ctx.resolve('catalogue', 'menu_items');
      return { menu_item_id: menuItem.id };
    },
  },
  {
    key: 'governance.approval_decisions',
    reason:
      'ck_approval_decision_value restricts `decision` to the literal set ' +
      "{'approved','rejected'} via a varchar CHECK, not a Postgres enum, " +
      'so the generic enum-lookup path does not apply.',
    columns: () => ({ decision: 'approved' }),
  },
  {
    key: 'org.locations',
    reason:
      'ck_location_target requires ref_id to equal whichever of branch_id/' +
      'warehouse_id/central_kitchen_id matches location_type. branch_id is ' +
      'nullable so the generic pass leaves it NULL while location_type ' +
      "still generically resolves to the enum's first value ('branch').",
    columns: async (ctx) => {
      const branch = await ctx.resolve('org', 'branches');
      return {
        location_type: 'branch',
        branch_id: branch.id,
        ref_id: branch.id,
      };
    },
  },
  {
    key: 'kitchen.station_routing_rules',
    reason:
      'ck_station_routing_rule_one_selector requires exactly one of ' +
      'menu_item_id/category_id/modifier_id set; all three are nullable so ' +
      'the generic pass leaves all three NULL (zero selected).',
    columns: async (ctx) => {
      const menuItem = await ctx.resolve('catalogue', 'menu_items');
      return { menu_item_id: menuItem.id };
    },
  },
  {
    key: 'platform.job_findings',
    reason:
      "ck_job_findings_severity restricts `severity` to {'info','warning'," +
      "'critical'} via a varchar CHECK, not a Postgres enum.",
    columns: () => ({ severity: 'info' }),
  },
  {
    key: 'production.modifier_recipe_effects',
    reason:
      'ck_mre_component_xor/ck_mre_operation jointly require, for a ' +
      "'remove_all' operation, component_type='stock_item' with " +
      'stock_item_id set and quantity/unit_id NULL — stock_item_id is ' +
      'nullable (XOR with sub_recipe_id) so the generic pass leaves it NULL.',
    columns: async (ctx) => {
      const stockItem = await ctx.resolve('inventory', 'stock_items');
      return {
        operation: 'remove_all',
        component_type: 'stock_item',
        stock_item_id: stockItem.id,
      };
    },
  },
  {
    key: 'production.recipes',
    reason:
      "ck_recipe_target requires recipe_type='sub_recipe'|'production_item' " +
      'to pair with a NOT NULL stock_item_id (NULL menu_item_variant_id); ' +
      'stock_item_id is nullable (XOR with menu_item_variant_id) so the ' +
      'generic pass leaves it NULL while recipe_type generically resolves ' +
      "to the enum's first value ('menu_item').",
    columns: async (ctx) => {
      const stockItem = await ctx.resolve('inventory', 'stock_items');
      return {
        recipe_type: 'sub_recipe',
        stock_item_id: stockItem.id,
        scope: 'tenant',
      };
    },
  },
  {
    key: 'sales.order_line_modifier_effects',
    reason:
      'Same shape as production.modifier_recipe_effects: ' +
      'ck_olme_component_xor/ck_olme_operation require component_type=' +
      "'stock_item' with stock_item_id set for a 'remove_all' operation; " +
      'stock_item_id is nullable so the generic pass leaves it NULL.',
    columns: async (ctx) => {
      const stockItem = await ctx.resolve('inventory', 'stock_items');
      return {
        operation: 'remove_all',
        component_type: 'stock_item',
        stock_item_id: stockItem.id,
      };
    },
  },
  {
    key: 'sales.order_payments',
    reason:
      "ck_order_payments_cash_fields requires, for tender='cash', " +
      'tendered_amount and change_given both NOT NULL; both are nullable ' +
      'so the generic pass leaves them NULL while tender generically ' +
      "resolves to the enum's first value, which happens to be 'cash'.",
    columns: () => ({ tender: 'cash', tendered_amount: 100, change_given: 0 }),
  },
  {
    key: 'sync.conflict_records',
    reason:
      "ck_conflict_records_resolution restricts `resolution` to {'auto'," +
      "'manual_pending','manual_resolved'} via a varchar CHECK, not an enum.",
    columns: () => ({ resolution: 'auto' }),
  },
  {
    key: 'sync.operation_dedup',
    reason:
      "ck_operation_dedup_status restricts `status` to {'accepted'," +
      "'conflict','rejected'} via a varchar CHECK, not an enum.",
    columns: () => ({ status: 'accepted' }),
  },
  {
    key: 'sync.sync_batches',
    reason:
      "ck_sync_batches_state restricts `state` to {'in_flight','completed'} " +
      "via a varchar CHECK, not an enum; 'in_flight' also sidesteps " +
      "ck_sync_batches_completed (which only constrains the 'completed' case).",
    columns: () => ({ state: 'in_flight' }),
  },
  {
    key: 'sync.sync_operations',
    reason:
      "ck_sync_operations_status restricts `status` to {'accepted'," +
      "'duplicate','conflict','rejected','deferred'} via a varchar CHECK, " +
      'not an enum.',
    columns: () => ({ status: 'accepted' }),
  },
  {
    key: 'treasury.cash_close_policies',
    reason:
      'ck_ccp_currency_iso requires `currency` to match ^[A-Z]{3}$; the ' +
      'generic text filler does not produce that shape.',
    columns: () => ({ currency: 'EGP' }),
  },
  {
    key: 'treasury.day_closes',
    reason:
      'Several arithmetic/structural-zero CHECKs constrain this snapshot ' +
      'row jointly: ck_dc_currency (ISO shape), ck_dc_aov_null_iff_zero_count ' +
      '(average_order_value_minor IS NULL iff completed_order_count = 0), ' +
      'ck_dc_net_sales_arith (net = gross - discounts - refunds - tax), and ' +
      'ck_dc_discounts_structurally_zero / ck_dc_refunds_structurally_zero ' +
      '(both must be exactly 0 at this SRS phase). A generic per-column fill ' +
      'cannot satisfy identities that span multiple columns.',
    columns: () => ({
      currency: 'EGP',
      completed_order_count: 0,
      gross_sales_minor: 0,
      discounts_minor: 0,
      refunds_minor: 0,
      tax_total_minor: 0,
      net_sales_minor: 0,
    }),
  },
  {
    key: 'inventory.stock_movements',
    reason:
      "ck_batch_required demands batch_id when movement_type is 'purchase_" +
      "receipt'/'production_output'; ck_reason_required demands reason_" +
      "code_id when movement_type is 'waste'/'manual_adjustment'. Both " +
      "columns are nullable, and the generic pass picks the enum's first " +
      "value ('purchase_receipt'), triggering the first requirement. " +
      "'sale_depletion' needs neither.",
    columns: () => ({ movement_type: 'sale_depletion' }),
  },
  {
    key: 'production.recipe_lines',
    reason:
      'ck_recipe_line_component is the same stock_item_id/sub_recipe_id XOR ' +
      'as production.modifier_recipe_effects; stock_item_id is nullable so ' +
      'the generic pass leaves it NULL.',
    columns: async (ctx) => {
      const stockItem = await ctx.resolve('inventory', 'stock_items');
      return { component_type: 'stock_item', stock_item_id: stockItem.id };
    },
  },
  {
    key: 'treasury.cash_session_close_attempts',
    reason:
      'ck_csca_currency (ISO shape) plus four arithmetic identities — ' +
      'ck_csca_variance, ck_csca_formula, ck_csca_approval_required_matches ' +
      '— and two structurally-zero CHECKs (cash_tips_total, ' +
      'cash_refunds_total) jointly constrain this row; only an internally ' +
      'consistent all-zero snapshot satisfies every identity at once.',
    columns: () => ({
      currency: 'EGP',
      opening_float: 0,
      cash_sales_total: 0,
      cash_tips_total: 0,
      pay_in_total: 0,
      cash_refunds_total: 0,
      pay_out_total: 0,
      safe_drop_total: 0,
      cash_rounding_adjustments: 0,
      expected_cash: 0,
      counted_cash: 0,
      variance: 0,
      tolerance_minor_units: 0,
      approval_required: false,
    }),
  },
  {
    key: 'treasury.day_close_order_type_totals',
    reason:
      "ck_dcot_order_type restricts `order_type` to a fixed set {'dine_in'," +
      "'takeaway','delivery','drive_thru','pickup','aggregator'} via a " +
      'varchar CHECK, not an enum.',
    columns: () => ({ order_type: 'dine_in' }),
  },
  {
    key: 'treasury.day_close_sessions',
    reason:
      'ck_dcs_variance_arith requires whole_session_variance_minor = ' +
      'whole_session_counted_cash_minor - whole_session_expected_cash_minor; ' +
      'the generic pass fills each independently (all 1), which is not a ' +
      'valid solution to the identity.',
    columns: () => ({
      whole_session_counted_cash_minor: 0,
      whole_session_expected_cash_minor: 0,
      whole_session_variance_minor: 0,
    }),
  },
  {
    key: 'treasury.day_close_tax_class_totals',
    reason:
      'ck_dctc_arith requires gross_amount_minor = net_amount_minor + ' +
      'tax_amount_minor; the generic pass fills each independently (all 1).',
    columns: () => ({
      net_amount_minor: 0,
      tax_amount_minor: 0,
      gross_amount_minor: 0,
    }),
  },
  // MW1I integration additions — these 5 tables were introduced by the
  // POS-FIN-1 and HR-1 lanes, both of which post-date the CI-1 run that
  // generated this registry, so they were never previously discovered.
  {
    key: 'sales.discounts',
    reason:
      "ck_discount_value_shape requires, for kind='discount', value_type " +
      "in {'percentage','fixed'} with the matching amount column set " +
      "(the other NULL); value_type is nullable so the generic pass " +
      "leaves it NULL while kind generically resolves to the enum's " +
      "first value ('discount').",
    columns: () => ({
      kind: 'discount',
      value_type: 'percentage',
      percentage_value_bp: 500,
      fixed_value_minor: null,
    }),
  },
  {
    key: 'sales.refunds',
    reason:
      "ck_refund_cash_session_required_for_cash requires cash_session_id " +
      "NOT NULL when tender='cash'; cash_session_id is nullable (and has " +
      "no FK, by design — see the migration) so the generic pass leaves " +
      "it NULL while tender generically resolves to the enum's first " +
      "value ('cash').",
    columns: async (ctx) => {
      const cashSession = await ctx.resolve('treasury', 'cash_sessions');
      return { tender: 'cash', cash_session_id: cashSession.id };
    },
  },
  {
    key: 'workforce.employee_compensations',
    reason:
      "ck_ec_currency_iso requires `currency` to match ^[A-Z]{3}$; the " +
      'generic CHAR(3) filler does not produce that shape.',
    columns: () => ({ currency: 'EGP' }),
  },
  {
    key: 'workforce.scheduled_shifts',
    reason:
      'ck_scheduled_shift_starts_before_ends requires starts_at < ends_at; ' +
      'the generic pass fills both timestamp columns with the same ' +
      'synthetic instant.',
    columns: () => {
      const startsAt = new Date();
      const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
      return { starts_at: startsAt, ends_at: endsAt };
    },
  },
  {
    key: 'workforce.clock_events',
    reason:
      "ck_clock_event_terminal_required_for_pos_pin requires terminal_id " +
      "NOT NULL when method='pos_pin'; terminal_id is nullable and method " +
      "generically resolves to the enum's first value ('pos_pin'). " +
      "'mobile' is the simplest method that carries no such requirement.",
    columns: () => ({ method: 'mobile' }),
  },
];

export const FIXTURE_OVERRIDES: Map<string, RowOverride> = new Map(
  overrides.map((o) => [o.key, o]),
);

for (const o of overrides) {
  if (!o.reason || o.reason.trim().length < 10) {
    throw new Error(
      `fixture-overrides.ts: entry "${o.key}" has no real reason recorded.`,
    );
  }
}

/** Tables with no direct-insert fixture path at all. Empty by design as of
 * this writing: every discovered root tenant table has either a working
 * generic shape or a RowOverride above. Kept so the registry shape matches
 * generated-cross-tenant.e2e-spec.ts's expectations if a future table
 * genuinely cannot be constructed (e.g. populated only by a DB trigger with
 * no legitimate direct-insert path). */
const dmlImpossible: DmlImpossible[] = [];

export const DML_IMPOSSIBLE: Map<string, DmlImpossible> = new Map(
  dmlImpossible.map((d) => [d.key, d]),
);
