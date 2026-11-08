// 饰品条件行（业务流程 §3、§8）：同一行由同一件饰品满足。
// 行内：分类多选取「任一」，皮肤多选取「任一」，二者同时存在时须同一件饰品都满足；
// 行间取交集。方案 schema v1（单分类 + 单名称）读取时升级为 v2。
import { CATEGORY_BY_ID, canonicalCategoryId } from './catalog';
import type { FilterConditions } from './dto';
import { RENT_KINDS, type RentKind } from './rent';

export const FILTER_SCHEMA_VERSION = 2;
export const MAX_ROW_CATEGORIES = 40;
export const MAX_ROW_NAMES = 20;
export const MAX_NAME_LENGTH = 40;

export interface ItemCondition {
  /** 分类词典 id（大类或子类），空数组表示不限 */
  categoryIds: string[];
  /** 皮肤名称，空数组表示不限 */
  names: string[];
}

export function cleanCondition(c: ItemCondition): ItemCondition {
  const categoryIds = [...new Set(c.categoryIds.map(canonicalCategoryId))].filter((id) =>
    CATEGORY_BY_ID.has(id),
  );
  // 选了整个大类时，同一大类下的子类是多余的
  const groups = new Set(categoryIds.filter((id) => CATEGORY_BY_ID.get(id)?.kind === 'first'));
  const pruned = categoryIds.filter((id) => {
    const entry = CATEGORY_BY_ID.get(id);
    return entry?.kind === 'first' || !groups.has(entry?.groupId ?? '');
  });
  const names = [
    ...new Set(c.names.map((n) => n.trim().slice(0, MAX_NAME_LENGTH)).filter(Boolean)),
  ];
  return {
    categoryIds: pruned.slice(0, MAX_ROW_CATEGORIES),
    names: names.slice(0, MAX_ROW_NAMES),
  };
}

export function conditionIsEmpty(c: ItemCondition): boolean {
  return c.categoryIds.length === 0 && c.names.every((n) => !n.trim());
}

/** 把任意版本存下的整套条件转成当前格式；无法识别返回 null。 */
export function upgradeConditions(raw: unknown): FilterConditions | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.items) || typeof r.rentKind !== 'string') return null;
  if (!(RENT_KINDS as readonly string[]).includes(r.rentKind)) return null;
  const items: ItemCondition[] = [];
  for (const item of r.items) {
    const upgraded = upgradeItemCondition(item);
    if (upgraded && !conditionIsEmpty(upgraded)) items.push(upgraded);
  }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    items,
    rentKind: r.rentKind as RentKind,
    priceMin: text(r.priceMin),
    priceMax: text(r.priceMax),
    couponOnly: r.couponOnly === true,
  };
}

/** 把任意版本存下的条件行转成当前格式；无法识别返回 null。 */
export function upgradeItemCondition(raw: unknown): ItemCondition | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.categoryIds) || Array.isArray(r.names)) {
    const ids = Array.isArray(r.categoryIds) ? r.categoryIds : [];
    const names = Array.isArray(r.names) ? r.names : [];
    return cleanCondition({
      categoryIds: ids.filter((x): x is string => typeof x === 'string'),
      names: names.filter((x): x is string => typeof x === 'string'),
    });
  }
  // v1：{ categoryId: string|null, name: string|null }
  const categoryId = typeof r.categoryId === 'string' ? r.categoryId : null;
  const name = typeof r.name === 'string' ? r.name : null;
  return cleanCondition({
    categoryIds: categoryId ? [categoryId] : [],
    names: name ? [name] : [],
  });
}
