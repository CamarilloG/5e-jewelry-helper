// 白名单 IPC 契约：每个频道一个 Zod 输入 schema；主进程逐个校验来源窗口与参数（技术选型 §3）。
import { z } from 'zod';
import { MAX_NAME_LENGTH, MAX_ROW_CATEGORIES, MAX_ROW_NAMES } from './conditions';
import type {
  CheckoutStartResult,
  CheckoutView,
  DetailView,
  FavoritesView,
  FilterPresetView,
  InventoryView,
  QuoteView,
  ScanView,
  SettingsView,
  StatusView,
  UpdateInstallResult,
  UpdateView,
} from './dto';
import { RENT_KINDS } from './rent';
import { CACHE_TTLS, presetSchema } from './settings';

const accountNo = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);
const decimalText = z
  .string()
  .trim()
  .max(16)
  .regex(/^\d+(\.\d{1,2})?$/);

export const filterConditionsSchema = z
  .object({
    items: z
      .array(
        z.object({
          categoryIds: z.array(z.string().max(64)).max(MAX_ROW_CATEGORIES),
          names: z.array(z.string().trim().max(MAX_NAME_LENGTH)).max(MAX_ROW_NAMES),
        }),
      )
      .max(50),
    rentKind: z.enum(RENT_KINDS),
    priceMin: decimalText.nullable(),
    priceMax: decimalText.nullable(),
    couponOnly: z.boolean(),
  })
  .refine(
    (v) => v.priceMin == null || v.priceMax == null || Number(v.priceMin) <= Number(v.priceMax),
    { message: 'PRICE_RANGE' },
  );

const orderParams = z.object({
  rentKind: z.enum(RENT_KINDS),
  quantity: z.number().int().positive().max(10_000),
  payChannel: z.union([z.literal(1), z.literal(2)]),
  autoCoupon: z.boolean(),
});

const none = z.undefined();

export const ipcInputs = {
  'app.status': none,
  'app.openReleases': none,
  'app.openHelp': none,
  'update.state': none,
  'update.check': none,
  'update.download': none,
  'update.install': none,
  'app.quitConfirmed': none,
  'app.firstCloseHintShown': none,
  'auth.reload': none,
  'auth.chooseDirectory': none,
  'auth.resetDirectory': none,
  'scan.start': z.object({
    conditions: filterConditionsSchema,
    presetId: z.string().max(64).nullable(),
    forceRefresh: z.boolean().optional(),
  }),
  'scan.startLocal': z.object({
    conditions: filterConditionsSchema,
    presetId: z.string().max(64).nullable(),
  }),
  'scan.stop': none,
  'scan.continue': none,
  'scan.retryFailed': none,
  'scan.state': none,
  'account.detail': z.object({ accountNo, refresh: z.boolean() }),
  'account.inventory': z.object({ accountNo, refresh: z.boolean() }),
  'account.quote': z.object({ accountNo, params: orderParams }),
  'favorites.state': none,
  'favorites.add': z.object({ accountNo }),
  'favorites.remove': z.object({ accountNo, alsoPlatform: z.boolean() }),
  'favorites.restore': z.object({ accountNo }),
  'favorites.platformFavorite': z.object({ accountNo }),
  'favorites.setMonitor': z.object({ accountNo, enabled: z.boolean() }),
  'favorites.markSeen': z.object({ accountNo: accountNo.nullable() }),
  'favorites.syncNow': none,
  'favorites.savePreset': z.object({
    accountNo,
    preset: presetSchema.extend({ quantity: z.number().int().positive() }),
  }),
  'monitor.setEnabled': z.object({ enabled: z.boolean() }),
  'monitor.checkNow': none,
  'filters.list': none,
  'filters.save': z.object({
    name: z.string().trim().min(1).max(40),
    conditions: filterConditionsSchema,
    overwriteId: z.string().max(64).nullable(),
  }),
  'filters.rename': z.object({ id: z.string().max(64), name: z.string().trim().min(1).max(40) }),
  'filters.delete': z.object({ id: z.string().max(64) }),
  'checkout.start': z.object({
    accountNo,
    params: orderParams.nullable(),
    source: z.enum(['DETAIL', 'FAVORITE']),
    expectedAmountYuan: decimalText.nullable(),
  }),
  'checkout.state': none,
  'checkout.cancel': none,
  'checkout.dismiss': none,
  'checkout.manualResolve': z.object({ result: z.enum(['PAID', 'NO_PENDING']) }),
  'agreement.accept': z.object({ version: z.string().max(32) }),
  'settings.get': none,
  'settings.update': z.object({
    monitorIntervalSeconds: z.number().int().min(30).max(86_400).optional(),
    autoStartMonitor: z.boolean().optional(),
    notifications: z.boolean().optional(),
    sound: z.boolean().optional(),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
    inventoryCacheTtl: z.enum(CACHE_TTLS).optional(),
    closeBehavior: z.enum(['TRAY', 'QUIT']).optional(),
    resultView: z.enum(['CARD', 'LIST']).optional(),
    defaultPreset: presetSchema.optional(),
  }),
  'cache.clear': none,
  'diagnostics.export': none,
} as const;

export type IpcChannel = keyof typeof ipcInputs;
export const IPC_CHANNELS = Object.keys(ipcInputs) as IpcChannel[];
export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipcInputs)[C]>;

export interface IpcOutputs {
  'app.status': StatusView;
  'app.openReleases': undefined;
  'app.openHelp': undefined;
  'update.state': UpdateView;
  'update.check': UpdateView;
  'update.download': UpdateView;
  'update.install': UpdateInstallResult;
  'app.quitConfirmed': undefined;
  'app.firstCloseHintShown': undefined;
  'auth.reload': StatusView;
  'auth.chooseDirectory': StatusView;
  'auth.resetDirectory': StatusView;
  'scan.start': ScanView;
  'scan.startLocal': ScanView;
  'scan.stop': ScanView;
  'scan.continue': ScanView;
  'scan.retryFailed': ScanView;
  'scan.state': ScanView;
  'account.detail': DetailView;
  'account.inventory': InventoryView;
  'account.quote': QuoteView;
  'favorites.state': FavoritesView;
  'favorites.add': { pendingSync: boolean };
  'favorites.remove': undefined;
  'favorites.restore': boolean;
  'favorites.platformFavorite': { pendingSync: boolean };
  'favorites.setMonitor': undefined;
  'favorites.markSeen': undefined;
  'favorites.syncNow': undefined;
  'favorites.savePreset': undefined;
  'monitor.setEnabled': undefined;
  'monitor.checkNow': { started: boolean; cooldownUntil: number | null };
  'filters.list': FilterPresetView[];
  'filters.save': { ok: true; id: string } | { ok: false; reason: string; existingId?: string };
  'filters.rename': { ok: boolean; reason?: string };
  'filters.delete': boolean;
  'checkout.start': CheckoutStartResult;
  'checkout.state': CheckoutView | null;
  'checkout.cancel': undefined;
  'checkout.dismiss': undefined;
  'checkout.manualResolve': undefined;
  'agreement.accept': undefined;
  'settings.get': SettingsView;
  'settings.update': SettingsView;
  'cache.clear': SettingsView;
  'diagnostics.export': { saved: boolean; path: string | null };
}

export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };
