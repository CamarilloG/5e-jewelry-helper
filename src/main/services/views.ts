// 领域记录 → 界面 DTO。
import type { AccountView, ItemView, PriceView } from '../../shared/dto';
import { RENT_KINDS, type RentPricing, supportedRents, supportsRent } from '../../shared/rent';
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

/** 收藏行与通知使用的摘要：卖点、各租期价格、最高估价饰品缩略图。 */
export interface AccountSummary {
  tags: string[];
  pricing: RentPricing;
  thumbnail: string | null;
  thumbnailSource: string | null;
}

export function summarize(record: AccountRecord, inventory?: InventoryItem[]): AccountSummary {
  const items = inventory && inventory.length > 0 ? inventory : record.displayItems;
  let best: InventoryItem | null = null;
  for (const item of items) {
    if (!best || Number(item.price ?? 0) > Number(best.price ?? 0)) best = item;
  }
  const source = best?.ossImgUrl ?? best?.steamImgUrl ?? null;
  return {
    tags: record.tags,
    pricing: record.pricing,
    thumbnail: imageProxyUrl(source),
    thumbnailSource: source,
  };
}
