// 平台响应 Zod 契约与归一化（接口与数据规范 §2、§3）。关键字段不符 → CONTRACT_CHANGED；
// 状态类字段宽松读取后由领域函数判定，陌生/缺失值归为未知，绝不推断可租。
import { z } from 'zod';
import type { RentKind, RentPricing } from '../../shared/rent';
import { RENT_KINDS, RENT_META } from '../../shared/rent';
import { type AccountStatus, accountStatus, secondsToMs } from '../../shared/status';

/** 统一信封：status 必须为 true 才是业务成功。 */
export const envelopeSchema = z.object({
  status: z.boolean().optional(),
  code: z.union([z.number(), z.string()]).optional(),
  message: z.unknown().optional(),
  data: z.unknown().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
});

const idText = z.union([z.string(), z.number()]).transform((v) => String(v));
const optionalText = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v == null ? '' : String(v)));
const intList = z
  .array(z.union([z.number(), z.string()]))
  .nullish()
  .transform((list) => (list ?? []).map((v) => Number(v)).filter((v) => Number.isInteger(v)));
const looseInt = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) =>
    v == null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : null,
  );
const nonNegativeTotal = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    ctx.addIssue({ code: 'custom', message: 'INVALID_TOTAL' });
    return z.NEVER;
  }
  return n;
});

export const rawItemSchema = z.object({
  id: optionalText,
  assetid: optionalText,
  marketName: optionalText,
  marketHashName: optionalText,
  name: optionalText,
  nameColor: optionalText,
  steamImgUrl: optionalText,
  ossImgUrl: optionalText,
  rarity: looseInt,
  rarityName: optionalText,
  exteriorName: optionalText,
  hasStattrak: looseInt,
  price: optionalText,
  wear: optionalText,
  firstType: optionalText,
  secondType: optionalText,
  stickers: z
    .object({
      stickerInfo: z.array(z.object({ name: optionalText }).passthrough()).nullish(),
      keychainInfo: z.array(z.object({ name: optionalText }).passthrough()).nullish(),
    })
    .passthrough()
    .nullish(),
});
export type RawItem = z.infer<typeof rawItemSchema>;

const pricingFields = {
  hourPrice: optionalText,
  dayPrice: optionalText,
  weekPrice: optionalText,
  morningPrice: optionalText,
  noonPrice: optionalText,
  eveningPrice: optionalText,
  hourFirstPrice: optionalText,
  dayFirstPrice: optionalText,
  weekFirstPrice: optionalText,
  hourActPrice: optionalText,
  dayActPrice: optionalText,
  weekActPrice: optionalText,
  rentType: intList,
  rentPeriod: looseInt,
  weekRangeMorning: intList,
  weekRangeNoon: intList,
  weekRangeEvening: intList,
  useCoupon: looseInt,
};

export const rawAccountSchema = z.object({
  accountNo: idText,
  value: optionalText,
  availableValue: optionalText,
  tags: z
    .array(z.unknown())
    .nullish()
    .transform((t) => (t ?? []).filter((x) => typeof x === 'string') as string[]),
  displayInventory: z.array(rawItemSchema).nullish(),
  shelfStatus: z.unknown().optional(),
  rentStatus: z.unknown().optional(),
  expireTime: z.unknown().optional(),
  isFavorited: z.boolean().nullish(),
  isFirst: looseInt,
  platformCouponConfig: looseInt,
  ...pricingFields,
});
export type RawAccount = z.infer<typeof rawAccountSchema>;

export const searchDataSchema = z.object({
  total: nonNegativeTotal,
  isFirst: looseInt,
  list: z
    .array(rawAccountSchema)
    .nullable()
    .transform((l) => l ?? []),
});

export const favoritesDataSchema = z.object({
  total: nonNegativeTotal,
  list: z
    .array(rawAccountSchema)
    .nullable()
    .transform((l) => l ?? []),
});

export const inventoryDataSchema = z.object({
  list: z
    .array(rawItemSchema)
    .nullable()
    .transform((l) => l ?? []),
});

export const userInfoSchema = z.object({
  uuid: idText,
  isCertify: z.unknown(),
  isBan: z.unknown(),
  isPlatformMaintenance: z.unknown(),
});

export const authInfoSchema = z.object({
  frontPageStatus: looseInt,
  orderPageStatus: looseInt,
});

export const globalConfigSchema = z.object({
  rentType: intList,
  hourlyRental: looseInt,
});

export const durationSchema = z.object({
  hourDuration: intList,
  dayDuration: intList,
  weekDuration: intList,
  hourDurationRenewal: intList,
});

export const couponItemSchema = z.object({
  id: idText,
  couponType: looseInt,
  discountType: looseInt,
  discountValue: optionalText,
  thresholdAmount: optionalText,
  status: looseInt,
  validStartAt: z.unknown(),
  validEndAt: z.unknown(),
});

export const couponDataSchema = z.object({
  items: z
    .array(couponItemSchema)
    .nullable()
    .transform((l) => l ?? []),
  availableCount: looseInt,
  totalSize: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  nextPageToken: optionalText,
});

export const channelDataSchema = z.object({
  items: z
    .array(z.object({ payChannel: z.union([z.number(), z.string()]), payChannelId: idText }))
    .nullable()
    .transform((l) => l ?? []),
});

export const lockDataSchema = z.unknown();

export const createDataSchema = z.object({
  orderId: idText.refine((v) => v.length > 0, 'EMPTY_ORDER_ID'),
  codeUrl: z.string().min(1),
  channelType: looseInt,
  orderDateline: z.union([z.string(), z.number()]),
  orderRemainSeconds: z.union([z.number(), z.string()]).transform((v) => Number(v)),
});

export const payStatusSchema = z.object({
  payStatus: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  abnormalReason: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => (v == null || v === '' ? 0 : Number(v))),
});

export const orderListSchema = z.object({
  totalSize: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  nextPageToken: optionalText,
  items: z
    .array(
      z.object({
        orderNo: idText,
        accountNo: idText,
        totalRealAmount: optionalText,
        totalTimeLength: optionalText,
        orderStatus: looseInt,
        rentStartTime: optionalText,
        rentExpireTime: optionalText,
      }),
    )
    .nullable()
    .transform((l) => l ?? []),
});

export const orderDetailsSchema = z.object({
  items: z
    .array(
      z.object({
        orderNo: idText,
        orderChildNo: idText,
        accountNo: idText,
        realAmount: optionalText,
        orderPayStatus: looseInt,
        buyTimeType: looseInt,
        buyCount: looseInt,
      }),
    )
    .nullable()
    .transform((l) => l ?? []),
});

// ---------- 归一化 ----------

export interface InventoryItem {
  key: string;
  id: string;
  assetid: string;
  marketName: string;
  firstType: string;
  exteriorName: string;
  wear: string | null;
  price: string | null;
  ossImgUrl: string | null;
  steamImgUrl: string | null;
  rarity: number | null;
  rarityName: string;
  nameColor: string | null;
  statTrak: boolean;
  stickers: string[];
}

export function normalizeItem(raw: RawItem, index: number): InventoryItem {
  const marketName = raw.marketName || raw.name || '未知饰品';
  const color = /^[0-9a-fA-F]{6}$/.test(raw.nameColor) ? `#${raw.nameColor.toLowerCase()}` : null;
  const stickers = [
    ...(raw.stickers?.stickerInfo ?? []).map((s) => s.name),
    ...(raw.stickers?.keychainInfo ?? []).map((s) => s.name),
  ].filter((s) => s);
  return {
    key: raw.assetid || raw.id || `idx-${index}`,
    id: raw.id,
    assetid: raw.assetid,
    marketName,
    firstType: raw.firstType,
    exteriorName: raw.exteriorName,
    wear: raw.wear || null,
    price: raw.price || null,
    ossImgUrl: raw.ossImgUrl || null,
    steamImgUrl: raw.steamImgUrl || null,
    rarity: raw.rarity,
    rarityName: raw.rarityName,
    nameColor: color,
    statTrak: /stattrak/i.test(marketName.normalize('NFKC')) || raw.hasStattrak === 1,
    stickers,
  };
}

/** 同一库存内按 assetid 去重。 */
export function normalizeInventory(list: RawItem[]): InventoryItem[] {
  const seen = new Set<string>();
  const out: InventoryItem[] = [];
  list.forEach((raw, index) => {
    const item = normalizeItem(raw, index);
    if (seen.has(item.key)) return;
    seen.add(item.key);
    out.push(item);
  });
  return out;
}

export interface AccountRecord {
  accountNo: string;
  status: AccountStatus;
  /** 是否带有可判定状态的字段（搜索列表不带） */
  statusKnown: boolean;
  expireTimeMs: number | null;
  tags: string[];
  value: string | null;
  pricing: RentPricing;
  couponAllowed: boolean;
  /** 账号 useCoupon 标记（仅可用券筛选使用） */
  useCoupon: boolean;
  isFirst: boolean;
  platformFavorited: boolean | null;
  displayItems: InventoryItem[];
}

export function normalizeAccount(raw: RawAccount): AccountRecord {
  const hasStatus = raw.shelfStatus !== undefined && raw.rentStatus !== undefined;
  const prices: Partial<Record<RentKind, string>> = {};
  const firstPrices: Partial<Record<RentKind, string>> = {};
  const actPrices: Partial<Record<RentKind, string>> = {};
  for (const kind of RENT_KINDS) {
    const meta = RENT_META[kind];
    const price = raw[meta.priceField];
    if (price) prices[kind] = price;
    if (meta.firstPriceField && raw[meta.firstPriceField])
      firstPrices[kind] = raw[meta.firstPriceField];
    if (meta.actPriceField && raw[meta.actPriceField]) actPrices[kind] = raw[meta.actPriceField];
  }
  return {
    accountNo: raw.accountNo,
    status: hasStatus ? accountStatus(raw.shelfStatus, raw.rentStatus) : 'UNKNOWN',
    statusKnown: hasStatus,
    expireTimeMs: secondsToMs(raw.expireTime),
    tags: raw.tags,
    value: raw.value || null,
    pricing: {
      rentType: raw.rentType,
      prices,
      firstPrices,
      actPrices,
      rentPeriod: raw.rentPeriod,
      weekRange: {
        EARLY: raw.weekRangeMorning,
        NOON: raw.weekRangeNoon,
        NIGHT: raw.weekRangeEvening,
      },
    },
    couponAllowed: raw.platformCouponConfig !== 0 && raw.useCoupon !== 0,
    useCoupon: raw.useCoupon === 1,
    isFirst: raw.isFirst === 1,
    platformFavorited: raw.isFavorited ?? null,
    displayItems: normalizeInventory(raw.displayInventory ?? []),
  };
}

export const ACCOUNT_SNAPSHOT_VERSION = 1;
export const INVENTORY_CACHE_VERSION = 1;
