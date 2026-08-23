/**
 * TaxClass identity — provisioning and resolution.
 *
 * Authorised by the C-04 AMENDMENT (2026-08-20). `fiscal.tax_classes` is the
 * stable semantic identity a sale snapshots; it carries NO rate, and every rate
 * question is answered by the pinned Country Pack version instead.
 *
 * ── THE TWO OPERATIONS ─────────────────────────────────────────────────────
 *
 *   ensureFromPack   materialise the tenant's identities for a verified pack's
 *                    class list. Idempotent, and it NEVER changes an existing
 *                    row's `code` or id — order lines already point at them.
 *   requireForSale   the sale-time lookup: MenuItem -> TaxClass UUID -> semantic
 *                    code, refusing rather than defaulting.
 *
 * ── NO PUBLIC ADMINISTRATION SURFACE ───────────────────────────────────────
 * No source defines a TaxClass API, and FR-LOC-030's pack authoring tool is [S]
 * and out of scope, so none is invented. Provisioning is an internal call from
 * the point a tenant's jurisdiction is assigned. The gap this leaves — a pack
 * version that ADDS a class after a tenant was provisioned has no operator
 * surface to re-run provisioning — is real and is reported rather than papered
 * over with an invented endpoint.
 */

import { Injectable, Logger } from '@nestjs/common';
import { newId } from '../../../common/ids';
import { Prisma } from '../../../generated/prisma/client';
import { CountryPack } from '../country-pack/country-pack.model';

/** Raised when a sale cannot obtain a trustworthy tax class. */
export class TaxClassUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxClassUnavailableError';
  }
}

export interface ResolvedTaxClass {
  readonly id: string;
  readonly code: string;
  readonly countryPackCode: string;
}

/**
 * Normalise a semantic code deterministically.
 *
 * Trim and lower-case only. NOT a transliteration and not a slugifier: a code
 * that does not already match the shape is REJECTED, because silently rewriting
 * `Zero Rated` into `zero_rated` would invent an identity the pack never named.
 */
export function normaliseTaxClassCode(raw: string): string {
  const code = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(code)) {
    throw new TaxClassUnavailableError(
      `Tax class code ${JSON.stringify(raw)} is not a valid semantic key.`,
    );
  }
  return code;
}

@Injectable()
export class TaxClassService {
  private readonly logger = new Logger(TaxClassService.name);

  /**
   * Materialise the tenant's TaxClass identities for a VERIFIED pack.
   *
   * Idempotent by `(tenant_id, country_pack_code, code)`. An existing row keeps
   * its id and its code untouched — that is the entire point of the identity —
   * and only its display label is refreshed. The database enforces the same
   * rule independently: `ros_app` holds `UPDATE (names, is_active)` and nothing
   * more, so even a bug here could not rewrite a semantic key.
   *
   * Returns the ids keyed by code.
   */
  async ensureFromPack(
    tx: Prisma.TransactionClient,
    tenantId: string,
    pack: CountryPack,
  ): Promise<Map<string, string>> {
    const existing = await tx.taxClass.findMany({
      where: { tenantId, countryPackCode: pack.code },
      select: { id: true, code: true, names: true },
    });
    const byCode = new Map(existing.map((c) => [c.code, c.id]));

    for (const [code, definition] of pack.tax.classes) {
      const current = byCode.get(code);
      const names = definition.label ?? { en: code };

      if (current === undefined) {
        const created = await tx.taxClass.create({
          data: {
            id: newId(),
            tenantId,
            countryPackCode: pack.code,
            code,
            names: names,
          },
          select: { id: true },
        });
        byCode.set(code, created.id);
        continue;
      }
      // Display metadata may drift with a pack revision; the identity may not.
      await tx.taxClass.update({
        where: { id: current },
        data: { names: names },
      });
    }
    return byCode;
  }

  /** Every identity the tenant holds for a jurisdiction. */
  listForPackCode(
    tx: Prisma.TransactionClient,
    tenantId: string,
    countryPackCode: string,
  ) {
    return tx.taxClass.findMany({
      where: { tenantId, countryPackCode },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * The sale-time lookup — BR-POS-004's `tax_class_id`.
   *
   * REFUSES in three distinct ways, none of which is a default:
   *   · the item carries no tax class            -> not sellable
   *   · the class belongs to another jurisdiction -> not sellable here
   *   · the class is inactive                     -> not sellable
   *
   * A defaulted tax class is a wrong tax return, so there is deliberately no
   * "fall back to standard" path anywhere in this method.
   */
  async requireForSale(
    tx: Prisma.TransactionClient,
    menuItemId: string,
    countryPackCode: string,
  ): Promise<ResolvedTaxClass> {
    const item = await tx.menuItem.findUnique({
      where: { id: menuItemId },
      select: {
        id: true,
        taxClassId: true,
        taxClass: {
          select: {
            id: true,
            code: true,
            countryPackCode: true,
            isActive: true,
          },
        },
      },
    });
    if (!item) {
      throw new TaxClassUnavailableError(`Menu item ${menuItemId} not found.`);
    }
    if (!item.taxClassId || !item.taxClass) {
      throw new TaxClassUnavailableError(
        'This item has no tax class and cannot be sold. FR-MNU-004 requires one, ' +
          'and defaulting to a standard rate would produce a wrong tax return.',
      );
    }
    const taxClass = item.taxClass;
    if (taxClass.countryPackCode !== countryPackCode) {
      throw new TaxClassUnavailableError(
        `This item's tax class belongs to jurisdiction ${taxClass.countryPackCode}, ` +
          `but the sale is priced under ${countryPackCode}.`,
      );
    }
    if (!taxClass.isActive) {
      throw new TaxClassUnavailableError(
        `Tax class ${taxClass.code} is no longer active and cannot be used for a sale.`,
      );
    }
    return {
      id: taxClass.id,
      code: taxClass.code,
      countryPackCode: taxClass.countryPackCode,
    };
  }

  /** @internal diagnostic used by the provisioning hook. */
  logProvisioned(tenantId: string, packCode: string, count: number): void {
    this.logger.log(
      `Tenant ${tenantId}: ${count} tax class identity/identities ready for ${packCode}.`,
    );
  }
}
