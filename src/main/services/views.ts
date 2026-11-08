// 领域记录 → 界面 DTO，以及收藏 3×3 宫格选图与摘要版本管理（C1–C4）。
import { Decimal } from 'decimal.js';
import { GROUP_BY_ID, getCategoryDef, normalizeCategoryCode } from '../../shared/catalog';
import type { AccountView, ItemView, PriceView, SummarySourceKind } from '../../shared/dto';
import { RENT_KINDS, type RentPricing, supportedRents, supportsRent } from '../../shared/rent';
import { weaponPrefix } from '../domain/matching';
import type { AccountRecord, InventoryItem } from '../platform/schemas';
import { imageProxyUrl } from './image-cache';

export function toItemView(item: InventoryItem): ItemView {
  const official = imageProxyUrl(item.ossImgUrl);
  const steam = imageProxyUrl(item.steamImgUrl);
  return {
    key: item.key,
    name: item.marketName,
    exterior: item.exteriorName,
    wear: item.wear,
    price: item.price,
    image: official ?? steam,
    fallbackImage: official ? steam : null,
    rarityColor: item.nameColor,
    rarityName: item.rarityName,
    statTrak: item.statTrak,
    firstType: item.firstType,
    stickers: item.stickers,
  };
}

export function priceViews(pricing: RentPricing): PriceView[] {
  return RENT_KINDS.map((kind) => ({
    kind,
    supported: supportsRent(pricing, kind),
    price: pricing.prices[kind] ?? null,
    firstPrice: pricing.firstPrices[kind] ?? null,
    actPrice: pricing.actPrices[kind] ?? null,
  }));
}

export function toAccountView(record: AccountRecord, fetchedAt: number): AccountView {
  return {
    accountNo: record.accountNo,
    status: record.status,
    expireTimeMs: record.expireTimeMs,
    tags: record.tags,
    value: record.value,
    prices: priceViews(record.pricing),
    supported: supportedRents(record.pricing),
    rentPeriod: record.pricing.rentPeriod,
    weekRange: record.pricing.weekRange,
    couponAllowed: record.couponAllowed,
    isFirst: record.isFirst,
    displayItems: record.displayItems.map(toItemView),
    platformFavorited: record.platformFavorited,
    fetchedAt,
  };
}

function parsePriceDecimal(raw: string | null | undefined): Decimal | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const d = new Decimal(trimmed);
    if (!d.isFinite() || d.lte(0)) return null;
    return d;
  } catch {
    return null;
  }
}

export function compareGridItemsByPriceDesc(a: ItemView, b: ItemView): number {
  const pa = parsePriceDecimal(a.price);
  const pb = parsePriceDecimal(b.price);
  if (pa !== null && pb === null) return -1;
  if (pa === null && pb !== null) return 1;
  if (pa !== null && pb !== null && !pa.eq(pb)) {
    return pb.cmp(pa);
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function resolveItemFirstType(item: ItemView): string {
  const ft = (item.firstType ?? '').trim();
  if (ft) return ft;
  const prefix = weaponPrefix(item.name);
  const code = normalizeCategoryCode(prefix);
  if (code) {
    const def = getCategoryDef(code);
    if (def) {
      return GROUP_BY_ID.get(def.groupId)?.firstType ?? '';
    }
  }
  return '';
}

/**
 * C2 收藏卡片 3×3 宫格选图规则：
 * 1. 按库存唯一键 `key` 去重；
 * 2. 刀（匕首）、手套（含裹手）、主战武器（步枪 + 狙击步枪）各取估价最高的至多 2 件；
 * 3. 再从未选中的饰品里按估价从高到低补满 9 件；
 * 4. 估价缺失的排在后面，同价按唯一键 `key` 稳定排序；
 * 5. 不足 9 件时只返回实际件数（界面留空格）。
 */
export function selectGridItems(items: readonly ItemView[]): ItemView[] {
  const deduped = new Map<string, ItemView>();
  for (const item of items) {
    if (!item.key) continue;
    if (!deduped.has(item.key)) {
      deduped.set(item.key, item);
    }
  }
  const sortedPool = [...deduped.values()].sort(compareGridItemsByPriceDesc);
  if (sortedPool.length === 0) return [];

  const knives: ItemView[] = [];
  const gloves: ItemView[] = [];
  const mains: ItemView[] = [];

  for (const item of sortedPool) {
    const ft = resolveItemFirstType(item);
    if (ft === '匕首') {
      knives.push(item);
    } else if (ft === '手套') {
      gloves.push(item);
    } else if (ft === '步枪' || ft === '狙击步枪') {
      mains.push(item);
    }
  }

  const selectedKeys = new Set<string>();
  const picked: ItemView[] = [];
  const takeFrom = (bucket: ItemView[], limit: number) => {
    let count = 0;
    for (const it of bucket) {
      if (count >= limit || picked.length >= 9) break;
      if (selectedKeys.has(it.key)) continue;
      selectedKeys.add(it.key);
      picked.push(it);
      count += 1;
    }
  };

  takeFrom(knives, 2);
  takeFrom(gloves, 2);
  takeFrom(mains, 2);

  for (const it of sortedPool) {
    if (picked.length >= 9) break;
    if (selectedKeys.has(it.key)) continue;
    selectedKeys.add(it.key);
    picked.push(it);
  }

  return picked;
}

/** 收藏行与通知使用的摘要：卖点、各租期价格、3×3 宫格选图与兼容单缩略图。 */
export interface AccountSummary {
  tags: string[];
  pricing: RentPricing;
  thumbnail: string | null;
  thumbnailSource: string | null;
  summaryVersion?: 1 | 2;
  gridItems?: ItemView[];
  summarySource?: SummarySourceKind;
  summaryUpdatedAt?: number | null;
}

export function summarize(
  record: AccountRecord,
  inventory?: InventoryItem[],
  opts?: { source?: SummarySourceKind; updatedAt?: number },
): AccountSummary {
  const hasExplicitInventory = inventory !== undefined;
  const source: SummarySourceKind =
    opts?.source ??
    (hasExplicitInventory ? (inventory.length === 0 ? 'empty_inventory' : 'inventory') : 'display');
  const updatedAt = opts?.updatedAt ?? Date.now();

  // C3：确认完整库存为空时不再回退到展示位；未读库存时至多显示 5 件展示位
  const rawItems = hasExplicitInventory ? inventory : record.displayItems.slice(0, 5);
  const itemViews = rawItems.map(toItemView);
  const gridItems =
    source === 'empty_inventory'
      ? []
      : source === 'inventory'
        ? selectGridItems(itemViews)
        : selectGridItems(itemViews).slice(0, 5);

  let best: InventoryItem | null = null;
  if (source !== 'empty_inventory') {
    for (const item of rawItems) {
      if (!best || Number(item.price ?? 0) > Number(best.price ?? 0)) best = item;
    }
  }
  const thumbSource = best?.ossImgUrl ?? best?.steamImgUrl ?? null;
  return {
    tags: record.tags,
    pricing: record.pricing,
    thumbnail: source === 'empty_inventory' ? null : imageProxyUrl(thumbSource),
    thumbnailSource: source === 'empty_inventory' ? null : thumbSource,
    summaryVersion: 2,
    gridItems,
    summarySource: source,
    summaryUpdatedAt: updatedAt,
  };
}

export function applyInventoryToSummary(
  existing: AccountSummary,
  inventory: readonly InventoryItem[],
  updatedAt: number,
): AccountSummary {
  const source: SummarySourceKind = inventory.length === 0 ? 'empty_inventory' : 'inventory';
  const itemViews = inventory.map(toItemView);
  const gridItems = source === 'empty_inventory' ? [] : selectGridItems(itemViews);
  let best: InventoryItem | null = null;
  if (source !== 'empty_inventory') {
    for (const item of inventory) {
      if (!best || Number(item.price ?? 0) > Number(best.price ?? 0)) best = item;
    }
  }
  const thumbSource = best?.ossImgUrl ?? best?.steamImgUrl ?? null;
  return {
    ...existing,
    thumbnail: source === 'empty_inventory' ? null : imageProxyUrl(thumbSource),
    thumbnailSource: source === 'empty_inventory' ? null : thumbSource,
    summaryVersion: 2,
    gridItems,
    summarySource: source,
    summaryUpdatedAt: updatedAt,
  };
}

export function upgradeAccountSummary(
  raw: AccountSummary | null | undefined,
  fallbackUpdatedAt: number | null = null,
): AccountSummary | null {
  if (!raw) return null;
  if (raw.summaryVersion === 2 && Array.isArray(raw.gridItems) && raw.summarySource) {
    return raw;
  }
  const source: SummarySourceKind = raw.summarySource ?? 'display';
  const legacyThumbnail = raw.thumbnail ?? imageProxyUrl(raw.thumbnailSource ?? null);
  const gridItems: ItemView[] =
    source === 'empty_inventory'
      ? []
      : Array.isArray(raw.gridItems) && raw.gridItems.length > 0
        ? raw.gridItems
        : legacyThumbnail
          ? [
              {
                key: 'legacy-thumbnail-0',
                name: '代表饰品',
                exterior: '',
                wear: null,
                price: null,
                image: legacyThumbnail,
                fallbackImage: null,
                rarityColor: null,
                rarityName: '',
                statTrak: false,
                firstType: '',
                stickers: [],
              },
            ]
          : [];
  return {
    ...raw,
    thumbnail: source === 'empty_inventory' ? null : legacyThumbnail,
    thumbnailSource: source === 'empty_inventory' ? null : (raw.thumbnailSource ?? null),
    summaryVersion: 2,
    gridItems,
    summarySource: source,
    summaryUpdatedAt: raw.summaryUpdatedAt ?? fallbackUpdatedAt ?? null,
  };
}

export function mergeAccountSummary(
  incoming: AccountSummary,
  existing: AccountSummary | null | undefined,
): AccountSummary {
  const normIncoming = upgradeAccountSummary(incoming) ?? incoming;
  const normExisting = upgradeAccountSummary(existing);
  if (!normExisting) return normIncoming;
  const existingFromFullInv =
    normExisting.summarySource === 'inventory' || normExisting.summarySource === 'empty_inventory';
  const incomingIsDisplayOnly = normIncoming.summarySource === 'display';
  if (existingFromFullInv && incomingIsDisplayOnly) {
    return {
      ...normIncoming,
      thumbnail: normExisting.thumbnail,
      thumbnailSource: normExisting.thumbnailSource,
      summaryVersion: 2,
      gridItems: normExisting.gridItems,
      summarySource: normExisting.summarySource,
      summaryUpdatedAt: normExisting.summaryUpdatedAt,
    };
  }
  return normIncoming;
}
