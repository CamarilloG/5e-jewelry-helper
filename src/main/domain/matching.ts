// 饰品条件匹配：同一行由同一件饰品满足，行间账号级 AND，命中件数去重（业务流程 §3）。
import { CATEGORY_BY_ID } from '../../shared/catalog';

export interface ItemCondition {
  /** 分类词典 id，空表示不限 */
  categoryId: string | null;
  /** 单个中文名称，空表示不限 */
  name: string | null;
}

export interface MatchableItem {
  /** 同一库存内去重键（assetid，缺失时为平台 id） */
  key: string;
  marketName: string;
  firstType: string;
}

/** 归一化：NFKC 统一全半角，去空白与装饰符号，小写。 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[★☆™®©|｜·・'"“”‘’]/g, '')
    .toLowerCase();
}

/** 市场名称的武器前缀：「弯刀（★） | 森林 DDPAT (久经沙场)」→「弯刀」。 */
export function weaponPrefix(marketName: string): string {
  const head = marketName.normalize('NFKC').split('|')[0] ?? '';
  return head
    .replace(/\([^)]*\)/g, '')
    .replace(/[★]/g, '')
    .trim();
}

export function isStatTrak(marketName: string): boolean {
  return /stattrak/i.test(marketName.normalize('NFKC'));
}

export function conditionIsEmpty(condition: ItemCondition): boolean {
  return !condition.categoryId && !(condition.name ?? '').trim();
}

export function itemMatches(item: MatchableItem, condition: ItemCondition): boolean {
  if (conditionIsEmpty(condition)) return false;
  if (condition.categoryId) {
    const entry = CATEGORY_BY_ID.get(condition.categoryId);
    if (!entry) return false;
    if (entry.kind === 'first') {
      if (normalizeText(item.firstType) !== normalizeText(entry.label)) return false;
    } else if (normalizeText(weaponPrefix(item.marketName)) !== normalizeText(entry.label)) {
      return false;
    }
  }
  const name = (condition.name ?? '').trim();
  if (name && !normalizeText(item.marketName).includes(normalizeText(name))) return false;
  return true;
}

export interface MatchResult {
  matched: boolean;
  /** 命中任一条件的不同饰品件数 */
  score: number;
  hitKeys: string[];
}

export function matchInventory(items: MatchableItem[], conditions: ItemCondition[]): MatchResult {
  const active = conditions.filter((c) => !conditionIsEmpty(c));
  if (active.length === 0) return { matched: true, score: 0, hitKeys: [] };
  const hits = new Set<string>();
  let matched = true;
  for (const condition of active) {
    let any = false;
    for (const item of items) {
      if (itemMatches(item, condition)) {
        any = true;
        hits.add(item.key);
      }
    }
    if (!any) matched = false;
  }
  return { matched, score: matched ? hits.size : 0, hitKeys: matched ? [...hits] : [] };
}

/** 为条件选择单个平台搜索关键词：有名称优先名称，否则取分类映射词；无可用词返回 null。 */
export function conditionKeyword(condition: ItemCondition): string | null {
  const name = (condition.name ?? '').trim();
  if (name) return name;
  if (!condition.categoryId) return null;
  return CATEGORY_BY_ID.get(condition.categoryId)?.keyword ?? null;
}
