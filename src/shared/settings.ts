// 设置的版本化结构与默认值（产品文档 §9，业务流程 §7）。
import { z } from 'zod';
import { RENT_KINDS } from './rent';

export const SETTINGS_SCHEMA_VERSION = 2 as const;

export const CACHE_TTLS = ['SESSION', '1H', '6H', '1D'] as const;
export type CacheTtl = (typeof CACHE_TTLS)[number];
export const CACHE_TTL_LABEL: Record<CacheTtl, string> = {
  SESSION: '本次运行',
  '1H': '1 小时',
  '6H': '6 小时',
  '1D': '1 天',
};
export const CACHE_TTL_MS: Record<CacheTtl, number> = {
  SESSION: 0,
  '1H': 3600_000,
  '6H': 6 * 3600_000,
  '1D': 24 * 3600_000,
};

export const MONITOR_MIN_SECONDS = 30;
export const DEFAULT_RATE_LIMIT = 30;

/** 设备作用域设置（v2：新装默认库存缓存 6 小时）。 */
export const deviceSettingsSchema = z.object({
  version: z
    .union([z.literal(1), z.literal(2)])
    .default(SETTINGS_SCHEMA_VERSION)
    .transform(() => SETTINGS_SCHEMA_VERSION),
  clientDataDir: z.string().max(1024).nullable().default(null),
  monitorIntervalSeconds: z.number().int().min(MONITOR_MIN_SECONDS).max(86_400).default(60),
  autoStartMonitor: z.boolean().default(true),
  notifications: z.boolean().default(true),
  sound: z.boolean().default(true),
  rateLimitPerMinute: z.number().int().min(1).max(600).default(DEFAULT_RATE_LIMIT),
  inventoryCacheTtl: z.enum(CACHE_TTLS).default('6H'),
  closeBehavior: z.enum(['TRAY', 'QUIT']).default('TRAY'),
  closeHintShown: z.boolean().default(false),
  resultView: z.enum(['CARD', 'LIST']).default('CARD'),
});
export type DeviceSettings = z.output<typeof deviceSettingsSchema>;

/**
 * B5 (R12) 库存缓存默认值迁移：
 * - 新安装（stored == null）：默认 inventoryCacheTtl = '6H'，version = 2
 * - 升级已有设置：保留已有的有效值（SESSION / 1H / 6H / 1D）；
 *   若旧设置缺少 inventoryCacheTtl 字段或值非法，保留旧默认 '1H'
 */
export function migrateDeviceSettings(stored: unknown): {
  settings: DeviceSettings;
  migrated: boolean;
} {
  if (stored === null || stored === undefined) {
    return {
      settings: deviceSettingsSchema.parse({}),
      migrated: true,
    };
  }
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    return {
      settings: deviceSettingsSchema.parse({ inventoryCacheTtl: '1H' }),
      migrated: true,
    };
  }
  const rec = stored as Record<string, unknown>;
  const rawTtl = rec.inventoryCacheTtl;
  const hasValidTtl =
    typeof rawTtl === 'string' && (CACHE_TTLS as readonly string[]).includes(rawTtl);
  const resolvedTtl: CacheTtl = hasValidTtl ? (rawTtl as CacheTtl) : '1H';

  const pick = <T>(val: unknown, schema: z.ZodType<T>, fallback: T): T => {
    const r = schema.safeParse(val);
    return r.success ? r.data : fallback;
  };

  const defaults = deviceSettingsSchema.parse({});
  const settings: DeviceSettings = {
    version: SETTINGS_SCHEMA_VERSION,
    clientDataDir: pick(rec.clientDataDir, z.string().max(1024).nullable(), defaults.clientDataDir),
    monitorIntervalSeconds: pick(
      rec.monitorIntervalSeconds,
      z.number().int().min(MONITOR_MIN_SECONDS).max(86_400),
      defaults.monitorIntervalSeconds,
    ),
    autoStartMonitor: pick(rec.autoStartMonitor, z.boolean(), defaults.autoStartMonitor),
    notifications: pick(rec.notifications, z.boolean(), defaults.notifications),
    sound: pick(rec.sound, z.boolean(), defaults.sound),
    rateLimitPerMinute: pick(
      rec.rateLimitPerMinute,
      z.number().int().min(1).max(600),
      defaults.rateLimitPerMinute,
    ),
    inventoryCacheTtl: resolvedTtl,
    closeBehavior: pick(rec.closeBehavior, z.enum(['TRAY', 'QUIT']), defaults.closeBehavior),
    closeHintShown: pick(rec.closeHintShown, z.boolean(), defaults.closeHintShown),
    resultView: pick(rec.resultView, z.enum(['CARD', 'LIST']), defaults.resultView),
  };

  const migrated = rec.version !== SETTINGS_SCHEMA_VERSION || !hasValidTtl;
  return { settings, migrated };
}

export const presetSchema = z.object({
  rentKind: z.enum(RENT_KINDS),
  /** null 表示采用账号支持的最小数量 */
  quantity: z.number().int().positive().nullable(),
  payChannel: z.union([z.literal(1), z.literal(2)]),
  autoCoupon: z.boolean(),
});
export type OrderPreset = z.infer<typeof presetSchema>;

export const DEFAULT_PRESET: OrderPreset = {
  rentKind: 'HOUR',
  quantity: null,
  payChannel: 1,
  autoCoupon: true,
};

/** 用户作用域设置。 */
export const profileSettingsSchema = z.object({
  version: z.literal(1).default(1),
  defaultPreset: presetSchema.default(DEFAULT_PRESET),
  monitorEnabled: z.boolean().default(true),
  agreementVersion: z.string().nullable().default(null),
  agreementAcceptedAt: z.number().int().nullable().default(null),
});
export type ProfileSettings = z.infer<typeof profileSettingsSchema>;

/** 本工具展示的租赁协议与占号风险版本；文案变更时提升。 */
export const AGREEMENT_VERSION = '2026-11-07';

export const DEVICE_SCOPE = '__device__';
