import { PermissionDef } from '../identity/authz/permissions.constants';

/**
 * Inventory permission codes — ALL TEN are attested verbatim by SRS §15.2
 * ("Inventory"). This is the first context in the project requiring no invented
 * codes: a read code (`inventory.view`) and a cost-visibility separation
 * (`inventory.cost.view`) are both supplied by the SRS.
 *
 * §15.4 additionally names `inventory.count.perform` + `inventory.count.post` as
 * an incompatible pair (segregation of duties — "counter approves own count").
 * That is a warn-on-combination requirement; no mechanism is defined by any
 * source, so none is implemented.
 */
export const INVENTORY_PERMISSIONS = {
  VIEW: 'inventory.view',
  COUNT_PERFORM: 'inventory.count.perform',
  COUNT_POST: 'inventory.count.post',
  APPROVE_HIGH_VARIANCE: 'inventory.approve_high_variance',
  ADJUST: 'inventory.adjust',
  TRANSFER_CREATE: 'inventory.transfer.create',
  TRANSFER_RECEIVE: 'inventory.transfer.receive',
  WASTE_RECORD: 'inventory.waste.record',
  WASTE_APPROVE: 'inventory.waste.approve',
  COST_VIEW: 'inventory.cost.view',
} as const;

export const INVENTORY_PERMISSION_DEFS: PermissionDef[] = [
  {
    code: INVENTORY_PERMISSIONS.VIEW,
    module: 'inventory',
    description: 'View stock levels',
  },
  {
    code: INVENTORY_PERMISSIONS.COUNT_PERFORM,
    module: 'inventory',
    description: 'Perform a stock count',
  },
  {
    code: INVENTORY_PERMISSIONS.COUNT_POST,
    module: 'inventory',
    description: 'Post a count and create adjustments',
  },
  {
    code: INVENTORY_PERMISSIONS.APPROVE_HIGH_VARIANCE,
    module: 'inventory',
    description: 'Post counts exceeding variance thresholds',
  },
  {
    code: INVENTORY_PERMISSIONS.ADJUST,
    module: 'inventory',
    description: 'Make manual adjustments',
  },
  {
    code: INVENTORY_PERMISSIONS.TRANSFER_CREATE,
    module: 'inventory',
    description: 'Initiate transfers',
  },
  {
    code: INVENTORY_PERMISSIONS.TRANSFER_RECEIVE,
    module: 'inventory',
    description: 'Receive transfers',
  },
  {
    code: INVENTORY_PERMISSIONS.WASTE_RECORD,
    module: 'inventory',
    description: 'Record waste',
  },
  {
    code: INVENTORY_PERMISSIONS.WASTE_APPROVE,
    module: 'inventory',
    description: 'Approve waste above threshold',
  },
  {
    code: INVENTORY_PERMISSIONS.COST_VIEW,
    module: 'inventory',
    description: 'View item costs and valuation',
  },
];
