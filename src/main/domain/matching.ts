// 饰品条件匹配：同一行由同一件饰品满足（行内分类任一、皮肤任一），行间账号级 AND，
// 命中件数去重（业务流程 §3、§8）。
import { CATEGORY_BY_ID, GROUP_BY_ID } from '../../shared/catalog';
import { conditionIsEmpty, type ItemCondition } from '../../shared/conditions';

export { conditionIsEmpty, type ItemCondition };

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

function categoryMatches(item: MatchableItem, id: string): boolean {
  const entry = CATEGORY_BY_ID.get(id);
  if (!entry) return false;
  if (entry.kind === 'first') {
    const group = GROUP_BY_ID.get(entry.groupId);
    return !!group && normalizeText(item.firstType) === normalizeText(group.firstType);
  }
  const prefix = normalizeText(weaponPrefix(item.marketName));
  return entry.names.some((n) => normalizeText(n) === prefix);
}

export function itemMatches(item: MatchableItem, condition: ItemCondition): boolean {
  if (conditionIsEmpty(condition)) return false;
  if (
    condition.categoryIds.length > 0 &&
    !condition.categoryIds.some((id) => categoryMatches(item, id))
  ) {
    return false;
  }
  const names = condition.names.map((n) => normalizeText(n)).filter(Boolean);
  if (names.length > 0) {
    const market = normalizeText(item.marketName);
    if (!names.some((n) => market.includes(n))) return false;
  }
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

/**
 * 一行条件的平台搜索关键词集合：满足该行的任一饰品，名称至少包含其中一个词。
 * 有皮肤名称时用皮肤名称；否则用各分类的关键词；任一分类没有关键词（大类）时返回 null，
 * 该行不提供候选。
 */
export function conditionKeywords(condition: ItemCondition): string[] | null {
  const names = condition.names.map((n) => n.trim()).filter(Boolean);
  if (names.length > 0) return [...new Set(names)];
  if (condition.categoryIds.length === 0) return null;
  const words: string[] = [];
  for (const id of condition.categoryIds) {
    const keyword = CATEGORY_BY_ID.get(id)?.keyword;
    if (!keyword) return null;
    words.push(keyword);
  }
  return [...new Set(words)];
}
