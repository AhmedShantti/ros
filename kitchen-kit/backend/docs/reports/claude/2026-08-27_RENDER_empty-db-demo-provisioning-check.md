# Render Empty-DB Demo Provisioning — Safety Check & One-Time Command

**Report type:** Audit/readiness report (read-only investigation; no product code, no migration, no governance change, no commit, no push, no execution against any database)
**Authority statement:** This report is non-authoritative evidence. The SRS (`ROS_SRS_v1.0.pdf`) and the ratified entries in `docs/governance/GOVERNANCE_DECISION_REGISTER.md` remain the sole authority for requirements and architecture decisions. Nothing in this document creates, amends, or ratifies governance.
**Date:** 2026-08-27
**HEAD:** `9aa7a880229938bffd2d5dc0dfcb3d263da060e8`
**Branch:** `feat/production-spec`
**Working tree summary:** unchanged by this task — pre-existing local modifications (`prisma.config.ts`, `prisma/schema.prisma`, several `src/modules/**` files, `docs/api/openapi.*`, `docs/reports/claude/INDEX.md`) all predate this session and were not touched. No file was written except this report and its `INDEX.md` entry. No command was executed against any remote/Render database.
**Task identifier:** Determine the exact safe one-time procedure to provision the currently-empty Render PostgreSQL database (`ros_backend_db`: `identity.users`/`tenants`/`memberships`/`roles` all `0` rows) for Dashboard/demo use, using only the existing seed script — analysis only, per explicit instruction not to write product code, create migrations, change governance, commit, push, or modify `prisma.config.ts`.

---

## Answers

### 1. Is `src/scripts/seed-dev-data.ts` idempotent?

Not idempotent in the strict sense (it never checks for or reuses existing rows), but it **is safe to re-run**: every entity it creates is scoped under a `Date.now()`-suffixed tenant slug and user emails (`dev-demo-${stamp}`, `owner.${stamp}@example.com`, `cashier.${stamp}@example.com`). Each run therefore creates a **new, independent tenant** rather than colliding with a prior run's rows. Confirmed directly from the file (`src/scripts/seed-dev-data.ts:93,107-124`) and from its own header comment (lines 50-67): *"Safe to re-run: tenant/user emails are timestamp-suffixed, so each run creates a fresh, independent tenant rather than colliding with a previous run."*

### 2. Does it DELETE/TRUNCATE/reset any existing data?

No. Full-file read confirms zero `delete`, `deleteMany`, `truncate`, or raw destructive SQL anywhere in the script. Every call is a `create`/`upsert`/service-level provisioning call (`permissions.upsertMany`, `tenants.create`, `users.createUser`, `memberships.grant`, `roles.createTenantRole`, `roles.addPermissions`, `membershipRoles.assign`, `brands.create`, `branches.create`, `terminals.register`, `employees.create`, `pins.setPin`, `menus.create/assignBranch`, `categories.create`, `menuItems.create/place/addVariant`, `priceLists.create/setPriceEntry/activate`). `PermissionsService.upsertMany` (`permissions.service.ts:15-31`) is an explicit upsert-by-code, itself annotated "safe to run repeatedly."

### 3. Can it safely run against an empty Render DB?

Yes, structurally. It requires no pre-existing rows in any table — it creates the permission catalog, tenant, users, roles, memberships, brand, branch, terminal, employee, PIN, and one catalogue item from nothing. It does presuppose the **schema already exists** (tables present), which the Render evidence in the task already confirms (queries against `identity.users`/`tenants`/`memberships`/`roles` returned `0`, not "relation does not exist") — so no `prisma migrate deploy` step is needed for this task.

### 4. Which DB connection does it use: `DATABASE_URL`, `APP_DATABASE_URL`, or both?

**Functionally, only `APP_DATABASE_URL`.** The script boots the full Nest app (`NestFactory.create(AppModule)`), and every actual query it issues goes through `PrismaService`, whose constructor reads `config.getOrThrow<string>('APP_DATABASE_URL')` exclusively (`src/prisma/prisma.service.ts:32-39`) — it never references `DATABASE_URL`. `DATABASE_URL` is still **required to be present** because Nest's `ConfigModule` validates the full `EnvironmentVariables` class at boot (`src/config/env.validation.ts:29`, `DATABASE_URL!: string`), and an unset/missing value throws before the app starts — but its actual connection string is never dialed by the seed run. `DATABASE_URL` is dialed only by `prisma.config.ts` (Prisma CLI / `prisma migrate deploy`), which this task does not need to run.

### 5. Does it create tenant / dashboard user / membership / roles / role assignment / branch / terminal / employee+PIN / catalogue / tax classes?

| Entity | Created by seed? | Evidence |
|---|---|---|
| Tenant | Yes | `seed-dev-data.ts:107-112` (`countryPackCode: 'EG'`, `defaultCurrency: 'EGP'`) |
| Dashboard user (owner) | Yes | `seed-dev-data.ts:115-119` — password login user |
| Dashboard user (cashier) | Yes | `seed-dev-data.ts:120-124` |
| Membership | Yes | `seed-dev-data.ts:126-135` (owner + cashier, `active`) |
| System/application permission catalog | Yes | `seed-dev-data.ts:96-104` (`permissions.upsertMany`, all 7 modules) |
| Tenant roles + role assignment | Yes | `seed-dev-data.ts:138-170` (`Owner` role = every permission; `Cashier` role = order create/fire/void-prefire + catalogue read) — **note:** these are tenant-scoped roles created by the app, not platform/system roles (see Q7) |
| Branch (+ brand) | Yes | `seed-dev-data.ts:173-183` |
| Terminal | Yes | `seed-dev-data.ts:186-190` (`POS-1`) |
| Employee + PIN | Yes | `seed-dev-data.ts:193-199` (`EMP001`, PIN `1234`) |
| Catalogue/demo items | Yes | `seed-dev-data.ts:208-237` (menu, category, one menu item + variant, price list, activated) |
| Tax classes | **Indirect, conditional** | Not created by the seed script directly. `TenantsService.create` (`tenants.service.ts:39-58`) calls `TaxClassProvisioningService.provisionForTenant` immediately after tenant creation, **best-effort**: if the `EG` Country Pack is not active in the registry at that exact moment, provisioning silently yields zero tax classes for that tenant permanently (per `docs/reports/claude/2026-08-26_RENDER_country-pack-order-create-unblock.md`, §I) — the tenant is still created either way. This does not block dashboard login or Q1-5 provisioning; it only affects whether `POST /orders` can compute tax on the seeded item. |

### 6. What exact demo email/password does the existing seed define?

Both dashboard logins use the same fixed password constant; only the email differs per run (timestamp-suffixed). No hash or private secret is reproduced here — these are the plaintext values the script itself sets:

- Password (both accounts): `DevPass123!` (`DEV_PASSWORD`, `seed-dev-data.ts:69`)
- Owner email pattern: `owner.<timestamp>@example.com`
- Cashier email email pattern: `cashier.<timestamp>@example.com`
- Cashier PIN (POS login only, not the dashboard): `1234` (`DEV_PIN`, `seed-dev-data.ts:70`)

The exact email is only known after the run — it is printed to stdout (`console.log(`Owner login: ${owner.email} / ${DEV_PASSWORD}`)`) and written to a local `credentials.md` (`seed-dev-data.ts:346-353`), which is `.gitignore`d dev output, never committed.

### 7. Does role/bootstrap data come from migrations or from the seed? Why is `identity.roles = 0` on the live DB?

**From the seed (or an equivalent app-level call), not from any migration.** `grep`-ing every `prisma/migrations/*/migration.sql` file for `INSERT INTO` statements touching roles found none — the only DML in migrations is schema DDL, `GRANT`/RLS policy setup, and one unrelated `INSERT INTO` in `20260816180000_org_location_registry` (organisation location data, not roles). The `roles` table (`prisma/schema.prisma:273-291`) has no default/seed rows in the schema itself; every row is created at runtime via `RolesService.createTenantRole` (`roles.service.ts:26-49`, tenant-scoped, `isSystem: false`) or, for a platform/system role, would require a different, not-yet-invoked path — `roles.service.ts:28` comment: *"isSystem is always false (system roles are seeded by the migration role)"* describes an intended future mechanism, not one that exists in any committed migration today. The only caller of `createTenantRole` in this repository (outside tests) is `seed-dev-data.ts`. **Conclusion:** `identity.roles = 0` on Render is the expected, correct state of a schema-migrated-but-never-seeded database — it is not a bug, missing migration, or data loss; nothing has ever called the role-creation path against that database.

---

## Verdict: seed is safe and non-destructive — proceed

All four required conditions hold: additive-only, safe to re-run, requires no pre-existing data, and touches only the RLS-constrained runtime connection. No blocker found. Below is the one-time procedure.

## One-time provisioning command

Run this **once**, from the `kitchen-kit/backend` directory of your local clone, against Render's database. **Not executed by this session.**

```bash
DATABASE_URL="<RENDER_EXTERNAL_OWNER_DB_URL>" \
APP_DATABASE_URL="<RENDER_EXTERNAL_APP_ROLE_DB_URL>" \
node dist/scripts/seed-dev-data.js
```

Notes on the two variables, both from repo evidence (see Q4 and `docs/reports/claude/2026-08-25_RENDER_identity-rls-default-privileges-unblock.md`, `src/prisma/prisma.service.ts:32-39`, `prisma/migrations/20260812145207_identity_rls/migration.sql:17-28`):

- **`APP_DATABASE_URL` is the one that actually matters for this command** — it is the only connection string the seed script dials. It must point at Render's `ros_backend_db`, using whichever role Render's already-applied `identity_rls` migration granted table privileges to (that migration's own comments name it `ros_app` — a non-superuser, RLS-constrained runtime role; confirm the actual role name your Render setup uses before running, since this session has no Render dashboard access and cannot confirm it). **Do not** use a role name containing `ros_migrator` here — `env.validation.ts:145-148` rejects that combination outright in production mode (`NODE_ENV=production` triggers `assertProductionHardened`, which throws if `APP_DATABASE_URL` matches `/ros_migrator/`).
- **`DATABASE_URL`** is only required to satisfy Nest's env-validation gate at boot (must be a non-empty, non-placeholder string) — the seed script itself never connects with it, since it doesn't run `prisma migrate`. Setting it to Render's owner/admin connection string (the same one used for `prisma migrate deploy`) is the correct, safe choice anyway: it's the value the app expects in every other environment, keeps this command's env consistent with production config, and needs no DDL/admin action to actually occur for this to work.
- Both values are Render's own `ros_backend_db` — **never** localhost, **never** the persistent local `ros`/`ros-postgres` dev database. Do not put either value in a committed file; pass them as inline env vars for this one command only (as above), or export them in your own shell session and unset them after.
- Confirm `NODE_ENV` is **not** left unset as `production` unless you intend Render's production-hardening checks (`assertProductionHardened`) to run — they will reject a `JWT_ACCESS_SECRET`/`DATABASE_URL`/`APP_DATABASE_URL` that still contains a placeholder-looking value, which is a safety feature, not a blocker, as long as Render's real values don't match that pattern.
- If you'd rather not rely on the compiled `dist/` output (e.g. it's stale), the equivalent uncompiled form is:
  ```bash
  DATABASE_URL="<RENDER_EXTERNAL_OWNER_DB_URL>" \
  APP_DATABASE_URL="<RENDER_EXTERNAL_APP_ROLE_DB_URL>" \
  npx ts-node -r tsconfig-paths/register src/scripts/seed-dev-data.ts
  ```
  (mirrors the pattern already used for `sign-country-pack.ts` in the prior Render report — no build step, same env-var contract.)

This command creates rows only — it never issues `DELETE`/`TRUNCATE`/`DROP`, so re-running it again later (e.g. to get a second demo tenant) is equally safe; it will simply add another timestamp-suffixed tenant rather than touching the first.

## Read-only verification SQL (run after provisioning)

```sql
-- Tenants
SELECT id, slug, legal_name, default_currency, country_pack_code, status, created_at
FROM identity.tenants
ORDER BY created_at DESC;

-- Dashboard user email (owner + cashier)
SELECT id, email, display_name, created_at
FROM identity.users
ORDER BY created_at DESC;

-- Memberships
SELECT m.id, m.user_id, m.tenant_id, m.status, u.email
FROM identity.memberships m
JOIN identity.users u ON u.id = m.user_id
ORDER BY m.created_at DESC;

-- Assigned roles
SELECT r.name AS role_name, r.tenant_id, u.email, mr.membership_id
FROM identity.membership_roles mr
JOIN identity.roles r ON r.id = mr.role_id
JOIN identity.memberships m ON m.id = mr.membership_id
JOIN identity.users u ON u.id = m.user_id
ORDER BY u.email;

-- Branches
SELECT id, tenant_id, brand_id, code, name, country_code, base_currency
FROM org.branches
ORDER BY created_at DESC;

-- Employees
SELECT id, tenant_id, code, display_name, home_branch_id, user_id
FROM identity.employees
ORDER BY created_at DESC;

-- Terminals
SELECT id, tenant_id, branch_id, name, terminal_type
FROM identity.terminals
ORDER BY created_at DESC;
```

(Schema-qualified table names taken from `prisma/schema.prisma` `@@map`/`@@schema` attributes for `Tenant`, `User`, `Membership`, `Role`, `MembershipRole`, `Branch`, `Employee`, `Terminal` — adjust only if your Render schema search_path differs from the committed migrations.)

## Expected `POST /auth/login` request after provisioning

Use the **owner** account (full permissions) for dashboard admin/config access. Substitute the exact email printed by the seed run (or read back from `SELECT email FROM identity.users ORDER BY created_at DESC LIMIT 2;` above):

```bash
curl -X POST https://<your-render-service-host>/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner.<timestamp>@example.com","password":"DevPass123!"}'
```

Followed by tenant selection (required before any tenant-scoped dashboard route — see `seed-dev-data.ts:280-283`):

```bash
curl -X POST https://<your-render-service-host>/auth/tenant \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"<tenant id from SELECT above>"}'
```

## Residual notes — not blockers for this task, reported for completeness

- Whether `POST /orders` succeeds after login depends on the **separate**, already-reported Country Pack activation task (`docs/reports/claude/2026-08-26_RENDER_country-pack-order-create-unblock.md`) — `COUNTRY_PACK_DIR`/`COUNTRY_PACK_TRUST_MANIFEST` env vars and a redeploy. That is independent of identity/dashboard-login provisioning covered here; login and every non-order dashboard route work without it.
- This session could not confirm Render's actual `ros_app`/`ros_migrator` role names or connection strings (no Render dashboard/API access) — the placeholders above must be filled in by the user from Render's own environment configuration.
- `prisma.config.ts`'s current uncommitted local diff (`process.env["DATABASE_URL"]` → `env("DATABASE_URL")`, the `prisma/config` package's own env accessor) is a cosmetic/equivalent change, not the `APP_DATABASE_URL` substitution flagged as a residual blocker in the 2026-08-26 report — that concern does not apply to the file's current state. Not modified by this task per instruction.
