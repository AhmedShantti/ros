import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { newId } from '../../common/ids';
import { Prisma, type SettingLevel } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AUDIT_ACTION,
  AUDIT_ENTITY,
  AuditService,
} from '../governance/contract';
import { COUNTRY_PACK_SETTING_FACT_QUERY } from '../localisation/contract';
import type { CountryPackSettingFactQuery } from '../localisation/contract';
import { SettingsResolverService } from './settings-resolver.service';
import { SettingsScopeService } from './settings-scope.service';
import { assertValidSettingKey } from './settings-key.util';
import {
  SETTING_HIERARCHY_LEVELS,
  type StorableSettingLevel,
} from './settings-hierarchy.types';

export interface SettingValueRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly level: StorableSettingLevel;
  readonly targetId: string;
  readonly settingKey: string;
  readonly value: unknown;
  readonly locked: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `{ brandId, branchId, terminalId }`, whichever apply — used only to derive the write's own ancestor scope for the higher-lock check. */
type AncestorHint = {
  readonly brandId?: string;
  readonly branchId?: string;
  readonly terminalId?: string;
};

function ancestorHintFor(
  level: StorableSettingLevel,
  targetId: string,
): AncestorHint {
  switch (level) {
    case 'tenant':
      return {};
    case 'brand':
      return { brandId: targetId };
    case 'branch':
      return { branchId: targetId };
    case 'terminal':
      return { terminalId: targetId };
  }
}

/**
 * FR-PLT-025 §5 write surface — the MINIMUM administration surface needed to
 * prove the resolver: set/upsert a value at tenant/brand/branch/terminal,
 * optionally lock it, and unset an override to restore inheritance.
 *
 * Platform Default and Country Pack are NOT written here — see
 * `PlatformDefaultSetting`'s schema comment and
 * `docs/reports/claude/2026-09-09_FULL-SRS-PLT-SETTINGS-RESOLVER-P1.md` for
 * why a Platform-Default HTTP write route is out of scope this slice.
 */
@Injectable()
export class SettingsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: SettingsScopeService,
    private readonly resolver: SettingsResolverService,
    private readonly audit: AuditService,
    @Inject(COUNTRY_PACK_SETTING_FACT_QUERY)
    private readonly countryPackFacts: CountryPackSettingFactQuery,
  ) {}

  async upsert(
    tenantId: string,
    actorUserId: string,
    level: StorableSettingLevel,
    targetId: string,
    settingKey: string,
    value: unknown,
    locked: boolean | undefined,
  ): Promise<SettingValueRecord> {
    assertValidSettingKey(settingKey);
    this.assertNotProviderExclusive(settingKey, level);
    return this.prisma.withAuthContext({ tenantId }, async (tx) => {
      await this.validateTarget(tx, tenantId, level, targetId);
      await this.assertNotBlockedByHigherLock(
        tenantId,
        level,
        targetId,
        settingKey,
      );

      const id = newId();
      const row = await tx.settingValue.upsert({
        where: {
          tenantId_level_targetId_settingKey: {
            tenantId,
            level: level,
            targetId,
            settingKey,
          },
        },
        create: {
          id,
          tenantId,
          level: level,
          targetId,
          settingKey,
          value: value as Prisma.InputJsonValue,
          locked: locked ?? false,
          createdBy: actorUserId,
        },
        update: {
          value: value as Prisma.InputJsonValue,
          ...(locked === undefined ? {} : { locked }),
        },
      });

      await this.audit.record(tx, {
        tenantId,
        action: AUDIT_ACTION.SETTING_VALUE_UPSERTED,
        entityType: AUDIT_ENTITY.SETTING_VALUE,
        actorType: 'user',
        actorId: actorUserId,
        entityId: row.id,
        metadata: {
          level,
          targetId,
          settingKey,
          locked: row.locked,
        },
      });

      return this.toRecord(row);
    });
  }

  /** Removes an override so the level below inherits from above again. */
  async unset(
    tenantId: string,
    actorUserId: string,
    level: StorableSettingLevel,
    targetId: string,
    settingKey: string,
  ): Promise<void> {
    assertValidSettingKey(settingKey);
    this.assertNotProviderExclusive(settingKey, level);
    await this.prisma.withAuthContext({ tenantId }, async (tx) => {
      await this.validateTarget(tx, tenantId, level, targetId);

      const existing = await tx.settingValue.findUnique({
        where: {
          tenantId_level_targetId_settingKey: {
            tenantId,
            level: level,
            targetId,
            settingKey,
          },
        },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException(
          'No configured override exists at this level for this key.',
        );
      }

      await tx.settingValue.delete({ where: { id: existing.id } });

      await this.audit.record(tx, {
        tenantId,
        action: AUDIT_ACTION.SETTING_VALUE_UNSET,
        entityType: AUDIT_ENTITY.SETTING_VALUE,
        actorType: 'user',
        actorId: actorUserId,
        entityId: existing.id,
        metadata: { level, targetId, settingKey },
      });
    });
  }

  /**
   * FR-PLT-025: "terminal belonging to another branch; branch belonging to
   * another tenant; brand outside tenant ... Fail closed." Reuses the SAME
   * scope derivation the resolver uses, so a write can never target an id
   * the resolver itself would refuse to read.
   */
  private async validateTarget(
    tx: Prisma.TransactionClient,
    tenantId: string,
    level: StorableSettingLevel,
    targetId: string,
  ): Promise<void> {
    if (level === 'tenant') {
      if (targetId !== tenantId) {
        throw new NotFoundException(
          "targetId must be the caller's own tenant.",
        );
      }
      return;
    }
    await this.scope.deriveScope(
      tx,
      tenantId,
      ancestorHintFor(level, targetId),
    );
  }

  /**
   * P2C1-R1 — a PROVIDER-EXCLUSIVE key (e.g. `payments.cash_rounding_policy`)
   * can never be configured at any generic-settings level; Country Pack is
   * its sole authority (`FR-POS-063`). Checked BEFORE `validateTarget`/
   * `assertNotBlockedByHigherLock` — a structural fact about the KEY
   * itself, not a per-target or per-lock-state condition, so it is
   * rejected as cheaply as possible, before any database access.
   *
   * Reuses the SAME `ConflictException`/409 convention
   * `assertNotBlockedByHigherLock` uses for an illegal override — but the
   * message is deliberately DISTINCT and never uses the word "locked":
   * provider-exclusivity is a STATIC fact about the key, strictly separate
   * from `FR-PLT-026` locking (`CountryPack.settingsLocks`, a DYNAMIC,
   * per-pack, optional declaration) — conflating the two in the message
   * would misrepresent WHY the write is refused, even though both
   * currently produce the same HTTP status.
   */
  private assertNotProviderExclusive(
    settingKey: string,
    level: StorableSettingLevel,
  ): void {
    if (this.countryPackFacts.isProviderExclusive(settingKey)) {
      throw new ConflictException(
        `${settingKey} is exclusively governed by the Country Pack and ` +
          `cannot be configured at ${level}.`,
      );
    }
  }

  /**
   * FR-PLT-026: "writes attempting an illegal lower-level override must be
   * rejected server-side where the backend has enough context to determine
   * it." Re-runs the resolver's own precedence walk for this write's
   * ancestor chain and rejects if anything ABOVE `level` is already
   * configured and locked — such a write could never take effect, and
   * silently accepting it would misrepresent what the resolver will return.
   */
  private async assertNotBlockedByHigherLock(
    tenantId: string,
    level: StorableSettingLevel,
    targetId: string,
    settingKey: string,
  ): Promise<void> {
    const writeLevelIndex = SETTING_HIERARCHY_LEVELS.indexOf(level);
    const breakdown = await this.resolver.fetchLevelBreakdown(tenantId, {
      settingKey,
      ...ancestorHintFor(level, targetId),
    });
    for (const entry of breakdown.entries) {
      if (SETTING_HIERARCHY_LEVELS.indexOf(entry.level) >= writeLevelIndex) {
        break;
      }
      if (entry.eligible && entry.hasConfiguredValue && entry.locked) {
        throw new ConflictException(
          `${settingKey} is locked at ${entry.level} and cannot be overridden at ${level}.`,
        );
      }
    }
  }

  private toRecord(row: {
    id: string;
    tenantId: string;
    level: SettingLevel;
    targetId: string;
    settingKey: string;
    value: unknown;
    locked: boolean;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
  }): SettingValueRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      level: row.level,
      targetId: row.targetId,
      settingKey: row.settingKey,
      value: row.value,
      locked: row.locked,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
