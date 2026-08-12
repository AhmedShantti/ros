-- ============================================================================
-- Restaurant Operating System (ROS) — Full Database Design
-- Derived from: ROS-SRS-001 v1.0 (Chapter 7 Domain Model, Chapter 25 Data
-- Architecture, Chapter 10/11 Menu & Inventory attribute specs)
-- Target: PostgreSQL 15+
-- Conventions (per SRS 25.1 / 7.2 / 7.4):
--   * All surrogate keys are ULIDs generated client/server-side, stored as UUID
--   * Money  -> BIGINT, minor currency units (e.g. cents), never FLOAT/NUMERIC
--   * Qty    -> NUMERIC(18,6) (SRS: 6 dp precision, BR-CORE-003)
--   * Every tenant-scoped table carries tenant_id + Row Level Security
--   * High-volume, time-ordered tables are RANGE partitioned (SRS 25.3)
--   * Immutable ledgers (stock_movements, audit_entries) are append-only
--     via REVOKE + protective rules (SRS BR-INV-001)
--   * Sale-time facts are snapshotted onto order_lines, never re-derived
--     from live master data (SRS BR-POS-004)
-- ============================================================================

-- ============================================================================
-- SCHEMAS  (SRS 25.1)
-- ============================================================================

-- Helper: current tenant for RLS (set per-connection by the app layer)
-- SELECT set_config('app.tenant_id', '<uuid>', false);

-- ============================================================================
-- 1. IDENTITY  — Aggregates: Tenant, User, Terminal  (SRS 7.3 #1-3)
-- ============================================================================
CREATE TABLE identity.tenants (
    id                  UUID PRIMARY KEY,
    slug                VARCHAR(64) NOT NULL UNIQUE,
    legal_name          VARCHAR(255) NOT NULL,
    default_currency    CHAR(3) NOT NULL,
    default_locale      VARCHAR(10) NOT NULL DEFAULT 'ar',
    country_pack_code   VARCHAR(8) NOT NULL,          -- FK -> fiscal.country_packs(code)
    status              VARCHAR(16) NOT NULL DEFAULT 'active', -- active, suspended, closed
    owner_user_id       UUID,                          -- exactly-one-owner invariant enforced in app/trigger
    settings            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity.subscriptions (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    plan_code           VARCHAR(32) NOT NULL,          -- basic, professional, enterprise
    branch_quota        INTEGER NOT NULL,
    terminal_quota      INTEGER NOT NULL,
    billing_cycle       VARCHAR(16) NOT NULL DEFAULT 'monthly',
    status              VARCHAR(16) NOT NULL DEFAULT 'trial',
    trial_ends_at       TIMESTAMPTZ,
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end   TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity.users (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    email               VARCHAR(255) NOT NULL,
    phone               VARCHAR(24),
    display_name        VARCHAR(120) NOT NULL,
    preferred_locale    VARCHAR(10) NOT NULL DEFAULT 'ar',
    status              VARCHAR(16) NOT NULL DEFAULT 'active', -- active, disabled, locked
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_email_per_tenant UNIQUE (tenant_id, email)
);

CREATE TABLE identity.credentials (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    credential_type     VARCHAR(16) NOT NULL,          -- password, pin, oauth
    secret_hash         TEXT NOT NULL,
    pin_for_terminal    BOOLEAN NOT NULL DEFAULT false, -- short PIN used for POS quick-switch
    must_reset          BOOLEAN NOT NULL DEFAULT false,
    rotated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity.mfa_enrolments (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    method              VARCHAR(16) NOT NULL,          -- totp, sms, webauthn
    secret_or_credential TEXT NOT NULL,
    verified_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity.sessions (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    terminal_id         UUID,                           -- FK identity.terminals, nullable (web session)
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    ip_address          INET,
    user_agent          TEXT
);

CREATE TABLE identity.roles (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID REFERENCES identity.tenants(id), -- NULL = system-defined role
    name                VARCHAR(64) NOT NULL,
    description         TEXT,
    is_system           BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE identity.permissions (
    id                  UUID PRIMARY KEY,
    code                VARCHAR(80) NOT NULL UNIQUE,     -- e.g. order.cancel_after_production
    description         TEXT NOT NULL,
    module              VARCHAR(32) NOT NULL
);

CREATE TABLE identity.role_permissions (
    role_id             UUID NOT NULL REFERENCES identity.roles(id) ON DELETE CASCADE,
    permission_id       UUID NOT NULL REFERENCES identity.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE identity.user_roles (
    user_id             UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    role_id             UUID NOT NULL REFERENCES identity.roles(id) ON DELETE CASCADE,
    branch_id           UUID,                            -- optional scoping to a single branch
    PRIMARY KEY (user_id, role_id, branch_id)
);

CREATE TABLE identity.terminals (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    branch_id           UUID NOT NULL,                   -- FK org.branches(id)
    name                VARCHAR(64) NOT NULL,
    terminal_type       VARCHAR(16) NOT NULL,             -- pos, kds, kiosk, handheld
    status              VARCHAR(16) NOT NULL DEFAULT 'active',
    last_seen_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity.device_fingerprints (
    id                  UUID PRIMARY KEY,
    terminal_id         UUID NOT NULL REFERENCES identity.terminals(id) ON DELETE CASCADE,
    fingerprint_hash    TEXT NOT NULL,
    os                  VARCHAR(32),
    app_version         VARCHAR(32),
    registered_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE identity.licence_assignments (
    id                  UUID PRIMARY KEY,
    terminal_id         UUID NOT NULL REFERENCES identity.terminals(id) ON DELETE CASCADE,
    subscription_id     UUID NOT NULL REFERENCES identity.subscriptions(id),
    assigned_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at         TIMESTAMPTZ
);

CREATE TABLE identity.api_keys (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                VARCHAR(64) NOT NULL,
    key_hash            TEXT NOT NULL,
    scopes              TEXT[] NOT NULL DEFAULT '{}',
    last_used_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. ORG  — Aggregates: Brand, Branch, Warehouse  (SRS 7.3 #4-6)
-- ============================================================================
CREATE TABLE org.brands (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                VARCHAR(120) NOT NULL,
    theme               JSONB NOT NULL DEFAULT '{}'::jsonb,     -- BrandTheme
    default_settings    JSONB NOT NULL DEFAULT '{}'::jsonb,     -- DefaultSettings
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org.branches (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    brand_id            UUID NOT NULL REFERENCES org.brands(id),
    code                VARCHAR(16) NOT NULL,
    name                VARCHAR(120) NOT NULL,
    timezone            VARCHAR(48) NOT NULL,                    -- e.g. Africa/Cairo
    base_currency        CHAR(3) NOT NULL,
    country_code         CHAR(2) NOT NULL,
    address              JSONB,
    status               VARCHAR(16) NOT NULL DEFAULT 'active',
    automatic_availability BOOLEAN NOT NULL DEFAULT true,        -- FR-MNU-031
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_branch_code UNIQUE (tenant_id, code)
);

CREATE TABLE org.operating_hours (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id) ON DELETE CASCADE,
    day_of_week         SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    opens_at            TIME NOT NULL,
    closes_at           TIME NOT NULL,
    business_day_cutover TIME NOT NULL DEFAULT '00:00'          -- when "business_day" rolls over
);

CREATE TABLE org.warehouses (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                VARCHAR(120) NOT NULL,
    warehouse_type      VARCHAR(16) NOT NULL DEFAULT 'branch',   -- branch, central, virtual
    branch_id           UUID REFERENCES org.branches(id),        -- NULL when standalone warehouse
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org.central_kitchens (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    warehouse_id        UUID NOT NULL REFERENCES org.warehouses(id),
    name                VARCHAR(120) NOT NULL
);

CREATE TABLE org.stations (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id) ON DELETE CASCADE,
    name                VARCHAR(64) NOT NULL,                    -- Grill, Fryer, Cold, Bar
    capacity_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
    display_terminal_id UUID REFERENCES identity.terminals(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org.tables (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id) ON DELETE CASCADE,
    label               VARCHAR(16) NOT NULL,
    section             VARCHAR(64),
    seat_capacity       SMALLINT,
    status              VARCHAR(16) NOT NULL DEFAULT 'free',     -- free, seated, reserved
    CONSTRAINT uq_table_label UNIQUE (branch_id, label)
);

CREATE TABLE org.settings (
    id                  UUID PRIMARY KEY,
    scope_type          VARCHAR(16) NOT NULL,                    -- tenant, brand, branch
    scope_id            UUID NOT NULL,
    key                 VARCHAR(120) NOT NULL,
    value                JSONB NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_setting UNIQUE (scope_type, scope_id, key)
);

-- Kitchen print/station routing rules referenced by both org and kitchen
CREATE TABLE kitchen.station_routing_rules (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id),
    station_id          UUID NOT NULL REFERENCES org.stations(id),
    menu_item_id        UUID,                                    -- FK catalogue.menu_items(id), nullable = category rule
    category_id         UUID,
    priority            SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE org.print_routing (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id),
    document_type       VARCHAR(24) NOT NULL,                    -- receipt, kitchen_ticket, bar_ticket
    printer_target      VARCHAR(64) NOT NULL,
    station_id          UUID REFERENCES org.stations(id)
);

-- ============================================================================
-- 3. CATALOGUE — Aggregates: MenuItem, ModifierGroup, Combo, PriceList
--    (SRS 7.3 #7-10, Chapter 10)
-- ============================================================================
CREATE TABLE catalogue.menus (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                JSONB NOT NULL,                          -- {"ar":"..","en":".."}
    order_types         TEXT[] NOT NULL DEFAULT '{}',
    active_window       JSONB,                                   -- time-of-day / day-of-week rules
    priority            SMALLINT NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE catalogue.categories (
    id                  UUID PRIMARY KEY,
    menu_id             UUID NOT NULL REFERENCES catalogue.menus(id),
    parent_category_id  UUID REFERENCES catalogue.categories(id), -- self-ref for sub-category
    name                JSONB NOT NULL,
    sort_order          SMALLINT NOT NULL DEFAULT 0,
    colour              VARCHAR(9)
);

CREATE TABLE catalogue.menu_items (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    category_id         UUID NOT NULL REFERENCES catalogue.categories(id),
    names               JSONB NOT NULL,                          -- localised customer-facing name
    kitchen_names       JSONB NOT NULL DEFAULT '{}'::jsonb,       -- FR-MNU-005
    aggregator_names    JSONB NOT NULL DEFAULT '{}'::jsonb,
    description         JSONB,
    tax_class_id        UUID NOT NULL,                            -- FK fiscal.tax_classes(id)
    revenue_account_code VARCHAR(32),
    barcode_plu         VARCHAR(32),
    allergens           TEXT[] NOT NULL DEFAULT '{}',
    dietary_tags        TEXT[] NOT NULL DEFAULT '{}',
    sort_order          SMALLINT NOT NULL DEFAULT 0,
    colour              VARCHAR(9),
    is_combo            BOOLEAN NOT NULL DEFAULT false,
    is_open_price       BOOLEAN NOT NULL DEFAULT false,
    is_weighed          BOOLEAN NOT NULL DEFAULT false,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE catalogue.menu_item_variants (
    id                  UUID PRIMARY KEY,
    menu_item_id        UUID NOT NULL REFERENCES catalogue.menu_items(id) ON DELETE CASCADE,
    name                JSONB NOT NULL,                          -- e.g. Small/Medium/Large
    barcode              VARCHAR(32),
    station_id          UUID REFERENCES org.stations(id),
    prep_time_seconds   INTEGER,
    sort_order          SMALLINT NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE catalogue.menu_item_images (
    id                  UUID PRIMARY KEY,
    menu_item_id        UUID NOT NULL REFERENCES catalogue.menu_items(id) ON DELETE CASCADE,
    url                 TEXT NOT NULL,
    sort_order          SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE catalogue.availability_rules (
    id                  UUID PRIMARY KEY,
    menu_item_id        UUID REFERENCES catalogue.menu_items(id) ON DELETE CASCADE,
    variant_id          UUID REFERENCES catalogue.menu_item_variants(id) ON DELETE CASCADE,
    branch_id           UUID REFERENCES org.branches(id),
    channel             VARCHAR(16),
    day_of_week         SMALLINT,
    starts_at           TIME,
    ends_at             TIME,
    is_manual_86        BOOLEAN NOT NULL DEFAULT false,          -- FR-MNU-030
    auto_reenable_at    TIMESTAMPTZ,
    daily_quantity_limit INTEGER,                                -- FR-MNU-035
    quantity_sold_today  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE catalogue.modifier_groups (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                JSONB NOT NULL,
    min_selections      SMALLINT NOT NULL DEFAULT 0,
    max_selections      SMALLINT NOT NULL DEFAULT 1,
    is_required         BOOLEAN NOT NULL DEFAULT false,
    allow_repeat        BOOLEAN NOT NULL DEFAULT false,
    free_quantity_threshold SMALLINT NOT NULL DEFAULT 0,          -- FR-MNU-011
    CONSTRAINT ck_min_le_max CHECK (min_selections <= max_selections),
    CONSTRAINT ck_required_min CHECK (NOT is_required OR min_selections >= 1)
);

CREATE TABLE catalogue.modifiers (
    id                  UUID PRIMARY KEY,
    modifier_group_id   UUID NOT NULL REFERENCES catalogue.modifier_groups(id) ON DELETE CASCADE,
    name                JSONB NOT NULL,
    price_delta         BIGINT NOT NULL DEFAULT 0,                 -- minor units, may be negative
    stock_item_id       UUID,                                      -- FK inventory.stock_items(id), nullable
    consumption_quantity NUMERIC(18,6),
    consumption_unit_id  UUID,
    recipe_delta        JSONB,                                     -- FR-MNU-013 add/remove/replace ops
    is_default          BOOLEAN NOT NULL DEFAULT false,
    sort_order          SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE catalogue.modifier_group_links (
    menu_item_id         UUID NOT NULL REFERENCES catalogue.menu_items(id) ON DELETE CASCADE,
    modifier_group_id    UUID NOT NULL REFERENCES catalogue.modifier_groups(id) ON DELETE CASCADE,
    price_override        JSONB,                                    -- per-item modifier price overrides
    default_selection_override JSONB,
    sort_order            SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (menu_item_id, modifier_group_id)
);

CREATE TABLE catalogue.combos (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    menu_item_id        UUID NOT NULL REFERENCES catalogue.menu_items(id), -- combo is-a menu item
    name                JSONB NOT NULL
);

CREATE TABLE catalogue.combo_slots (
    id                  UUID PRIMARY KEY,
    combo_id            UUID NOT NULL REFERENCES catalogue.combos(id) ON DELETE CASCADE,
    name                JSONB NOT NULL,                            -- e.g. "Choose a side"
    sort_order          SMALLINT NOT NULL DEFAULT 0,
    CONSTRAINT ck_slot_has_options CHECK (true) -- >=1 option enforced by app/trigger on slot_options
);

CREATE TABLE catalogue.combo_slot_options (
    id                  UUID PRIMARY KEY,
    slot_id             UUID NOT NULL REFERENCES catalogue.combo_slots(id) ON DELETE CASCADE,
    menu_item_variant_id UUID NOT NULL REFERENCES catalogue.menu_item_variants(id),
    price_delta          BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE catalogue.price_lists (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                VARCHAR(120) NOT NULL,
    scope_type          VARCHAR(16) NOT NULL,                      -- tenant, brand, branch, branch_group
    scope_id            UUID,
    order_type          VARCHAR(16),                                -- FR-MNU-021, NULL = all
    valid_from          TIMESTAMPTZ,
    valid_to            TIMESTAMPTZ,
    recurrence_rule     JSONB,                                      -- FR-MNU-022 (RRULE-like)
    priority            SMALLINT NOT NULL DEFAULT 0,
    status              VARCHAR(16) NOT NULL DEFAULT 'scheduled'    -- scheduled, active, expired
);

CREATE TABLE catalogue.price_entries (
    id                  UUID PRIMARY KEY,
    price_list_id       UUID NOT NULL REFERENCES catalogue.price_lists(id) ON DELETE CASCADE,
    menu_item_variant_id UUID NOT NULL REFERENCES catalogue.menu_item_variants(id),
    price                BIGINT NOT NULL,                            -- minor units
    currency             CHAR(3) NOT NULL
);

CREATE TABLE catalogue.price_change_history (
    id                  UUID PRIMARY KEY,
    price_entry_id       UUID NOT NULL,
    old_price            BIGINT,
    new_price            BIGINT NOT NULL,
    changed_by            UUID NOT NULL REFERENCES identity.users(id),
    effective_at          TIMESTAMPTZ NOT NULL,
    changed_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No-overlap guard for same-scope/priority price list windows (FR-MNU-020 note)

-- ============================================================================
-- 4. PRODUCTION — Aggregate: Recipe  (SRS 7.3 #11, 7.4.4, Chapter 10.6)
-- ============================================================================
CREATE TABLE production.recipes (
    id                  UUID PRIMARY KEY,                          -- logical identity, stable across versions
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    scope               VARCHAR(16) NOT NULL,                       -- tenant, brand, branch
    scope_id            UUID,
    recipe_type         VARCHAR(24) NOT NULL,                       -- menu_item, sub_recipe, production_item
    target_id           UUID NOT NULL,                              -- menu_item_variant_id or stock_item_id
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production.recipe_versions (
    id                  UUID PRIMARY KEY,
    recipe_id           UUID NOT NULL REFERENCES production.recipes(id),
    version             INTEGER NOT NULL,
    status              VARCHAR(16) NOT NULL DEFAULT 'draft',       -- draft, published, superseded, archived
    yield_quantity       NUMERIC(18,6) NOT NULL CHECK (yield_quantity > 0),
    yield_unit_id         UUID NOT NULL,                             -- FK inventory.uom(id)
    yield_percentage       NUMERIC(5,2) NOT NULL DEFAULT 100.00,
    prep_time_seconds       INTEGER,
    computed_cost           BIGINT,                                  -- cached, minor units
    cost_computed_at        TIMESTAMPTZ,
    effective_from           TIMESTAMPTZ,
    published_by              UUID REFERENCES identity.users(id),
    instructions               JSONB,                                 -- localised prep steps
    reference_images            JSONB,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_recipe_version UNIQUE (recipe_id, version)
);

CREATE TABLE production.recipe_lines (
    id                  UUID PRIMARY KEY,
    recipe_version_id   UUID NOT NULL REFERENCES production.recipe_versions(id) ON DELETE CASCADE,
    sequence            SMALLINT NOT NULL,
    component_type       VARCHAR(16) NOT NULL,                        -- stock_item, sub_recipe
    component_id          UUID NOT NULL,
    quantity               NUMERIC(18,6) NOT NULL,
    unit_id                 UUID NOT NULL,
    wastage_percentage       NUMERIC(5,2) NOT NULL DEFAULT 0,
    is_optional               BOOLEAN NOT NULL DEFAULT false,
    substitute_group_id        UUID
);

CREATE TABLE production.substitute_groups (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                VARCHAR(120) NOT NULL
);

CREATE TABLE production.substitute_group_members (
    substitute_group_id UUID NOT NULL REFERENCES production.substitute_groups(id) ON DELETE CASCADE,
    stock_item_id        UUID NOT NULL,
    PRIMARY KEY (substitute_group_id, stock_item_id)
);

-- ============================================================================
-- 5. INVENTORY — Aggregates: StockItem, StockLevel, Batch, StockMovement,
--    CountSession  (SRS 7.3 #12-16, Chapter 11.2)
-- ============================================================================
CREATE TABLE inventory.uom (
    id                  UUID PRIMARY KEY,
    dimension           VARCHAR(16) NOT NULL,                        -- mass, volume, count, length, time
    code                VARCHAR(16) NOT NULL UNIQUE,                  -- g, kg, ml, l, pc, ...
    name                VARCHAR(64) NOT NULL,
    base_unit_of_dimension BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE inventory.uom_conversions (
    id                  UUID PRIMARY KEY,
    from_unit_id         UUID NOT NULL REFERENCES inventory.uom(id),
    to_unit_id             UUID NOT NULL REFERENCES inventory.uom(id),
    factor                  NUMERIC(20,10) NOT NULL,
    stock_item_id            UUID,                                    -- NULL = generic; set = item-specific density factor (BR-CORE-004)
    CONSTRAINT uq_uom_conv UNIQUE (from_unit_id, to_unit_id, stock_item_id)
);

CREATE TABLE inventory.packaging_units (
    id                  UUID PRIMARY KEY,
    stock_item_id         UUID NOT NULL,                              -- FK stock_items(id)
    supplier_id             UUID,                                     -- NULL = generic packaging
    name                     VARCHAR(64) NOT NULL,                    -- "carton of 12 x 1L"
    conversion_factor_to_base NUMERIC(20,6) NOT NULL
);

CREATE TABLE inventory.stock_items (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    sku                 VARCHAR(32) NOT NULL,
    names                JSONB NOT NULL,
    category_id            UUID,                                      -- self-referencing hierarchy table below
    base_unit_id             UUID NOT NULL REFERENCES inventory.uom(id), -- immutable after first movement
    recipe_unit_id             UUID REFERENCES inventory.uom(id),
    costing_method               VARCHAR(16) NOT NULL DEFAULT 'weighted_average', -- fifo, weighted_average, standard
    standard_cost                 BIGINT,                              -- used when costing_method = standard
    is_batch_tracked                BOOLEAN NOT NULL DEFAULT true,
    reorder_point                    NUMERIC(18,6),
    reorder_quantity                  NUMERIC(18,6),
    storage_requirements                JSONB,                          -- temperature, humidity, shelf life
    is_active                            BOOLEAN NOT NULL DEFAULT true,
    created_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_stock_item_sku UNIQUE (tenant_id, sku)
);

CREATE TABLE inventory.stock_item_categories (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    parent_id            UUID REFERENCES inventory.stock_item_categories(id),
    name                  VARCHAR(120) NOT NULL                        -- e.g. Food > Protein > Poultry
);

CREATE TABLE inventory.stock_batches (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    stock_item_id        UUID NOT NULL REFERENCES inventory.stock_items(id),
    location_id            UUID NOT NULL,                              -- branch, warehouse, or CK
    batch_number             VARCHAR(64),
    production_date            DATE,
    expiry_date                  DATE,
    quantity_received              NUMERIC(18,6) NOT NULL,
    quantity_remaining              NUMERIC(18,6) NOT NULL CHECK (quantity_remaining >= 0),
    unit_cost                        BIGINT NOT NULL,
    supplier_id                        UUID,
    goods_receipt_id                     UUID,
    created_at                            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_expiry_after_production CHECK (expiry_date IS NULL OR production_date IS NULL OR expiry_date >= production_date)
);

-- StockMovement: immutable append-only ledger (SRS 7.4.3 verbatim + 25.2 DDL)
CREATE TYPE inventory.movement_type_enum AS ENUM (
    'purchase_receipt','purchase_return','sale_depletion','sale_reversal',
    'transfer_out','transfer_in','production_input','production_output',
    'waste','count_adjustment','manual_adjustment','opening_balance','expiry_writeoff'
);

CREATE TABLE inventory.stock_movements (
    id                      UUID PRIMARY KEY,
    tenant_id               UUID NOT NULL,
    location_id             UUID NOT NULL,
    stock_item_id           UUID NOT NULL REFERENCES inventory.stock_items(id),
    batch_id                UUID REFERENCES inventory.stock_batches(id),
    movement_type            inventory.movement_type_enum NOT NULL,
    quantity                  NUMERIC(18,6) NOT NULL CHECK (quantity <> 0),   -- signed
    unit_id                    UUID NOT NULL REFERENCES inventory.uom(id),    -- always item's base unit
    unit_cost                    BIGINT NOT NULL,
    total_cost                    BIGINT NOT NULL,
    balance_after                  NUMERIC(18,6) NOT NULL,                    -- denormalised running balance
    reference_type                   VARCHAR(32) NOT NULL,                   -- order, goods_receipt, transfer, count, waste, production
    reference_id                       UUID NOT NULL,
    counterpart_movement_id              UUID REFERENCES inventory.stock_movements(id),
    occurred_at                            TIMESTAMPTZ NOT NULL,
    recorded_at                              TIMESTAMPTZ NOT NULL DEFAULT now(),
    performed_by                               UUID NOT NULL,
    reason_code_id                               UUID,
    notes                                          TEXT,
    CONSTRAINT ck_batch_required CHECK (
        movement_type NOT IN ('purchase_receipt','production_output') OR batch_id IS NOT NULL
    ),
    CONSTRAINT ck_reason_required CHECK (
        movement_type NOT IN ('waste','manual_adjustment') OR reason_code_id IS NOT NULL
    )
);


-- Append-only enforcement (BR-INV-001)

-- StockLevel: materialised projection over stock_movements (BR-INV-003)
CREATE TABLE inventory.stock_levels (
    stock_item_id           UUID NOT NULL REFERENCES inventory.stock_items(id),
    location_id              UUID NOT NULL,
    quantity_on_hand           NUMERIC(18,6) NOT NULL DEFAULT 0,
    quantity_reserved            NUMERIC(18,6) NOT NULL DEFAULT 0,   -- allocated to open orders/production
    average_cost                   BIGINT NOT NULL DEFAULT 0,
    last_movement_id                 UUID REFERENCES inventory.stock_movements(id),
    last_reconciled_at                TIMESTAMPTZ,
    PRIMARY KEY (stock_item_id, location_id)
);

CREATE TABLE inventory.stock_level_batch_allocations (
    stock_item_id           UUID NOT NULL,
    location_id               UUID NOT NULL,
    batch_id                   UUID NOT NULL REFERENCES inventory.stock_batches(id),
    quantity_allocated            NUMERIC(18,6) NOT NULL,
    PRIMARY KEY (stock_item_id, location_id, batch_id)
);

CREATE TABLE inventory.count_sessions (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    location_id         UUID NOT NULL,
    status               VARCHAR(16) NOT NULL DEFAULT 'in_progress', -- in_progress, posted, cancelled
    is_blind_count         BOOLEAN NOT NULL DEFAULT false,           -- locks expected qty
    started_by               UUID NOT NULL REFERENCES identity.users(id),
    started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at                    TIMESTAMPTZ,
    posted_by                      UUID REFERENCES identity.users(id)
);

CREATE TABLE inventory.count_lines (
    id                  UUID PRIMARY KEY,
    count_session_id     UUID NOT NULL REFERENCES inventory.count_sessions(id) ON DELETE CASCADE,
    stock_item_id           UUID NOT NULL REFERENCES inventory.stock_items(id),
    batch_id                   UUID REFERENCES inventory.stock_batches(id),
    expected_quantity            NUMERIC(18,6),
    counted_quantity                NUMERIC(18,6),
    variance                          NUMERIC(18,6),
    recount_of_line_id                  UUID REFERENCES inventory.count_lines(id)
);

CREATE TABLE inventory.waste_records (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    location_id         UUID NOT NULL,
    reason_code_id        UUID NOT NULL,
    total_value              BIGINT NOT NULL,
    requires_approval           BOOLEAN NOT NULL DEFAULT false,       -- above value threshold
    approval_request_id            UUID,
    recorded_by                      UUID NOT NULL REFERENCES identity.users(id),
    recorded_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory.waste_lines (
    id                  UUID PRIMARY KEY,
    waste_record_id      UUID NOT NULL REFERENCES inventory.waste_records(id) ON DELETE CASCADE,
    stock_item_id           UUID NOT NULL REFERENCES inventory.stock_items(id),
    batch_id                   UUID REFERENCES inventory.stock_batches(id),
    quantity                     NUMERIC(18,6) NOT NULL,
    unit_cost                      BIGINT NOT NULL
);

CREATE TABLE inventory.reason_codes (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    category            VARCHAR(16) NOT NULL,                        -- waste, adjustment
    code                VARCHAR(32) NOT NULL,
    label               JSONB NOT NULL
);

-- ============================================================================
-- 6. PROCUREMENT — Aggregates: Supplier, PurchaseRequisition, PurchaseOrder,
--    GoodsReceipt, SupplierInvoice  (SRS 7.3 #17-21)
-- ============================================================================
CREATE TABLE procurement.suppliers (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    code                VARCHAR(32) NOT NULL,
    name                VARCHAR(160) NOT NULL,
    payment_terms        JSONB,                                      -- net_days, credit_limit, etc.
    is_active               BOOLEAN NOT NULL DEFAULT true,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_supplier_code UNIQUE (tenant_id, code)
);

CREATE TABLE procurement.supplier_contacts (
    id                  UUID PRIMARY KEY,
    supplier_id         UUID NOT NULL REFERENCES procurement.suppliers(id) ON DELETE CASCADE,
    name                VARCHAR(120) NOT NULL,
    role                VARCHAR(64),
    phone               VARCHAR(24),
    email               VARCHAR(255)
);

CREATE TABLE procurement.supplier_item_prices (
    id                  UUID PRIMARY KEY,
    supplier_id         UUID NOT NULL REFERENCES procurement.suppliers(id),
    stock_item_id         UUID NOT NULL REFERENCES inventory.stock_items(id),
    packaging_unit_id       UUID REFERENCES inventory.packaging_units(id),
    price                     BIGINT NOT NULL,
    currency                   CHAR(3) NOT NULL,
    valid_from                   TIMESTAMPTZ,
    valid_to                       TIMESTAMPTZ,
    is_preferred                     BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE procurement.purchase_requisitions (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    branch_id           UUID NOT NULL,
    status               VARCHAR(16) NOT NULL DEFAULT 'draft',        -- draft, submitted, approved, rejected, converted
    requested_by           UUID NOT NULL REFERENCES identity.users(id),
    requested_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                        TEXT
);

CREATE TABLE procurement.requisition_lines (
    id                  UUID PRIMARY KEY,
    requisition_id       UUID NOT NULL REFERENCES procurement.purchase_requisitions(id) ON DELETE CASCADE,
    stock_item_id           UUID NOT NULL REFERENCES inventory.stock_items(id),
    quantity                   NUMERIC(18,6) NOT NULL,
    unit_id                       UUID NOT NULL REFERENCES inventory.uom(id)
);

CREATE TABLE procurement.purchase_orders (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    branch_id           UUID NOT NULL,
    supplier_id         UUID NOT NULL REFERENCES procurement.suppliers(id),
    requisition_id        UUID REFERENCES procurement.purchase_requisitions(id),
    status                  VARCHAR(16) NOT NULL DEFAULT 'draft',      -- draft, pending_approval, approved, sent, partially_received, received, closed, cancelled
    currency                  CHAR(3) NOT NULL,
    total_amount                BIGINT NOT NULL DEFAULT 0,
    created_by                    UUID NOT NULL REFERENCES identity.users(id),
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at                           TIMESTAMPTZ,
    CONSTRAINT ck_po_total_matches CHECK (true) -- total = Σ lines, enforced by app/trigger
);

CREATE TABLE procurement.po_lines (
    id                  UUID PRIMARY KEY,
    purchase_order_id    UUID NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE CASCADE,
    stock_item_id            UUID NOT NULL REFERENCES inventory.stock_items(id),
    quantity_ordered            NUMERIC(18,6) NOT NULL,
    unit_id                       UUID NOT NULL REFERENCES inventory.uom(id),
    unit_price                      BIGINT NOT NULL,
    line_total                        BIGINT NOT NULL
);

CREATE TABLE procurement.po_approval_chain (
    id                  UUID PRIMARY KEY,
    purchase_order_id    UUID NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE CASCADE,
    approver_id             UUID NOT NULL REFERENCES identity.users(id),
    sequence                  SMALLINT NOT NULL,
    decision                    VARCHAR(16),                          -- pending, approved, rejected
    decided_at                    TIMESTAMPTZ
);

CREATE TABLE procurement.goods_receipts (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    purchase_order_id   UUID NOT NULL REFERENCES procurement.purchase_orders(id),
    received_by            UUID NOT NULL REFERENCES identity.users(id),
    received_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    tolerance_exceeded            BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE procurement.receipt_lines (
    id                  UUID PRIMARY KEY,
    goods_receipt_id     UUID NOT NULL REFERENCES procurement.goods_receipts(id) ON DELETE CASCADE,
    po_line_id              UUID NOT NULL REFERENCES procurement.po_lines(id),
    quantity_received          NUMERIC(18,6) NOT NULL,
    unit_cost                    BIGINT NOT NULL
);

CREATE TABLE procurement.receipt_batch_assignments (
    receipt_line_id      UUID NOT NULL REFERENCES procurement.receipt_lines(id) ON DELETE CASCADE,
    batch_id                UUID NOT NULL REFERENCES inventory.stock_batches(id),
    quantity                   NUMERIC(18,6) NOT NULL,
    PRIMARY KEY (receipt_line_id, batch_id)
);

CREATE TABLE procurement.supplier_invoices (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    supplier_id         UUID NOT NULL REFERENCES procurement.suppliers(id),
    invoice_number       VARCHAR(64) NOT NULL,
    total_amount            BIGINT NOT NULL,
    currency                   CHAR(3) NOT NULL,
    match_status                  VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending, matched, exception
    payment_approval_status         VARCHAR(16) NOT NULL DEFAULT 'blocked',
    received_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE procurement.invoice_lines (
    id                  UUID PRIMARY KEY,
    supplier_invoice_id  UUID NOT NULL REFERENCES procurement.supplier_invoices(id) ON DELETE CASCADE,
    stock_item_id            UUID NOT NULL REFERENCES inventory.stock_items(id),
    quantity                    NUMERIC(18,6) NOT NULL,
    unit_price                     BIGINT NOT NULL,
    line_total                       BIGINT NOT NULL
);

CREATE TABLE procurement.invoice_match_results (
    id                  UUID PRIMARY KEY,
    supplier_invoice_id  UUID NOT NULL REFERENCES procurement.supplier_invoices(id) ON DELETE CASCADE,
    po_id                    UUID NOT NULL REFERENCES procurement.purchase_orders(id),
    goods_receipt_id            UUID NOT NULL REFERENCES procurement.goods_receipts(id),
    variance_amount                BIGINT NOT NULL DEFAULT 0,
    within_tolerance                 BOOLEAN NOT NULL DEFAULT true    -- three-way match result
);

-- ============================================================================
-- 7. SALES — Aggregate: Order  (SRS 7.3 #22, 7.4.1/7.4.2, 25.2 DDL)
-- ============================================================================
CREATE TYPE sales.order_type_enum AS ENUM ('dine_in','takeaway','delivery','drive_thru','pickup','aggregator');
CREATE TYPE sales.channel_enum    AS ENUM ('pos','kiosk','qr','aggregator','phone','api');
CREATE TYPE sales.order_state_enum AS ENUM (
    'draft','open','held','parked','partially_paid','completed','cancelled',
    'partially_refunded','refunded'
);
CREATE TYPE sync.state_enum AS ENUM ('local','pending','synced','conflicted');

CREATE TABLE sales.orders (
    id                      UUID PRIMARY KEY,
    tenant_id               UUID NOT NULL REFERENCES identity.tenants(id),
    branch_id               UUID NOT NULL REFERENCES org.branches(id),
    terminal_id             UUID NOT NULL REFERENCES identity.terminals(id),
    order_number            VARCHAR(24) NOT NULL,
    business_day            DATE NOT NULL,
    order_type              sales.order_type_enum NOT NULL,
    channel                 sales.channel_enum NOT NULL,
    state                   sales.order_state_enum NOT NULL,
    table_id                UUID REFERENCES org.tables(id),
    guest_count              SMALLINT CHECK (guest_count IS NULL OR guest_count > 0),
    customer_id                UUID REFERENCES crm.customers(id),
    opened_by                    UUID NOT NULL REFERENCES workforce.employees(id),
    served_by                      UUID REFERENCES workforce.employees(id),
    closed_by                        UUID REFERENCES workforce.employees(id),
    cash_session_id                    UUID REFERENCES treasury.cash_sessions(id),
    currency                             CHAR(3) NOT NULL,
    subtotal                               BIGINT NOT NULL DEFAULT 0,
    discount_total                           BIGINT NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
    service_charge_total                       BIGINT NOT NULL DEFAULT 0 CHECK (service_charge_total >= 0),
    tax_total                                    BIGINT NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
    rounding_adjustment                            BIGINT NOT NULL DEFAULT 0,
    grand_total                                      BIGINT NOT NULL DEFAULT 0,
    paid_total                                         BIGINT NOT NULL DEFAULT 0 CHECK (paid_total >= 0),
    tip_total                                            BIGINT NOT NULL DEFAULT 0 CHECK (tip_total >= 0),
    cogs_total                                             BIGINT,
    opened_at                                                TIMESTAMPTZ NOT NULL,
    first_fired_at                                             TIMESTAMPTZ,
    completed_at                                                 TIMESTAMPTZ,
    origin_device_time                                             TIMESTAMPTZ NOT NULL,
    hlc                                                              VARCHAR(48) NOT NULL,     -- hybrid logical clock
    sync_state                                                        sync.state_enum NOT NULL DEFAULT 'local',
    idempotency_key                                                     VARCHAR(80) NOT NULL,
    aggregator_ref                                                        VARCHAR(80),
    country_pack_version                                                    VARCHAR(24) NOT NULL,
    notes                                                                     TEXT,
    metadata                                                                   JSONB NOT NULL DEFAULT '{}'::jsonb,
    version                                                                      INTEGER NOT NULL DEFAULT 1,
    created_at                                                                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                                                                     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_order_number UNIQUE (branch_id, business_day, order_number),
    CONSTRAINT uq_idempotency  UNIQUE (tenant_id, idempotency_key),
    CONSTRAINT ck_dine_in_table CHECK (order_type <> 'dine_in' OR table_id IS NOT NULL),
    CONSTRAINT ck_completed     CHECK (state <> 'completed' OR completed_at IS NOT NULL)
);



CREATE TYPE sales.order_line_state_enum AS ENUM ('pending','fired','preparing','ready','served','voided','comped');

CREATE TABLE sales.order_lines (
    id                      UUID PRIMARY KEY,
    order_id                UUID NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
    sequence                 SMALLINT NOT NULL,
    menu_item_id                UUID NOT NULL,
    variant_id                    UUID NOT NULL,
    item_name_snapshot               JSONB NOT NULL,                 -- {"ar":"..","en":".."} captured at sale time
    quantity                           NUMERIC(12,3) NOT NULL,        -- supports fractional (0.5 kg)
    unit_price                           BIGINT NOT NULL,             -- before modifiers
    modifier_total                         BIGINT NOT NULL DEFAULT 0,
    line_discount                            BIGINT NOT NULL DEFAULT 0,
    line_subtotal                              BIGINT NOT NULL,
    tax_class_id                                 UUID NOT NULL,       -- snapshot of class at sale time
    tax_amount                                     BIGINT NOT NULL DEFAULT 0,
    line_total                                       BIGINT NOT NULL,
    unit_cost_snapshot                                 BIGINT,        -- recipe cost at sale time
    recipe_version_id                                    UUID,        -- which recipe version was consumed
    course                                                 SMALLINT,
    seat_number                                              SMALLINT,
    state                                                      sales.order_line_state_enum NOT NULL DEFAULT 'pending',
    fired_at                                                     TIMESTAMPTZ,
    ready_at                                                       TIMESTAMPTZ,
    void_reason_id                                                   UUID,         -- required when voided
    voided_by                                                          UUID,
    is_comp                                                              BOOLEAN NOT NULL DEFAULT false,
    notes                                                                  TEXT,
    business_day                                                           DATE NOT NULL DEFAULT CURRENT_DATE,
    CONSTRAINT ck_void_reason CHECK (state <> 'voided' OR void_reason_id IS NOT NULL)
); -- logically partitioned with parent via business_day in practice (see note below)

-- Note: order_lines is partitioned in lockstep with sales.orders by the same
-- business_day range via a denormalised business_day column + trigger, per
-- SRS 25.3 (partition key = business_day). Column added below:


CREATE TABLE sales.order_line_modifiers (
    id                  UUID PRIMARY KEY,
    order_line_id        UUID NOT NULL REFERENCES sales.order_lines(id) ON DELETE CASCADE,
    modifier_id             UUID NOT NULL,
    name_snapshot              JSONB NOT NULL,
    price_delta_snapshot          BIGINT NOT NULL,
    quantity                        SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE sales.order_discounts (
    id                  UUID PRIMARY KEY,
    order_id            UUID NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
    order_line_id        UUID REFERENCES sales.order_lines(id),       -- NULL = order-level discount
    discount_type            VARCHAR(16) NOT NULL,                    -- percentage, fixed, comp, promotion
    promotion_id                UUID,                                  -- FK crm.promotions(id)
    value                          BIGINT NOT NULL,
    reason_code_id                    UUID,
    approval_request_id                 UUID,                          -- FK governance.approval_requests(id)
    applied_by                            UUID NOT NULL REFERENCES identity.users(id),
    applied_at                              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales.service_charges (
    id                  UUID PRIMARY KEY,
    order_id            UUID NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
    charge_type          VARCHAR(24) NOT NULL,                        -- service, delivery_fee, packaging
    amount                 BIGINT NOT NULL,
    is_taxable                BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE sales.order_payments (
    id                  UUID PRIMARY KEY,
    order_id            UUID NOT NULL REFERENCES sales.orders(id) ON DELETE CASCADE,
    payment_method        VARCHAR(24) NOT NULL,                       -- cash, card, wallet, aggregator, voucher
    amount                   BIGINT NOT NULL,
    tip_amount                  BIGINT NOT NULL DEFAULT 0,
    tendered_amount               BIGINT,
    change_given                    BIGINT,
    cash_session_id                   UUID REFERENCES treasury.cash_sessions(id),
    payment_terminal_txn_ref             VARCHAR(80),
    processed_by                           UUID NOT NULL REFERENCES identity.users(id),
    processed_at                             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales.refunds (
    id                  UUID PRIMARY KEY,
    order_id            UUID NOT NULL REFERENCES sales.orders(id),
    order_payment_id      UUID REFERENCES sales.order_payments(id),
    amount                  BIGINT NOT NULL,
    reason_code_id             UUID NOT NULL,
    approval_request_id           UUID,
    processed_by                    UUID NOT NULL REFERENCES identity.users(id),
    processed_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 8. KITCHEN — Aggregates: Ticket, Station  (SRS 7.3 #23-24)
-- ============================================================================
CREATE TABLE kitchen.tickets (
    id                  UUID PRIMARY KEY,
    order_id            UUID NOT NULL REFERENCES sales.orders(id),
    station_id           UUID NOT NULL REFERENCES org.stations(id),
    status                 VARCHAR(16) NOT NULL DEFAULT 'queued',     -- queued, in_progress, bumped, recalled
    fired_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    bumped_at                  TIMESTAMPTZ,
    target_time_seconds          INTEGER
);

CREATE TABLE kitchen.ticket_lines (
    id                  UUID PRIMARY KEY,
    ticket_id            UUID NOT NULL REFERENCES kitchen.tickets(id) ON DELETE CASCADE,
    order_line_id           UUID NOT NULL REFERENCES sales.order_lines(id),
    status                     VARCHAR(16) NOT NULL DEFAULT 'queued'
);

-- ============================================================================
-- 9. WORKFORCE — Aggregates: Employee, Schedule, AttendanceRecord (SRS #25-27)
-- ============================================================================
CREATE TABLE workforce.employees (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    branch_id           UUID NOT NULL REFERENCES org.branches(id),
    user_id             UUID REFERENCES identity.users(id),           -- at most one User (nullable)
    full_name           VARCHAR(160) NOT NULL,
    job_title            VARCHAR(80),
    hire_date               DATE,
    termination_date          DATE,
    status                     VARCHAR(16) NOT NULL DEFAULT 'active',
    CONSTRAINT uq_employee_user UNIQUE (user_id)
);

CREATE TABLE workforce.employment_terms (
    id                  UUID PRIMARY KEY,
    employee_id         UUID NOT NULL REFERENCES workforce.employees(id) ON DELETE CASCADE,
    contract_type        VARCHAR(16) NOT NULL,                        -- full_time, part_time, hourly
    base_wage               BIGINT,
    wage_period                 VARCHAR(16),                          -- hourly, monthly
    effective_from                 DATE NOT NULL
);

CREATE TABLE workforce.certifications (
    id                  UUID PRIMARY KEY,
    employee_id         UUID NOT NULL REFERENCES workforce.employees(id) ON DELETE CASCADE,
    name                VARCHAR(120) NOT NULL,
    issued_at            DATE,
    expires_at              DATE
);

CREATE TABLE workforce.schedules (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id),
    week_starting        DATE NOT NULL,
    status                 VARCHAR(16) NOT NULL DEFAULT 'draft',      -- draft, published
    published_by             UUID REFERENCES identity.users(id),
    published_at               TIMESTAMPTZ
);

CREATE TABLE workforce.scheduled_shifts (
    id                  UUID PRIMARY KEY,
    schedule_id         UUID NOT NULL REFERENCES workforce.schedules(id) ON DELETE CASCADE,
    employee_id         UUID NOT NULL REFERENCES workforce.employees(id),
    starts_at            TIMESTAMPTZ NOT NULL,
    ends_at                 TIMESTAMPTZ NOT NULL,
    station_id                UUID REFERENCES org.stations(id),
    CONSTRAINT ck_shift_order CHECK (ends_at > starts_at)
    -- No-overlap-per-employee invariant enforced via EXCLUDE USING gist on (employee_id, tstzrange(starts_at, ends_at))
);

CREATE TABLE workforce.attendance_records (
    id                  UUID PRIMARY KEY,
    employee_id         UUID NOT NULL REFERENCES workforce.employees(id),
    scheduled_shift_id   UUID REFERENCES workforce.scheduled_shifts(id),
    clock_in_at          TIMESTAMPTZ NOT NULL,
    clock_out_at            TIMESTAMPTZ,
    CONSTRAINT ck_clockout_after_clockin CHECK (clock_out_at IS NULL OR clock_out_at > clock_in_at)
);

CREATE TABLE workforce.clock_events (
    id                  UUID PRIMARY KEY,
    attendance_record_id UUID NOT NULL REFERENCES workforce.attendance_records(id) ON DELETE CASCADE,
    event_type            VARCHAR(16) NOT NULL,                       -- clock_in, clock_out, break_start, break_end
    occurred_at              TIMESTAMPTZ NOT NULL,
    terminal_id                 UUID REFERENCES identity.terminals(id)
);

CREATE TABLE workforce.break_periods (
    id                  UUID PRIMARY KEY,
    attendance_record_id UUID NOT NULL REFERENCES workforce.attendance_records(id) ON DELETE CASCADE,
    starts_at             TIMESTAMPTZ NOT NULL,
    ends_at                  TIMESTAMPTZ
);

-- ============================================================================
-- 10. TREASURY — Aggregates: CashSession, DayClose, Expense (SRS #28-30)
-- ============================================================================
CREATE TABLE treasury.drawers (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id),
    name                VARCHAR(64) NOT NULL,
    terminal_id          UUID REFERENCES identity.terminals(id)
);

CREATE TABLE treasury.cash_sessions (
    id                  UUID PRIMARY KEY,
    drawer_id            UUID NOT NULL REFERENCES treasury.drawers(id),
    employee_id            UUID NOT NULL REFERENCES workforce.employees(id),
    opening_float             BIGINT NOT NULL,
    expected_closing             BIGINT,
    counted_closing                 BIGINT,
    variance                          BIGINT,
    status                              VARCHAR(16) NOT NULL DEFAULT 'open', -- open, closed
    opened_at                             TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at                               TIMESTAMPTZ,
    -- One open session per drawer invariant:
    CONSTRAINT uq_one_open_session UNIQUE (drawer_id, status) -- partial-unique via index below supersedes this in practice
);

CREATE TABLE treasury.cash_movements (
    id                  UUID PRIMARY KEY,
    cash_session_id      UUID NOT NULL REFERENCES treasury.cash_sessions(id) ON DELETE CASCADE,
    movement_type          VARCHAR(24) NOT NULL,                      -- sale, refund, paid_in, paid_out, tip_payout
    amount                    BIGINT NOT NULL,
    reference_type              VARCHAR(32),
    reference_id                   UUID,
    recorded_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE treasury.denominations (
    id                  UUID PRIMARY KEY,
    cash_session_id      UUID NOT NULL REFERENCES treasury.cash_sessions(id) ON DELETE CASCADE,
    denomination_value      BIGINT NOT NULL,                          -- e.g. 50000 = 500.00
    count                      INTEGER NOT NULL
);

CREATE TABLE treasury.reconciliations (
    id                  UUID PRIMARY KEY,
    cash_session_id      UUID NOT NULL REFERENCES treasury.cash_sessions(id),
    reconciled_by            UUID NOT NULL REFERENCES identity.users(id),
    reconciled_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                          TEXT
);

CREATE TABLE treasury.day_closes (
    id                  UUID PRIMARY KEY,
    branch_id           UUID NOT NULL REFERENCES org.branches(id),
    business_day         DATE NOT NULL,
    closed_by               UUID NOT NULL REFERENCES identity.users(id),
    closed_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_day_close UNIQUE (branch_id, business_day)
);

CREATE TABLE treasury.session_summaries (
    id                  UUID PRIMARY KEY,
    day_close_id         UUID NOT NULL REFERENCES treasury.day_closes(id) ON DELETE CASCADE,
    cash_session_id         UUID NOT NULL REFERENCES treasury.cash_sessions(id)
);

CREATE TABLE treasury.variance_reports (
    id                  UUID PRIMARY KEY,
    day_close_id         UUID NOT NULL REFERENCES treasury.day_closes(id) ON DELETE CASCADE,
    total_variance          BIGINT NOT NULL
);

CREATE TABLE treasury.expenses (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    branch_id           UUID NOT NULL,
    category             VARCHAR(64) NOT NULL,
    amount                  BIGINT NOT NULL,
    requires_approval          BOOLEAN NOT NULL DEFAULT false,
    approval_request_id           UUID,
    submitted_by                     UUID NOT NULL REFERENCES identity.users(id),
    submitted_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE treasury.expense_attachments (
    id                  UUID PRIMARY KEY,
    expense_id           UUID NOT NULL REFERENCES treasury.expenses(id) ON DELETE CASCADE,
    file_url                TEXT NOT NULL
);

-- ============================================================================
-- 11. CRM — Aggregates: Customer, Promotion  (SRS #32-33)
-- ============================================================================
CREATE TABLE crm.customers (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    phone               VARCHAR(24) NOT NULL,
    full_name           VARCHAR(160),
    email               VARCHAR(255),
    date_of_birth        DATE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_customer_phone UNIQUE (tenant_id, phone)
);

CREATE TABLE crm.customer_addresses (
    id                  UUID PRIMARY KEY,
    customer_id          UUID NOT NULL REFERENCES crm.customers(id) ON DELETE CASCADE,
    label                 VARCHAR(32),
    address_json             JSONB NOT NULL,
    is_default                  BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE crm.loyalty_accounts (
    id                  UUID PRIMARY KEY,
    customer_id          UUID NOT NULL UNIQUE REFERENCES crm.customers(id) ON DELETE CASCADE,
    points_balance          BIGINT NOT NULL DEFAULT 0,
    tier                       VARCHAR(32),
    enrolled_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crm.loyalty_transactions (
    id                  UUID PRIMARY KEY,
    loyalty_account_id   UUID NOT NULL REFERENCES crm.loyalty_accounts(id) ON DELETE CASCADE,
    transaction_type       VARCHAR(16) NOT NULL,                      -- earn, redeem, expire, adjust
    points                    BIGINT NOT NULL,
    order_id                     UUID REFERENCES sales.orders(id),
    occurred_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crm.consents (
    id                  UUID PRIMARY KEY,
    customer_id          UUID NOT NULL REFERENCES crm.customers(id) ON DELETE CASCADE,
    consent_type            VARCHAR(32) NOT NULL,                     -- marketing_sms, marketing_email, data_processing
    granted                    BOOLEAN NOT NULL,
    recorded_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE crm.promotions (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL REFERENCES identity.tenants(id),
    name                VARCHAR(120) NOT NULL,
    can_stack            BOOLEAN NOT NULL DEFAULT false,               -- cannot stack unless explicitly permitted
    status                 VARCHAR(16) NOT NULL DEFAULT 'active',
    starts_at                 TIMESTAMPTZ,
    ends_at                     TIMESTAMPTZ
);

CREATE TABLE crm.promotion_conditions (
    id                  UUID PRIMARY KEY,
    promotion_id         UUID NOT NULL REFERENCES crm.promotions(id) ON DELETE CASCADE,
    condition_type          VARCHAR(32) NOT NULL,                     -- min_spend, item_in_cart, channel, first_order
    condition_value             JSONB NOT NULL
);

CREATE TABLE crm.promotion_effects (
    id                  UUID PRIMARY KEY,
    promotion_id         UUID NOT NULL REFERENCES crm.promotions(id) ON DELETE CASCADE,
    effect_type              VARCHAR(32) NOT NULL,                    -- percent_off, fixed_off, free_item, bogo
    effect_value                 JSONB NOT NULL
);

CREATE TABLE crm.promotion_usage_limits (
    id                  UUID PRIMARY KEY,
    promotion_id         UUID NOT NULL REFERENCES crm.promotions(id) ON DELETE CASCADE,
    scope                   VARCHAR(16) NOT NULL,                     -- total, per_customer, per_day
    max_uses                   INTEGER NOT NULL,
    used_count                    INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- 12. FISCAL — Aggregates: CountryPack, TaxDocument  (SRS #34-35)
-- ============================================================================
CREATE TABLE fiscal.country_packs (
    code                VARCHAR(8) PRIMARY KEY,                       -- EG, SA, AE ...
    name                VARCHAR(80) NOT NULL,
    version               VARCHAR(24) NOT NULL,
    signature              BYTEA,
    is_active                 BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE fiscal.tax_classes (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    name                VARCHAR(64) NOT NULL,
    country_pack_code   VARCHAR(8) NOT NULL REFERENCES fiscal.country_packs(code)
);

CREATE TABLE fiscal.tax_rules (
    id                  UUID PRIMARY KEY,
    country_pack_code    VARCHAR(8) NOT NULL REFERENCES fiscal.country_packs(code),
    tax_class_id             UUID NOT NULL REFERENCES fiscal.tax_classes(id),
    rate                        NUMERIC(6,4) NOT NULL,                -- e.g. 0.1400 = 14%
    applies_to_order_type           VARCHAR(16),
    effective_from                     DATE NOT NULL,
    effective_to                          DATE
);

CREATE TABLE fiscal.invoice_templates (
    id                  UUID PRIMARY KEY,
    country_pack_code   VARCHAR(8) NOT NULL REFERENCES fiscal.country_packs(code),
    template_type        VARCHAR(24) NOT NULL,                        -- b2c_receipt, b2b_invoice
    layout_json              JSONB NOT NULL
);

CREATE TABLE fiscal.fiscal_configs (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    country_pack_code   VARCHAR(8) NOT NULL REFERENCES fiscal.country_packs(code),
    config_json          JSONB NOT NULL DEFAULT '{}'::jsonb            -- e.g. ZATCA/e-invoice credentials
);

CREATE TABLE fiscal.tax_documents (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    order_id            UUID NOT NULL REFERENCES sales.orders(id),
    document_type         VARCHAR(24) NOT NULL,                       -- receipt, tax_invoice, credit_note
    status                   VARCHAR(16) NOT NULL DEFAULT 'draft',    -- draft, issued, submitted, accepted, rejected
    issued_at                  TIMESTAMPTZ,
    is_immutable                  BOOLEAN NOT NULL DEFAULT false      -- immutable once submitted
);

CREATE TABLE fiscal.tax_document_lines (
    id                  UUID PRIMARY KEY,
    tax_document_id       UUID NOT NULL REFERENCES fiscal.tax_documents(id) ON DELETE CASCADE,
    order_line_id            UUID NOT NULL REFERENCES sales.order_lines(id),
    tax_amount                  BIGINT NOT NULL
);

CREATE TABLE fiscal.fiscal_submission_attempts (
    id                  UUID PRIMARY KEY,
    tax_document_id       UUID NOT NULL REFERENCES fiscal.tax_documents(id) ON DELETE CASCADE,
    attempted_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    response_code                VARCHAR(16),
    response_body                    JSONB
);

-- ============================================================================
-- 13. GOVERNANCE — Aggregates: ApprovalRequest, AuditEntry  (SRS #36-37, 25.2 DDL)
-- ============================================================================
CREATE TABLE governance.approval_requests (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    request_type         VARCHAR(32) NOT NULL,                        -- discount, void, refund, po, expense, waste
    entity_type              VARCHAR(48) NOT NULL,
    entity_id                   UUID NOT NULL,
    requested_by                   UUID NOT NULL REFERENCES identity.users(id),
    status                           VARCHAR(16) NOT NULL DEFAULT 'pending',
    created_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_requester_not_approver CHECK (true) -- requester <> approver enforced by app on decision insert
);

CREATE TABLE governance.approval_steps (
    id                  UUID PRIMARY KEY,
    approval_request_id  UUID NOT NULL REFERENCES governance.approval_requests(id) ON DELETE CASCADE,
    sequence               SMALLINT NOT NULL,
    approver_role_id          UUID REFERENCES identity.roles(id)
);

CREATE TABLE governance.approval_decisions (
    id                  UUID PRIMARY KEY,
    approval_step_id      UUID NOT NULL REFERENCES governance.approval_steps(id) ON DELETE CASCADE,
    approver_id              UUID NOT NULL REFERENCES identity.users(id),
    decision                    VARCHAR(16) NOT NULL,                 -- approved, rejected
    reason                         TEXT,
    decided_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_approver_not_requester CHECK (true) -- enforced by app: approver_id <> requests.requested_by
);

CREATE TABLE governance.anomaly_flags (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    flag_type            VARCHAR(48) NOT NULL,                        -- repeated_discount, void_pattern, cash_variance
    entity_type              VARCHAR(48) NOT NULL,
    entity_id                   UUID NOT NULL,
    severity                       VARCHAR(16) NOT NULL DEFAULT 'medium',
    raised_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at                        TIMESTAMPTZ
);

-- AuditEntry: hash-chained, append-only (SRS 25.2 verbatim)
CREATE TABLE governance.audit_entries (
    id                UUID PRIMARY KEY,
    tenant_id         UUID NOT NULL,
    branch_id         UUID,
    sequence_no       BIGINT NOT NULL,
    occurred_at       TIMESTAMPTZ NOT NULL,
    recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id          UUID,
    actor_type        VARCHAR(16) NOT NULL,
    impersonated_by   UUID,
    action            VARCHAR(80) NOT NULL,
    entity_type       VARCHAR(48) NOT NULL,
    entity_id         UUID,
    before_state      JSONB,
    after_state       JSONB,
    reason_code       VARCHAR(48),
    reason_text       TEXT,
    approver_id       UUID,
    approval_id       UUID,
    ip_address        INET,
    user_agent        TEXT,
    terminal_id       UUID,
    correlation_id    UUID NOT NULL,
    causation_id      UUID,
    entry_hash        BYTEA NOT NULL,
    previous_hash     BYTEA,
    CONSTRAINT uq_audit_sequence UNIQUE (tenant_id, sequence_no)
);



-- ============================================================================
-- 14. CENTRAL KITCHEN — Aggregates: ProductionOrder, DistributionOrder (#38-39)
-- ============================================================================
CREATE TABLE ck.production_orders (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    central_kitchen_id   UUID NOT NULL REFERENCES org.central_kitchens(id),
    recipe_version_id      UUID NOT NULL REFERENCES production.recipe_versions(id),
    planned_quantity          NUMERIC(18,6) NOT NULL,
    status                      VARCHAR(16) NOT NULL DEFAULT 'planned', -- planned, in_progress, completed, cancelled
    scheduled_for                  DATE,
    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ck.production_lines (
    id                  UUID PRIMARY KEY,
    production_order_id   UUID NOT NULL REFERENCES ck.production_orders(id) ON DELETE CASCADE,
    stock_item_id            UUID NOT NULL REFERENCES inventory.stock_items(id),
    quantity_consumed           NUMERIC(18,6) NOT NULL
);

CREATE TABLE ck.output_batches (
    id                  UUID PRIMARY KEY,
    production_order_id  UUID NOT NULL REFERENCES ck.production_orders(id) ON DELETE CASCADE,
    batch_id                UUID NOT NULL REFERENCES inventory.stock_batches(id),
    quantity_produced           NUMERIC(18,6) NOT NULL,
    CONSTRAINT ck_output_le_theoretical CHECK (true) -- output <= theoretical yield + tolerance, enforced by app
);

CREATE TABLE ck.distribution_orders (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    production_order_id  UUID REFERENCES ck.production_orders(id),
    source_location_id      UUID NOT NULL,
    status                     VARCHAR(16) NOT NULL DEFAULT 'planned', -- planned, dispatched, received
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ck.distribution_lines (
    id                  UUID PRIMARY KEY,
    distribution_order_id UUID NOT NULL REFERENCES ck.distribution_orders(id) ON DELETE CASCADE,
    destination_branch_id    UUID NOT NULL REFERENCES org.branches(id),
    stock_item_id                UUID NOT NULL REFERENCES inventory.stock_items(id),
    quantity                        NUMERIC(18,6) NOT NULL
    -- Sum of distributions <= produced quantity, enforced by app/trigger
);

-- ============================================================================
-- 15. SYNC — Aggregate: SyncBatch  (SRS #40, Chapter 21 Offline Sync)
-- ============================================================================
CREATE TABLE sync.sync_batches (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    terminal_id          UUID NOT NULL REFERENCES identity.terminals(id),
    batch_key             VARCHAR(80) NOT NULL,                       -- idempotent by batch key
    status                   VARCHAR(16) NOT NULL DEFAULT 'received', -- received, applied, conflicted, failed
    received_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at                    TIMESTAMPTZ,
    CONSTRAINT uq_sync_batch_key UNIQUE (tenant_id, batch_key)
);

CREATE TABLE sync.sync_operations (
    id                  UUID PRIMARY KEY,
    sync_batch_id         UUID NOT NULL REFERENCES sync.sync_batches(id) ON DELETE CASCADE,
    entity_type              VARCHAR(48) NOT NULL,
    entity_id                   UUID NOT NULL,
    operation                     VARCHAR(16) NOT NULL,                -- create, update
    hlc                              VARCHAR(48) NOT NULL,
    payload                            JSONB NOT NULL,
    created_at                           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sync.idempotency_keys (
    key                 VARCHAR(80) PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    response_snapshot      JSONB
);

CREATE TABLE sync.conflict_records (
    id                  UUID PRIMARY KEY,
    sync_operation_id    UUID NOT NULL REFERENCES sync.sync_operations(id),
    conflict_type            VARCHAR(32) NOT NULL,                    -- concurrent_update, deleted_remote, constraint_violation
    resolution_strategy          VARCHAR(32),                         -- lww, manual, merge
    resolved_at                     TIMESTAMPTZ,
    resolved_by                        UUID REFERENCES identity.users(id)
);

CREATE TABLE sync.device_state (
    terminal_id         UUID PRIMARY KEY REFERENCES identity.terminals(id),
    last_sync_hlc        VARCHAR(48),
    last_sync_at            TIMESTAMPTZ,
    pending_operation_count    INTEGER NOT NULL DEFAULT 0
);

-- ============================================================================
-- 16. PLATFORM — cross-cutting: outbox, jobs, notifications, feature flags
-- ============================================================================
CREATE TABLE platform.outbox (
    id              UUID PRIMARY KEY,
    tenant_id       UUID NOT NULL,
    topic           VARCHAR(80) NOT NULL,
    payload         JSONB NOT NULL,
    headers         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts        SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at    TIMESTAMPTZ
);

CREATE TABLE platform.jobs (
    id                  UUID PRIMARY KEY,
    job_type            VARCHAR(64) NOT NULL,
    payload              JSONB NOT NULL,
    status                 VARCHAR(16) NOT NULL DEFAULT 'queued',
    scheduled_for             TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at                TIMESTAMPTZ
);

CREATE TABLE platform.notifications (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    user_id              UUID REFERENCES identity.users(id),
    channel                VARCHAR(16) NOT NULL,                      -- push, email, sms, in_app
    payload                  JSONB NOT NULL,
    sent_at                     TIMESTAMPTZ,
    read_at                       TIMESTAMPTZ
);

CREATE TABLE platform.feature_flags (
    key                 VARCHAR(80) PRIMARY KEY,
    description         TEXT,
    default_enabled     BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE platform.tenant_feature_flags (
    tenant_id           UUID NOT NULL,
    flag_key            VARCHAR(80) NOT NULL REFERENCES platform.feature_flags(key),
    is_enabled          BOOLEAN NOT NULL,
    PRIMARY KEY (tenant_id, flag_key)
);

CREATE TABLE platform.migrations (
    id                  VARCHAR(64) PRIMARY KEY,
    applied_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 17. ANALYTICS — star schema for reporting (Chapter 19 / 25.1)
-- ============================================================================
CREATE TABLE analytics.dim_date (
    date_key            DATE PRIMARY KEY,
    year                SMALLINT NOT NULL,
    month               SMALLINT NOT NULL,
    day                 SMALLINT NOT NULL,
    day_of_week         SMALLINT NOT NULL,
    is_ramadan          BOOLEAN NOT NULL DEFAULT false,
    is_public_holiday   BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE analytics.dim_item (
    menu_item_id        UUID PRIMARY KEY,
    variant_id           UUID,
    category_name         VARCHAR(120),
    current_name            VARCHAR(160)
);

CREATE TABLE analytics.dim_branch (
    branch_id           UUID PRIMARY KEY,
    brand_name          VARCHAR(120),
    branch_name         VARCHAR(120),
    country_code        CHAR(2)
);

CREATE TABLE analytics.fact_sales_line (
    id                  UUID PRIMARY KEY,
    date_key             DATE NOT NULL REFERENCES analytics.dim_date(date_key),
    branch_id             UUID NOT NULL REFERENCES analytics.dim_branch(branch_id),
    menu_item_id            UUID NOT NULL REFERENCES analytics.dim_item(menu_item_id),
    order_id                  UUID NOT NULL,
    order_line_id                UUID NOT NULL,
    quantity                       NUMERIC(12,3) NOT NULL,
    revenue                          BIGINT NOT NULL,
    cogs                               BIGINT,
    discount                             BIGINT NOT NULL DEFAULT 0,
    tax                                    BIGINT NOT NULL DEFAULT 0
);


CREATE TABLE analytics.rollup_daily_branch_summary (
    branch_id           UUID NOT NULL,
    date_key             DATE NOT NULL,
    gross_sales            BIGINT NOT NULL DEFAULT 0,
    net_sales                 BIGINT NOT NULL DEFAULT 0,
    cogs                         BIGINT NOT NULL DEFAULT 0,
    order_count                     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, date_key)
);

-- ============================================================================
-- END OF SCRIPT
-- ============================================================================
