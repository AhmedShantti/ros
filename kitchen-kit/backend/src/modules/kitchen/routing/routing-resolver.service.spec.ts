import { Prisma } from '../../../generated/prisma/client';
import {
  RoutingConfigQuery,
  RoutingConfigResult,
} from '../../organisation/contract';
import {
  RoutingConfigurationConflictError,
  RoutingNoDestinationError,
} from './routing-resolver.errors';
import { RoutingResolverService } from './routing-resolver.service';
import { LineOverrideRef } from './routing-resolver.types';

const TX = {} as Prisma.TransactionClient;

const BASE_INPUT = {
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  menuItemId: 'item-1',
  modifierIds: [] as string[],
  categoryIds: [] as string[],
  lineOverrides: [] as LineOverrideRef[],
};

function emptyConfig(
  overrides: Partial<RoutingConfigResult> = {},
): RoutingConfigResult {
  return {
    modifierRules: [],
    menuItemRules: [],
    categoryRules: [],
    fallbackStationId: null,
    ...overrides,
  };
}

function makeResolver(config: RoutingConfigResult) {
  const query: Pick<RoutingConfigQuery, 'find'> = {
    find: jest.fn().mockResolvedValue(config),
  };
  const resolver = new RoutingResolverService(query);
  return { resolver, query };
}

describe('RoutingResolverService — FR-KDS-010', () => {
  describe('R1 — tier precedence: LINE_OVERRIDE beats everything', () => {
    it('resolves to the line override without querying the contract at all', async () => {
      const { resolver, query } = makeResolver(
        emptyConfig({
          modifierRules: [{ ruleId: 'r-mod', stationId: 'st-mod' }],
          fallbackStationId: 'st-fallback',
        }),
      );
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        lineOverrides: [{ overrideId: 'ov-1', stationId: 'st-override' }],
      });
      expect(result).toEqual({
        tier: 'LINE_OVERRIDE',
        tierLabel: 'Explicit line-level station override',
        stationIds: ['st-override'],
        sourceIds: ['ov-1'],
      });
      expect(query.find).not.toHaveBeenCalled();
    });
  });

  describe('R3 — MODIFIER tier REPLACES lower tiers (no augment)', () => {
    it('resolves to modifier stations even when menu-item/category/fallback also match', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          modifierRules: [{ ruleId: 'r-mod', stationId: 'st-mod' }],
          menuItemRules: [{ ruleId: 'r-item', stationId: 'st-item' }],
          categoryRules: [
            { ruleId: 'r-cat', stationId: 'st-cat', categoryId: 'cat-1' },
          ],
          fallbackStationId: 'st-fallback',
        }),
      );
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        modifierIds: ['mod-1'],
      });
      expect(result.tier).toBe('MODIFIER');
      expect(result.stationIds).toEqual(['st-mod']);
      expect(result.sourceIds).toEqual(['r-mod']);
    });
  });

  describe('R4/C-03 — MENU_ITEM tier is item-level, beats category/fallback', () => {
    it('resolves to the menu item station when no modifier rule matches', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          menuItemRules: [{ ruleId: 'r-item', stationId: 'st-item' }],
          categoryRules: [
            { ruleId: 'r-cat', stationId: 'st-cat', categoryId: 'cat-1' },
          ],
          fallbackStationId: 'st-fallback',
        }),
      );
      const result = await resolver.resolve(TX, BASE_INPUT);
      expect(result.tier).toBe('MENU_ITEM');
      expect(result.stationIds).toEqual(['st-item']);
    });
  });

  describe('CATEGORY tier, beats fallback', () => {
    it('resolves to the category station when no modifier/menu-item rule matches', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          categoryRules: [
            { ruleId: 'r-cat', stationId: 'st-cat', categoryId: 'cat-1' },
          ],
          fallbackStationId: 'st-fallback',
        }),
      );
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        categoryIds: ['cat-1'],
      });
      expect(result.tier).toBe('CATEGORY');
      expect(result.stationIds).toEqual(['st-cat']);
    });
  });

  describe('FALLBACK tier', () => {
    it('resolves to the branch fallback when no rule matches at all', async () => {
      const { resolver } = makeResolver(
        emptyConfig({ fallbackStationId: 'st-fallback' }),
      );
      const result = await resolver.resolve(TX, BASE_INPUT);
      expect(result).toEqual({
        tier: 'FALLBACK',
        tierLabel: 'Branch fallback station',
        stationIds: ['st-fallback'],
        sourceIds: ['branch-1'],
      });
    });
  });

  describe('R6 — ROUTING_NO_DESTINATION', () => {
    it('throws when nothing matches and no fallback is configured', async () => {
      const { resolver } = makeResolver(emptyConfig());
      await expect(resolver.resolve(TX, BASE_INPUT)).rejects.toThrow(
        RoutingNoDestinationError,
      );
      await expect(resolver.resolve(TX, BASE_INPUT)).rejects.toMatchObject({
        code: 'ROUTING_NO_DESTINATION',
      });
    });
  });

  describe('R2 — distinct-union multi-station within the winning tier', () => {
    it('unions and sorts multiple modifier-tier stations, deduplicating repeats', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          modifierRules: [
            { ruleId: 'r-b', stationId: 'st-b' },
            { ruleId: 'r-a', stationId: 'st-a' },
            { ruleId: 'r-a2', stationId: 'st-a' }, // duplicate station, distinct rule
          ],
        }),
      );
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        modifierIds: ['mod-1', 'mod-2'],
      });
      expect(result.tier).toBe('MODIFIER');
      expect(result.stationIds).toEqual(['st-a', 'st-b']);
      expect(result.sourceIds).toEqual(['r-a', 'r-a2', 'r-b']);
    });

    it('unions multiple line overrides, sorted, deduplicated', async () => {
      const { resolver } = makeResolver(emptyConfig());
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        lineOverrides: [
          { overrideId: 'ov-2', stationId: 'st-b' },
          { overrideId: 'ov-1', stationId: 'st-a' },
        ],
      });
      expect(result.stationIds).toEqual(['st-a', 'st-b']);
      expect(result.sourceIds).toEqual(['ov-1', 'ov-2']);
    });
  });

  describe('R5 — multi-category', () => {
    it('0 matching categories: falls through to fallback', async () => {
      const { resolver } = makeResolver(
        emptyConfig({ fallbackStationId: 'st-fallback' }),
      );
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        categoryIds: ['cat-1', 'cat-2'],
      });
      expect(result.tier).toBe('FALLBACK');
    });

    it('1 matching category: uses it', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          categoryRules: [
            { ruleId: 'r-1', stationId: 'st-1', categoryId: 'cat-1' },
          ],
        }),
      );
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        categoryIds: ['cat-1', 'cat-2'],
      });
      expect(result.tier).toBe('CATEGORY');
      expect(result.stationIds).toEqual(['st-1']);
    });

    it('N categories resolving to the identical station set: uses it', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          categoryRules: [
            { ruleId: 'r-1', stationId: 'st-1', categoryId: 'cat-1' },
            { ruleId: 'r-2', stationId: 'st-1', categoryId: 'cat-2' },
          ],
        }),
      );
      const result = await resolver.resolve(TX, {
        ...BASE_INPUT,
        categoryIds: ['cat-1', 'cat-2'],
      });
      expect(result.tier).toBe('CATEGORY');
      expect(result.stationIds).toEqual(['st-1']);
      expect(result.sourceIds).toEqual(['r-1', 'r-2']);
    });

    it('N categories resolving to different station sets: ROUTING_CONFIGURATION_CONFLICT', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          categoryRules: [
            { ruleId: 'r-1', stationId: 'st-1', categoryId: 'cat-1' },
            { ruleId: 'r-2', stationId: 'st-2', categoryId: 'cat-2' },
          ],
        }),
      );
      await expect(
        resolver.resolve(TX, {
          ...BASE_INPUT,
          categoryIds: ['cat-1', 'cat-2'],
        }),
      ).rejects.toThrow(RoutingConfigurationConflictError);
      await expect(
        resolver.resolve(TX, {
          ...BASE_INPUT,
          categoryIds: ['cat-1', 'cat-2'],
        }),
      ).rejects.toMatchObject({ code: 'ROUTING_CONFIGURATION_CONFLICT' });
    });

    it('never arbitrarily picks one category or reads priority to break the tie', async () => {
      // Two categories, overlapping but non-identical station sets: {a,b} vs {a}.
      // Neither "pick the first" nor "union blindly" is correct — must conflict.
      const { resolver } = makeResolver(
        emptyConfig({
          categoryRules: [
            { ruleId: 'r-1', stationId: 'st-a', categoryId: 'cat-1' },
            { ruleId: 'r-2', stationId: 'st-b', categoryId: 'cat-1' },
            { ruleId: 'r-3', stationId: 'st-a', categoryId: 'cat-2' },
          ],
        }),
      );
      await expect(
        resolver.resolve(TX, {
          ...BASE_INPUT,
          categoryIds: ['cat-1', 'cat-2'],
        }),
      ).rejects.toThrow(RoutingConfigurationConflictError);
    });
  });

  describe('R7 — runtime-only provenance, no persistence side effect', () => {
    it('returns tier, tierLabel, stationIds, and sourceIds; nothing else, and calls no write method', async () => {
      const { resolver, query } = makeResolver(
        emptyConfig({ fallbackStationId: 'st-fallback' }),
      );
      const result = await resolver.resolve(TX, BASE_INPUT);
      expect(Object.keys(result).sort()).toEqual(
        ['sourceIds', 'stationIds', 'tier', 'tierLabel'].sort(),
      );
      expect(query.find).toHaveBeenCalledTimes(1);
      expect(query.find).toHaveBeenCalledWith(TX, {
        tenantId: BASE_INPUT.tenantId,
        branchId: BASE_INPUT.branchId,
        menuItemId: BASE_INPUT.menuItemId,
        modifierIds: BASE_INPUT.modifierIds,
        categoryIds: BASE_INPUT.categoryIds,
      });
    });
  });

  describe('determinism', () => {
    it('produces the same stationIds/sourceIds order across repeated calls', async () => {
      const { resolver } = makeResolver(
        emptyConfig({
          modifierRules: [
            { ruleId: 'r-z', stationId: 'st-z' },
            { ruleId: 'r-a', stationId: 'st-a' },
          ],
        }),
      );
      const input = { ...BASE_INPUT, modifierIds: ['mod-1'] };
      const first = await resolver.resolve(TX, input);
      const second = await resolver.resolve(TX, input);
      expect(first).toEqual(second);
    });
  });
});
