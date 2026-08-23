import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { newId } from './../src/common/ids';
import { PrismaClient } from './../src/generated/prisma/client';
import { PrismaService } from './../src/prisma/prisma.service';
import { TenantsService } from './../src/modules/identity/tenants/tenants.service';
import { CountryPackService } from './../src/modules/localisation/country-pack/country-pack.service';
import {
  COUNTRY_PACK_SIGNATURE_VERIFIER,
  COUNTRY_PACK_TRUST_STORE,
  Ed25519CountryPackSignatureVerifier,
} from './../src/modules/localisation/country-pack/country-pack.signature';
import {
  generateReleaseKey,
  signPackDocument,
  trustStoreFor,
} from './../src/modules/localisation/country-pack/country-pack.signing.fixture';
import { TaxClassService } from './../src/modules/localisation/tax/tax-class.service';
import { createMigratorClient } from './rls-admin';

/**
 * `fiscal.tax_classes` — tenant isolation and identity immutability.
 *
 * Every negative assertion carries a POSITIVE CONTROL, so a zero result proves
 * filtering rather than absent data. That discipline is what caught the
 * Inventory partition bypass, and it is applied here from the start.
 */

const stamp = Date.now();
const RELEASE_KEY = generateReleaseKey('tc-release-key');
const TRUST = trustStoreFor(RELEASE_KEY.trusted());

const packDoc = (code: string) =>
  signPackDocument(
    {
      code,
      version: '2026.1',
      effectiveFrom: '2026-01-01',
      currency: { code: 'EGP', exponent: 2, cashRounding: { enabled: false } },
      tax: {
        engine: 'vat_standard',
        pricingMode: 'tax_exclusive',
        computationLevel: 'line',
        roundingMode: 'HALF_UP',
        roundingPrecision: 2,
        classes: [
          { code: 'standard', rate: '14.0', label: { en: 'Standard' } },
          { code: 'zero', rate: '0.0' },
          { code: 'exempt', rate: null },
        ],
        serviceChargeTaxable: true,
        orderTypeOverrides: [],
      },
    },
    RELEASE_KEY,
  );

describe('fiscal.tax_classes (e2e)', () => {
  let app: INestApplication<App>;
  let admin: PrismaClient;
  let prisma: PrismaService;
  let taxClasses: TaxClassService;

  let tenantA: string;
  let tenantB: string;
  let classA: string;
  let classB: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(COUNTRY_PACK_TRUST_STORE)
      .useValue(TRUST)
      .overrideProvider(COUNTRY_PACK_SIGNATURE_VERIFIER)
      .useValue(new Ed25519CountryPackSignatureVerifier(TRUST))
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    admin = createMigratorClient(app);
    prisma = app.get(PrismaService);
    taxClasses = app.get(TaxClassService);

    await app.get(CountryPackService).activate(packDoc('EG'));

    const tenants = app.get(TenantsService);
    tenantA = (
      await tenants.create({
        slug: `tca-${stamp}`,
        legalName: 'TCA',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;
    tenantB = (
      await tenants.create({
        slug: `tcb-${stamp}`,
        legalName: 'TCB',
        defaultCurrency: 'EGP',
        countryPackCode: 'EG',
      })
    ).id;

    classA = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantA, code: 'standard' },
      })
    ).id;
    classB = (
      await admin.taxClass.findFirstOrThrow({
        where: { tenantId: tenantB, code: 'standard' },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await admin.$disconnect();
    await app.close();
  }, 30_000);

  describe('provisioning from a verified pack', () => {
    it('materialises one identity per pack class, per tenant', async () => {
      const rows = await admin.taxClass.findMany({
        where: { tenantId: tenantA, countryPackCode: 'EG' },
        orderBy: { code: 'asc' },
      });
      expect(rows.map((r) => r.code)).toEqual(['exempt', 'standard', 'zero']);
      expect(rows.every((r) => r.isActive)).toBe(true);
    });

    it('carries the pack label, and NO rate of any kind', async () => {
      const row = await admin.taxClass.findFirstOrThrow({
        where: { id: classA },
      });
      expect(row.names).toEqual({ en: 'Standard' });
      // The identity must never learn what it costs. Checked as an exact column
      // set rather than a substring search, so it cannot pass by accident.
      expect(Object.keys(row).sort()).toEqual([
        'code',
        'countryPackCode',
        'createdAt',
        'id',
        'isActive',
        'names',
        'tenantId',
      ]);
    });

    it('lets two tenants hold the SAME semantic code independently', async () => {
      expect(classA).not.toBe(classB);
      const a = await admin.taxClass.findFirstOrThrow({
        where: { id: classA },
      });
      const b = await admin.taxClass.findFirstOrThrow({
        where: { id: classB },
      });
      expect(a.code).toBe(b.code);
      expect(a.tenantId).not.toBe(b.tenantId);
    });

    it('is idempotent and NEVER re-issues an existing id', async () => {
      const pack = app.get(CountryPackService).requirePinned('EG', '2026.1');
      const first = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
        taxClasses.ensureFromPack(tx, tenantA, pack),
      );
      const second = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
        taxClasses.ensureFromPack(tx, tenantA, pack),
      );
      expect(second.get('standard')).toBe(first.get('standard'));
      expect(second.get('standard')).toBe(classA);

      const rows = await admin.taxClass.count({
        where: { tenantId: tenantA, countryPackCode: 'EG' },
      });
      expect(rows).toBe(3);
    });

    it('refuses a duplicate semantic code within one tenant and jurisdiction', async () => {
      await expect(
        admin.taxClass.create({
          data: {
            id: newId(),
            tenantId: tenantA,
            countryPackCode: 'EG',
            code: 'standard',
            names: { en: 'Duplicate' },
          },
        }),
      ).rejects.toThrow();
    });

    it('refuses a malformed semantic code at the DATABASE', async () => {
      for (const code of ['Standard', 'zero rated', '1st', '']) {
        await expect(
          admin.taxClass.create({
            data: {
              id: newId(),
              tenantId: tenantA,
              countryPackCode: 'EG',
              code,
              names: { en: 'Bad' },
            },
          }),
        ).rejects.toThrow();
      }
    });
  });

  describe('the semantic identity is immutable to the runtime role', () => {
    it('refuses a `code` change by ros_app', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE fiscal.tax_classes SET code = 'reduced' WHERE id = $1`,
            classA,
          ),
        ),
      ).rejects.toThrow();

      // Positive control: the identity is untouched.
      const row = await admin.taxClass.findFirstOrThrow({
        where: { id: classA },
      });
      expect(row.code).toBe('standard');
    });

    it('refuses a `country_pack_code` change by ros_app', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE fiscal.tax_classes SET country_pack_code = 'SA' WHERE id = $1`,
            classA,
          ),
        ),
      ).rejects.toThrow();
    });

    it('refuses a `tenant_id` change by ros_app', async () => {
      await expect(
        prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE fiscal.tax_classes SET tenant_id = $2 WHERE id = $1`,
            classA,
            tenantB,
          ),
        ),
      ).rejects.toThrow();
    });

    it('ALLOWS the display label to change', async () => {
      await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
        tx.taxClass.update({
          where: { id: classA },
          data: { names: { en: 'Standard rate' } },
        }),
      );
      const row = await admin.taxClass.findFirstOrThrow({
        where: { id: classA },
      });
      expect(row.names).toEqual({ en: 'Standard rate' });
      expect(row.code).toBe('standard');
    });
  });

  describe('tenant isolation', () => {
    it('has ENABLE and FORCE row level security', async () => {
      const rows = await admin.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'fiscal' AND c.relname = 'tax_classes'`,
      );
      expect(rows[0].relrowsecurity).toBe(true);
      expect(rows[0].relforcerowsecurity).toBe(true);
    });

    it('hides another tenant tax class', async () => {
      const seen = await prisma.withAuthContext({ tenantId: tenantA }, (tx) =>
        tx.taxClass.findMany(),
      );
      // Positive control: tenant A DOES see its own three.
      expect(seen.length).toBe(3);
      expect(seen.map((c) => c.id)).toContain(classA);
      expect(seen.map((c) => c.id)).not.toContain(classB);
    });

    it('fails closed with no tenant context', async () => {
      const seen = await prisma.withAuthContext({}, (tx) =>
        tx.taxClass.findMany(),
      );
      expect(seen).toHaveLength(0);
      // Positive control: the migrator sees plenty.
      expect(await admin.taxClass.count()).toBeGreaterThan(0);
    });

    it('refuses a cross-tenant menu item reference at the DATABASE', async () => {
      const item = await admin.menuItem.create({
        data: {
          id: newId(),
          tenantId: tenantA,
          names: { en: 'Cross tenant probe' },
        },
      });
      // Application code never attempts this; the FK is the guarantee, because
      // an FK check runs as the table owner and bypasses RLS (ADR 0008 D-09).
      await expect(
        admin.menuItem.update({
          where: { id: item.id },
          data: { taxClassId: classB },
        }),
      ).rejects.toThrow();

      // Positive control: the SAME tenant's class is accepted.
      const ok = await admin.menuItem.update({
        where: { id: item.id },
        data: { taxClassId: classA },
      });
      expect(ok.taxClassId).toBe(classA);
    });

    it('refuses to delete a tax class a menu item still references', async () => {
      // Historical order lines snapshot the id; it must stay resolvable.
      await expect(
        admin.taxClass.delete({ where: { id: classA } }),
      ).rejects.toThrow();
    });
  });

  describe('runtime role privileges', () => {
    it('runs as a non-superuser without BYPASSRLS', async () => {
      const rows = await prisma.withAuthContext({}, (tx) =>
        tx.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
          `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
        ),
      );
      expect(rows[0].rolsuper).toBe(false);
      expect(rows[0].rolbypassrls).toBe(false);
    });
  });
});
