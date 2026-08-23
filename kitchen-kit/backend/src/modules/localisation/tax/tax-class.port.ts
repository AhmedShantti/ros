/**
 * The one thing tenant provisioning needs from Localisation.
 *
 * `identity.tenants.country_pack_code` is where a tenant's jurisdiction is
 * assigned, so it is the nearest source-supported point at which that tenant's
 * TaxClass identities should exist. A port keeps Identity — the most foundational
 * context in the repository — depending on an interface rather than on the
 * Country Pack machinery, and keeps the dependency one-directional.
 *
 * The call is best-effort by design: a tenant must still be creatable when no
 * signed pack is activated for its jurisdiction. Its menu items then have no tax
 * class, and line capture refuses them — which is the correct behaviour, not a
 * silent default.
 */
export const TAX_CLASS_PROVISIONER = Symbol('TAX_CLASS_PROVISIONER');

export interface TaxClassProvisioner {
  /**
   * Ensure the tenant's TaxClass identities exist for its jurisdiction.
   * Idempotent. Returns the number of identities now available; 0 means no
   * activated pack could supply a class list.
   */
  provisionForTenant(
    tenantId: string,
    countryPackCode: string,
  ): Promise<number>;
}
