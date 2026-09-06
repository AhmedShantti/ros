import { nullable, uuidSchema } from '../../../common/openapi/schema-helpers';

export interface DrawerView {
  id: string;
  branchId: string;
  name: string;
  terminalId: string | null;
  isActive: boolean;
}

/** Shape verified against `ResolvedDrawer`/`DrawersService.create`'s row. */
export function toDrawerView(row: {
  id: string;
  branchId: string;
  name: string;
  terminalId: string | null;
  isActive: boolean;
}): DrawerView {
  return {
    id: row.id,
    branchId: row.branchId,
    name: row.name,
    terminalId: row.terminalId,
    isActive: row.isActive,
  };
}

export const drawerSchema = {
  type: 'object',
  properties: {
    id: uuidSchema(),
    branchId: uuidSchema(),
    name: { type: 'string' },
    terminalId: nullable(uuidSchema()),
    isActive: { type: 'boolean' },
  },
};
