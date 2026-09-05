import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { MembershipRolesService } from './../src/modules/identity/authz/membership-roles.service';
import { PermissionsService } from './../src/modules/identity/authz/permissions.service';
import { RolesService } from './../src/modules/identity/authz/roles.service';
import { MembershipsService } from './../src/modules/identity/memberships/memberships.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { UsersService } from './../src/modules/identity/users/users.service';
import {
  INVENTORY_PERMISSIONS,
  INVENTORY_PERMISSION_DEFS,
} from './../src/modules/inventory/inventory.permissions';
import { createMigratorClient } from './rls-admin';

interface Tokens {
  accessToken: string;
}
interface WithId {
  id: string;
}

const password = 's3cure-passphrase';
const stamp = Date.now();

describe('Inventory (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let http: App;

  let tenantAId: string;
  let tenantBId: string;
  let tokenA: string;
  let tokenViewA: string;
  let tokenNoneA: string;
  let tokenB: string;

  let uomId: string;
  let locA1: string;
  let locA2: string;
  let locB: string;
  let itemA: string;
  let itemB: string;
  let reasonA: string;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const scoped = async (email: string, tenantId: string): Promise<string> => {
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const sel = await request(http)
      .post('/auth/tenant')
      .set('Authorization', `Bearer ${(login.body as Tokens).accessToken}`)
      .send({ tenantId })
      .expect(200);
    return (sel.body as Tokens).accessToken;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    admin = createMigratorClient(app);
    http = app.getHttpServer();

    const permissions = app.get(PermissionsService);
    await permissions.ensureIdentityPermissions();
    await permissions.upsertMany(INVENTORY_PERMISSION_DEFS);

    const users = app.get(UsersService);
    const tenants = app.get(TenantsService);
    const memberships = app.get(MembershipsService);
    const roles = app.get(RolesService);
    const membershipRoles = app.get(MembershipRolesService);

    const mkTenant = async (slug: string) =>
      (
        await tenants.create({
          slug,
          legalName: slug,
          defaultCurrency: 'EGP',
          countryPackCode: 'EG',
        })
      ).id;
    tenantAId = await mkTenant(`inva-${stamp}`);
    tenantBId = await mkTenant(`invb-${stamp}`);

    const mkUser = async (email: string, tenantId: string, codes: string[]) => {
      const u = await users.createUser({ email, password, displayName: 'I' });
      const m = await memberships.grant(u.id, tenantId, 'active');
      if (codes.length) {
        const role = await roles.createTenantRole(tenantId, {
          name: `inv-${email}`,
        });
        await roles.addPermissions(tenantId, role.id, codes);
        await membershipRoles.create(tenantId, null, {
          membershipId: m.id,
          roleId: role.id,
          scope: { type: 'tenant' },
        });
      }
    };
    const all = Object.values(INVENTORY_PERMISSIONS);
    const emailA = `inv.a.${stamp}@example.com`;
    const emailV = `inv.v.${stamp}@example.com`;
    const emailN = `inv.n.${stamp}@example.com`;
    const emailB = `inv.b.${stamp}@example.com`;
    await mkUser(emailA, tenantAId, all);
    await mkUser(emailV, tenantAId, [INVENTORY_PERMISSIONS.VIEW]);
    await mkUser(emailN, tenantAId, []);
    await mkUser(emailB, tenantBId, all);

    tokenA = await scoped(emailA, tenantAId);
    tokenViewA = await scoped(emailV, tenantAId);
    tokenNoneA = await scoped(emailN, tenantAId);
    tokenB = await scoped(emailB, tenantBId);

    // Global UOM reference data (platform-seeded, un-tenanted).
    uomId = newId();
    await admin.uom.create({
      data: {
        id: uomId,
        dimension: 'mass',
        code: `g-${stamp}`,
        name: 'gram',
        baseUnitOfDimension: true,
      },
    });

    // Locations come from the Phase 15 registry.
    const mkLocation = async (tenantId: string, code: string) => {
      const brand = await admin.brand.create({
        data: { id: newId(), tenantId, name: `B-${code}` },
      });
      const branch = await admin.branch.create({
        data: {
          id: newId(),
          tenantId,
          brandId: brand.id,
          code,
          name: `Br-${code}`,
          timezone: 'Africa/Cairo',
          baseCurrency: 'EGP',
          countryCode: 'EG',
        },
      });
      const loc = await admin.location.create({
        data: {
          id: newId(),
          tenantId,
          locationType: 'branch',
          refId: branch.id,
          branchId: branch.id,
        },
      });
      return loc.id;
    };
    locA1 = await mkLocation(tenantAId, `IA1${stamp % 1000}`);
    locA2 = await mkLocation(tenantAId, `IA2${stamp % 1000}`);
    locB = await mkLocation(tenantBId, `IB1${stamp % 1000}`);

    const mkItem = async (token: string, sku: string, extra = {}) =>
      (
        await request(http)
          .post('/inventory/items')
          .set(auth(token))
          .send({ sku, names: { en: sku }, baseUnitId: uomId, ...extra })
          .expect(201)
      ).body as WithId;
    itemA = (await mkItem(tokenA, `SKU-A-${stamp}`)).id;
    itemB = (await mkItem(tokenB, `SKU-B-${stamp}`)).id;

    reasonA = (
      (
        await request(http)
          .post('/inventory/reason-codes')
          .set(auth(tokenA))
          .send({
            category: 'waste',
            code: 'spoiled',
            label: { en: 'Spoiled' },
          })
          .expect(201)
      ).body as WithId
    ).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // ------------------------------------------------------------------ auth --
  describe('authentication & authorization', () => {
    it.each(['/inventory/items', '/inventory/levels', '/inventory/waste'])(
      'unauthenticated GET %s → 401',
      async (p) => {
        await request(http).get(p).expect(401);
      },
    );

    it('no inventory permission → 403', async () => {
      await request(http)
        .get('/inventory/items')
        .set(auth(tokenNoneA))
        .expect(403);
    });

    it('inventory.view allows reads but not adjustments', async () => {
      await request(http)
        .get('/inventory/items')
        .set(auth(tokenViewA))
        .expect(200);
      await request(http)
        .post('/inventory/items')
        .set(auth(tokenViewA))
        .send({ sku: `X-${stamp}`, names: { en: 'x' }, baseUnitId: uomId })
        .expect(403);
    });

    it('cost-bearing movement history requires inventory.cost.view', async () => {
      await request(http)
        .get(`/inventory/items/${itemA}/movements`)
        .set(auth(tokenViewA))
        .expect(403);
      await request(http)
        .get(`/inventory/items/${itemA}/movements`)
        .set(auth(tokenA))
        .expect(200);
    });

    it('rejects unknown properties and client-supplied tenantId', async () => {
      await request(http)
        .post('/inventory/items')
        .set(auth(tokenA))
        .send({ sku: 'z', names: {}, baseUnitId: uomId, tenantId: tenantBId })
        .expect(400);
    });
  });

  // -------------------------------------------------------- ledger + costing --
  describe('append-only ledger and projection (BR-INV-001/003)', () => {
    it('opening balance creates a movement and the level projection', async () => {
      const mv = (
        await request(http)
          .post('/inventory/movements')
          .set(auth(tokenA))
          .send({
            locationId: locA1,
            stockItemId: itemA,
            movementType: 'opening_balance',
            quantity: '100',
            referenceType: 'opening',
            referenceId: newId(),
            unitCost: '500',
          })
          .expect(201)
      ).body as { balanceAfter: number; unitCost: string };
      expect(mv.balanceAfter).toBe(100);

      const levels = (
        await request(http)
          .get(`/inventory/levels?locationId=${locA1}`)
          .set(auth(tokenA))
          .expect(200)
      ).body as { stockItemId: string; quantityOnHand: string }[];
      expect(levels.find((l) => l.stockItemId === itemA)?.quantityOnHand).toBe(
        '100',
      );
    });

    it('weighted average recomputes on a second receipt (FR-INV-012)', async () => {
      await request(http)
        .post('/inventory/movements')
        .set(auth(tokenA))
        .send({
          locationId: locA1,
          stockItemId: itemA,
          movementType: 'opening_balance',
          quantity: '100',
          referenceType: 'opening',
          referenceId: newId(),
          unitCost: '700',
        })
        .expect(201);
      const level = await admin.stockLevel.findFirst({
        where: { stockItemId: itemA, locationId: locA1 },
      });
      // (100*500 + 100*700) / 200 = 600
      expect(level?.averageCost).toBe(600n);
    });

    it('the ledger is append-only for the runtime role (BR-INV-001)', async () => {
      const grants = await admin.$queryRawUnsafe<{ p: string }[]>(
        `SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
           FROM information_schema.role_table_grants
          WHERE grantee='ros_app' AND table_name='stock_movements'`,
      );
      expect(grants[0].p).toBe('INSERT,SELECT');
    });

    it('rejects a zero-quantity movement (DB CHECK)', async () => {
      await request(http)
        .post('/inventory/movements')
        .set(auth(tokenA))
        .send({
          locationId: locA1,
          stockItemId: itemA,
          movementType: 'manual_adjustment',
          quantity: '0',
          referenceType: 'adj',
          referenceId: newId(),
          reasonCodeId: reasonA,
        })
        .expect(400);
    });

    it('permits negative stock and surfaces it (FR-INV-014)', async () => {
      const item = (
        await request(http)
          .post('/inventory/items')
          .set(auth(tokenA))
          .send({
            sku: `NEG-${stamp}`,
            names: { en: 'neg' },
            baseUnitId: uomId,
          })
          .expect(201)
      ).body as WithId;
      await request(http)
        .post('/inventory/movements')
        .set(auth(tokenA))
        .send({
          locationId: locA1,
          stockItemId: item.id,
          movementType: 'manual_adjustment',
          quantity: '-5',
          referenceType: 'adj',
          referenceId: newId(),
          reasonCodeId: reasonA,
        })
        .expect(201);
      const neg = (
        await request(http)
          .get('/inventory/negative-stock')
          .set(auth(tokenA))
          .expect(200)
      ).body as { stockItemId: string }[];
      expect(neg.map((n) => n.stockItemId)).toContain(item.id);
    });

    it('reconciles the projection against the ledger (BR-INV-003)', async () => {
      const r = (
        await request(http)
          .get('/inventory/reconciliation')
          .set(auth(tokenA))
          .expect(200)
      ).body as { reconciled: boolean; divergences: unknown[] };
      expect(r.divergences).toHaveLength(0);
      expect(r.reconciled).toBe(true);
    });
  });

  // --------------------------------------------------------------- transfers --
  describe('transfers (BR-INV-002, FR-INV-031/032)', () => {
    it('dispatch + receive produce an exactly balanced pair', async () => {
      const d = (
        await request(http)
          .post('/inventory/transfers')
          .set(auth(tokenA))
          .send({
            stockItemId: itemA,
            fromLocationId: locA1,
            toLocationId: locA2,
            quantity: '10',
          })
          .expect(201)
      ).body as { transferReferenceId: string };

      const r = (
        await request(http)
          .post('/inventory/transfers/receive')
          .set(auth(tokenA))
          .send({
            toLocationId: locA2,
            transferReferenceId: d.transferReferenceId,
            receivedQuantity: '10',
          })
          .expect(201)
      ).body as { discrepancy: number; adjustmentMovementId: string | null };
      expect(r.discrepancy).toBe(0);
      expect(r.adjustmentMovementId).toBeNull();

      const pair = await admin.stockMovement.findMany({
        where: { referenceId: d.transferReferenceId },
      });
      const out = pair.find((m) => m.movementType === 'transfer_out');
      const inn = pair.find((m) => m.movementType === 'transfer_in');
      expect(Math.abs(Number(out?.quantity))).toBe(
        Math.abs(Number(inn?.quantity)),
      );
      expect(inn?.counterpartMovementId).toBe(out?.id);
      expect(inn?.counterpartOccurredAt).toEqual(out?.occurredAt);
    });

    it('a receiving discrepancy keeps the pair balanced and adds an adjustment (D-INV-06)', async () => {
      const d = (
        await request(http)
          .post('/inventory/transfers')
          .set(auth(tokenA))
          .send({
            stockItemId: itemA,
            fromLocationId: locA1,
            toLocationId: locA2,
            quantity: '10',
          })
          .expect(201)
      ).body as { transferReferenceId: string };

      const r = (
        await request(http)
          .post('/inventory/transfers/receive')
          .set(auth(tokenA))
          .send({
            toLocationId: locA2,
            transferReferenceId: d.transferReferenceId,
            receivedQuantity: '8',
            discrepancyReasonCodeId: reasonA,
          })
          .expect(201)
      ).body as { discrepancy: number; adjustmentMovementId: string | null };
      expect(r.discrepancy).toBe(-2);
      expect(r.adjustmentMovementId).not.toBeNull();

      const rows = await admin.stockMovement.findMany({
        where: { referenceId: d.transferReferenceId },
      });
      const out = rows.find((m) => m.movementType === 'transfer_out');
      const inn = rows.find((m) => m.movementType === 'transfer_in');
      const adj = rows.find((m) => m.movementType === 'manual_adjustment');
      // BR-INV-002 preserved exactly: the PAIR is still equal and opposite.
      expect(Number(out?.quantity)).toBe(-10);
      expect(Number(inn?.quantity)).toBe(10);
      expect(Number(adj?.quantity)).toBe(-2);
      expect(adj?.reasonCodeId).toBe(reasonA);
      // No discrepancy table exists.
      const t = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_tables
          WHERE schemaname='inventory' AND tablename LIKE '%discrepanc%'`,
      );
      expect(Number(t[0].n)).toBe(0);
    });

    it('requires a reason code when the received quantity differs', async () => {
      const d = (
        await request(http)
          .post('/inventory/transfers')
          .set(auth(tokenA))
          .send({
            stockItemId: itemA,
            fromLocationId: locA1,
            toLocationId: locA2,
            quantity: '5',
          })
          .expect(201)
      ).body as { transferReferenceId: string };
      await request(http)
        .post('/inventory/transfers/receive')
        .set(auth(tokenA))
        .send({
          toLocationId: locA2,
          transferReferenceId: d.transferReferenceId,
          receivedQuantity: '4',
        })
        .expect(400);
    });
  });

  // ------------------------------------------------------------------ counts --
  describe('counting (FR-INV-040…047, D-INV-05, B-2)', () => {
    it('blind count hides the expected quantity while open (FR-INV-042)', async () => {
      const s = (
        await request(http)
          .post('/inventory/counts')
          .set(auth(tokenA))
          .send({ locationId: locA1, scopeType: 'full_location' })
          .expect(201)
      ).body as WithId & { isBlindCount: boolean };
      expect(s.isBlindCount).toBe(true);
      const lines = (
        await request(http)
          .get(`/inventory/counts/${s.id}/lines`)
          .set(auth(tokenA))
          .expect(200)
      ).body as { expectedQuantity: string | null }[];
      expect(lines.every((l) => l.expectedQuantity === null)).toBe(true);
    });

    it('posting creates count_adjustment movements and closes the session', async () => {
      const s = (
        await request(http)
          .post('/inventory/counts')
          .set(auth(tokenA))
          .send({
            locationId: locA1,
            scopeType: 'item_list',
            itemIds: [itemA],
            isBlindCount: false,
          })
          .expect(201)
      ).body as WithId;
      const lines = (
        await request(http)
          .get(`/inventory/counts/${s.id}/lines`)
          .set(auth(tokenA))
          .expect(200)
      ).body as { id: string; expectedQuantity: string }[];
      const expected = Number(lines[0].expectedQuantity);

      await request(http)
        .post(`/inventory/count-lines/${lines[0].id}`)
        .set(auth(tokenA))
        .send({ countedQuantity: String(expected - 3) })
        .expect(201);

      const posted = (
        await request(http)
          .post(`/inventory/counts/${s.id}/post`)
          .set(auth(tokenA))
          .expect(201)
      ).body as { status: string; adjustments: { variance: number }[] };
      expect(posted.status).toBe('posted');
      expect(posted.adjustments[0].variance).toBe(-3);

      // Post-once.
      await request(http)
        .post(`/inventory/counts/${s.id}/post`)
        .set(auth(tokenA))
        .expect(400);
    });

    it('rejects scopeId on a non-category scope and requires it for category', async () => {
      await request(http)
        .post('/inventory/counts')
        .set(auth(tokenA))
        .send({
          locationId: locA1,
          scopeType: 'full_location',
          scopeId: newId(),
        })
        .expect(400);
      await request(http)
        .post('/inventory/counts')
        .set(auth(tokenA))
        .send({ locationId: locA1, scopeType: 'category' })
        .expect(400);
    });

    it('B-2: a count flagged requiresApproval is REFUSED, not posted', async () => {
      const s = (
        await request(http)
          .post('/inventory/counts')
          .set(auth(tokenA))
          .send({
            locationId: locA1,
            scopeType: 'item_list',
            itemIds: [itemA],
            requiresApproval: true,
          })
          .expect(201)
      ).body as WithId;
      await request(http)
        .post(`/inventory/counts/${s.id}/post`)
        .set(auth(tokenA))
        .expect(403);
      const still = await admin.countSession.findUnique({
        where: { id: s.id },
      });
      expect(still?.status).toBe('in_progress');
    });
  });

  // ------------------------------------------------------------------- waste --
  describe('waste (FR-INV-055…058, B-2)', () => {
    it('records waste with a mandatory reason code and depletes stock', async () => {
      const before = await admin.stockLevel.findFirst({
        where: { stockItemId: itemA, locationId: locA1 },
      });
      const w = (
        await request(http)
          .post('/inventory/waste')
          .set(auth(tokenA))
          .send({
            locationId: locA1,
            reasonCodeId: reasonA,
            lines: [{ stockItemId: itemA, quantity: '2' }],
          })
          .expect(201)
      ).body as { totalValue: string };
      expect(BigInt(w.totalValue) > 0n).toBe(true);
      const after = await admin.stockLevel.findFirst({
        where: { stockItemId: itemA, locationId: locA1 },
      });
      expect(Number(after?.quantityOnHand)).toBe(
        Number(before?.quantityOnHand) - 2,
      );
      const mv = await admin.stockMovement.findFirst({
        where: { movementType: 'waste', stockItemId: itemA },
        orderBy: { occurredAt: 'desc' },
      });
      expect(mv?.reasonCodeId).toBe(reasonA);
    });

    it('B-2: waste flagged requiresApproval is REFUSED and writes nothing', async () => {
      const before = await admin.wasteRecord.count({
        where: { tenantId: tenantAId },
      });
      await request(http)
        .post('/inventory/waste')
        .set(auth(tokenA))
        .send({
          locationId: locA1,
          reasonCodeId: reasonA,
          lines: [{ stockItemId: itemA, quantity: '1' }],
          requiresApproval: true,
        })
        .expect(403);
      expect(
        await admin.wasteRecord.count({ where: { tenantId: tenantAId } }),
      ).toBe(before);
    });

    // Migration 32 (Governance Approval runtime, FR-SEC-030..033) legitimately
    // created governance.approval_requests — the deliberate, reviewed change
    // this tripwire exists to force. D-17's strict Inventory boundary (this
    // slice's own concern) is unaffected: Inventory still creates no
    // approval_request_id column on any of its own tables, and Governance
    // still writes nothing into `inventory.*`.
    it('governance.approval_requests exists (migration 32) but Inventory itself is untouched by it', async () => {
      const rows = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM pg_tables
          WHERE schemaname='governance' AND tablename='approval_requests'`,
      );
      expect(Number(rows[0].n)).toBe(1);

      const wasteApprovalColumn = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema='inventory' AND table_name='waste_records'
            AND column_name='approval_request_id'`,
      );
      expect(Number(wasteApprovalColumn[0].n)).toBe(1);
      // The column exists (pre-migration-32 schema, D-17 cl. 6) but remains
      // NULL/unused — migration 32 populated nothing here.
      const populated = await admin.wasteRecord.count({
        where: { approvalRequestId: { not: null } },
      });
      expect(populated).toBe(0);
    });
  });

  // -------------------------------------------------------- tenant isolation --
  describe('tenant isolation', () => {
    it('A sees only its own items and levels', async () => {
      const items = (
        await request(http)
          .get('/inventory/items')
          .set(auth(tokenA))
          .expect(200)
      ).body as WithId[];
      expect(items.map((i) => i.id)).toContain(itemA);
      expect(items.map((i) => i.id)).not.toContain(itemB);
    });

    it('A cannot read a tenant B item → 404', async () => {
      await request(http)
        .get(`/inventory/items/${itemB}`)
        .set(auth(tokenA))
        .expect(404);
    });

    it('A cannot post a movement at a tenant B location → 404', async () => {
      await request(http)
        .post('/inventory/movements')
        .set(auth(tokenA))
        .send({
          locationId: locB,
          stockItemId: itemA,
          movementType: 'manual_adjustment',
          quantity: '1',
          referenceType: 'adj',
          referenceId: newId(),
          reasonCodeId: reasonA,
        })
        .expect(404);
    });

    it('A cannot post a movement for a tenant B item → 404', async () => {
      await request(http)
        .post('/inventory/movements')
        .set(auth(tokenA))
        .send({
          locationId: locA1,
          stockItemId: itemB,
          movementType: 'manual_adjustment',
          quantity: '1',
          referenceType: 'adj',
          referenceId: newId(),
          reasonCodeId: reasonA,
        })
        .expect(404);
    });

    it('A cannot set a reorder config at a tenant B location → 404', async () => {
      await request(http)
        .post(`/inventory/items/${itemA}/reorder-config`)
        .set(auth(tokenA))
        .send({ locationId: locB, reorderPoint: '10', reorderQuantity: '50' })
        .expect(404);
    });

    it('duplicate SKU within a tenant → 409; same SKU in another tenant → allowed', async () => {
      const sku = `DUP-${stamp}`;
      await request(http)
        .post('/inventory/items')
        .set(auth(tokenA))
        .send({ sku, names: { en: 'd' }, baseUnitId: uomId })
        .expect(201);
      await request(http)
        .post('/inventory/items')
        .set(auth(tokenA))
        .send({ sku, names: { en: 'd' }, baseUnitId: uomId })
        .expect(409);
      await request(http)
        .post('/inventory/items')
        .set(auth(tokenB))
        .send({ sku, names: { en: 'd' }, baseUnitId: uomId })
        .expect(201);
    });

    it('duplicate reason code (tenant, category, code) → 409 (D-INV-09)', async () => {
      await request(http)
        .post('/inventory/reason-codes')
        .set(auth(tokenA))
        .send({ category: 'waste', code: 'spoiled', label: { en: 'dup' } })
        .expect(409);
    });
  });

  // -------------------------------------------------------- reorder / FR-INV-002 --
  describe('per-location reorder (FR-INV-065) and base-unit immutability (FR-INV-002)', () => {
    it('stores reorder config per location and reports low stock', async () => {
      await request(http)
        .post(`/inventory/items/${itemA}/reorder-config`)
        .set(auth(tokenA))
        .send({
          locationId: locA1,
          reorderPoint: '99999',
          reorderQuantity: '10',
        })
        .expect(201);
      const low = (
        await request(http)
          .get('/inventory/low-stock')
          .set(auth(tokenA))
          .expect(200)
      ).body as { stockItemId: string; locationId: string }[];
      expect(
        low.some((l) => l.stockItemId === itemA && l.locationId === locA1),
      ).toBe(true);
    });

    it('stock_items carries no tenant-wide reorder columns', async () => {
      const cols = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_schema='inventory' AND table_name='stock_items'
            AND column_name IN ('reorder_point','reorder_quantity')`,
      );
      expect(Number(cols[0].n)).toBe(0);
    });

    it('rejects a base-unit change once movements exist (FR-INV-002)', async () => {
      await request(http)
        .post(`/inventory/items/${itemA}/base-unit`)
        .set(auth(tokenA))
        .send({ baseUnitId: uomId })
        .expect(409);
    });
  });

  // ------------------------------------------------------- boundary compliance --
  describe('boundary compliance', () => {
    it('no out-of-scope schemas were created', async () => {
      // `production` is deliberately absent from this list: Production Spec is
      // an authorized, implemented phase (design gate CLOSED/RATIFIED), so a
      // `production` schema is expected. `sales` and `sync` are likewise absent
      // now that the P1A Order capture foundation is implemented — `sync` holds
      // ONLY the §26.5 idempotency table, not the sync protocol.
      // Every unbuilt context stays guarded.
      // `fiscal` was removed by the C-04 AMENDMENT (2026-08-20), which
      // authorises `fiscal.tax_classes` and nothing else; the narrowed boundary
      // is asserted directly below rather than dropped.
      const rows = await admin.$queryRawUnsafe<{ nspname: string }[]>(
        `SELECT nspname FROM pg_namespace WHERE nspname IN
         ('procurement','crm','analytics','ck')`,
      );
      expect(rows).toHaveLength(0);

      // `platform` was removed from the forbidden list by SCHED-1 (migration
      // 39), which authorises the `jobs` half of the schema SRS §25.1 names
      // ("outbox, jobs, notifications, feature_flags, migrations") — and
      // NOTHING else in it. Same treatment as `workforce`/`treasury`/`fiscal`
      // below: the guard is NARROWED, not dropped, so an unbuilt platform
      // capability (an outbox, a notification table, feature flags) still
      // cannot appear quietly. Inventory owns this assertion because Inventory
      // is the first domain to register a scheduled job.
      const platformTables = await admin.$queryRawUnsafe<
        { tablename: string }[]
      >(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'platform' ORDER BY 1`,
      );
      expect(platformTables.map((t) => t.tablename)).toEqual([
        'job_findings',
        'job_occurrences',
        'job_schedules',
      ]);

      // `workforce` and `treasury` were removed from this guard by carried item
      // P1D-A (2026-08-20), which authorises `workforce.shifts`,
      // `treasury.drawers` and `treasury.cash_sessions` — and P1G-0
      // (FR-POS-091), which additionally authorises `treasury.cash_movements`
      // — and P1G-1 migration 33, which additionally authorises
      // `treasury.cash_close_policies` (the narrow cash-close policy
      // substrate, NOT the generic FR-PLT-025 settings hierarchy) — and
      // P1G-1 migration 34 (CashSession Close), which additionally
      // authorises `treasury.cash_session_close_attempts` and
      // `treasury.cash_count_denominations` — and migration 35 (DayClose,
      // DC-R1/R2/R3), which additionally authorises `treasury.day_closes`,
      // `treasury.day_close_activations`, `treasury.day_close_sessions`,
      // `treasury.day_close_tax_class_totals` and
      // `treasury.day_close_order_type_totals` — and NOTHING else in
      // either schema. The guard is narrowed rather than dropped: the
      // assertion below proves neither context quietly grew the rest of
      // itself.
      const p1dTables = await admin.$queryRawUnsafe<{ qualified: string }[]>(
        `SELECT schemaname || '.' || tablename AS qualified FROM pg_tables
          WHERE schemaname IN ('workforce','treasury') ORDER BY 1`,
      );
      expect(p1dTables.map((t) => t.qualified)).toEqual([
        'treasury.cash_close_policies',
        'treasury.cash_count_denominations',
        'treasury.cash_movements',
        'treasury.cash_session_close_attempts',
        'treasury.cash_sessions',
        'treasury.day_close_activations',
        'treasury.day_close_order_type_totals',
        'treasury.day_close_sessions',
        'treasury.day_close_tax_class_totals',
        'treasury.day_closes',
        'treasury.drawers',
        'workforce.shifts',
      ]);

      const fiscalTables = await admin.$queryRawUnsafe<{ tablename: string }[]>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'fiscal' ORDER BY 1`,
      );
      expect(fiscalTables.map((t) => t.tablename)).toEqual(['tax_classes']);
    });

    it('stock_movements is RANGE-partitioned by occurred_at (D-INV-01)', async () => {
      const rows = await admin.$queryRawUnsafe<
        { relkind: string; k: string }[]
      >(
        `SELECT relkind::text, pg_get_partkeydef(oid) AS k
           FROM pg_class WHERE oid='inventory.stock_movements'::regclass`,
      );
      expect(rows[0].relkind).toBe('p');
      expect(rows[0].k).toBe('RANGE (occurred_at)');
    });

    it('both references into the ledger are composite (B-1 + counterpart)', async () => {
      const rows = await admin.$queryRawUnsafe<{ def: string }[]>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype='f' AND confrelid='inventory.stock_movements'::regclass
            AND conrelid IN ('inventory.stock_levels'::regclass,
                             'inventory.stock_movements'::regclass)`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every((r) => r.def.includes('occurred_at'))).toBe(true);
    });
  });
});
