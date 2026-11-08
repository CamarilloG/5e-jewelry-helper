// 饰品条件匹配：同一行由同一件饰品满足（行内分类任一、皮肤任一），行间账号级 AND，
// 命中件数去重（业务流程 §3、§8）。支持规范化条件指纹（B4/R11）与查询规划（A1/A3/A4）。
import {
  CATEGORY_BY_ID,
  canonicalCategoryId,
  categorySupportsCoverage,
  categorySupportsFastPath,
  expandGroupCategoryIds,
  GROUP_BY_ID,
  getCategoryEvidence,
  isCategoryDowngraded,
} from '../../shared/catalog';
import { cleanCondition, conditionIsEmpty, type ItemCondition } from '../../shared/conditions';

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
  const entry = CATEGORY_BY_ID.get(canonicalCategoryId(id));
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

export function matchInventory(
  items: readonly MatchableItem[],
  conditions: readonly ItemCondition[],
): MatchResult {
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
    const keyword = CATEGORY_BY_ID.get(canonicalCategoryId(id))?.keyword;
    if (!keyword) return null;
    words.push(keyword);
  }
  return [...new Set(words)];
}

/**
 * B4 (R11) 规范化饰品条件指纹：
 * - 条件行顺序调整不影响指纹
 * - 重复行不重复计数
 * - 行内同件约束保留
 */
export function conditionFingerprint(conditions: readonly ItemCondition[]): string {
  const rowSet = new Set<string>();
  for (const raw of conditions) {
    const c = cleanCondition(raw);
    if (conditionIsEmpty(c)) continue;
    const cats = [...new Set(c.categoryIds.map(canonicalCategoryId))].sort();
    const names = [...new Set(c.names.map(normalizeText).filter(Boolean))].sort();
    rowSet.add(`c:${cats.join(',')}|n:${names.join(',')}`);
  }
  return [...rowSet].sort().join(';');
}

export interface PlannedConditionRow {
  index: number;
  condition: ItemCondition;
  /** 平台搜索关键词并集（行内 OR） */
  keywords: string[];
  /** 每个关键词对应的备选别名（用于 A2 零结果回退） */
  fallbackAliases: Record<string, string[]>;
  /** 涉及的分类编码 */
  categoryIds: string[];
  /** 该行关键词并集是否具备覆盖证据（可作为过滤候选的必要条件） */
  coverageVerified: boolean;
  /** 该行是否允许走 A3 搜索证据快速路径（仅类别、无皮肤，且所有类别 precision+coverage 已认证） */
  fastPathEligible: boolean;
  /** 该行是否包含未验证或已降级关键词（返回 0 时属于可疑零结果，需走 A2 回退） */
  suspiciousOnZero: boolean;
}

export function planConditionRow(rawCond: ItemCondition, index: number): PlannedConditionRow {
  const c = cleanCondition(rawCond);
  const names = [...new Set(c.names.map((n) => n.trim()).filter(Boolean))];
  if (names.length > 0) {
    return {
      index,
      condition: c,
      keywords: names,
      fallbackAliases: {},
      categoryIds: c.categoryIds.map(canonicalCategoryId),
      coverageVerified: true,
      fastPathEligible: false,
      suspiciousOnZero: false,
    };
  }

  const keywords = new Set<string>();
  const fallbackAliases: Record<string, string[]> = {};
  const categoryIds = c.categoryIds.map(canonicalCategoryId);
  let allFastPath = categoryIds.length > 0;
  let allCoverage = categoryIds.length > 0;
  let suspiciousOnZero = false;
  let cannotUseKeywordUnion = false;

  for (const id of categoryIds) {
    const entry = CATEGORY_BY_ID.get(id);
    const ev = getCategoryEvidence(id);
    if (!entry || !ev) {
      allFastPath = false;
      allCoverage = false;
      suspiciousOnZero = true;
      cannotUseKeywordUnion = true;
      continue;
    }

    if (entry.keyword) {
      keywords.add(entry.keyword);
      if (ev.fallbackAliases?.length) {
        fallbackAliases[entry.keyword] = [...ev.fallbackAliases];
      }
      if (!categorySupportsFastPath(id)) allFastPath = false;
      if (!categorySupportsCoverage(id)) allCoverage = false;
      if (ev.queryable !== 'verified' || ev.coverage !== 'verified' || isCategoryDowngraded(id)) {
        suspiciousOnZero = true;
      }
    } else if (entry.expandedKeywords && entry.expandedKeywords.length > 0) {
      for (const kw of entry.expandedKeywords) {
        keywords.add(kw);
      }
      if (ev.fallbackAliases?.length && entry.expandedKeywords[0]) {
        fallbackAliases[entry.expandedKeywords[0]] = [...ev.fallbackAliases];
      }
      if (!categorySupportsFastPath(id)) allFastPath = false;
      if (!categorySupportsCoverage(id)) allCoverage = false;
      if (ev.queryable !== 'verified' || ev.coverage !== 'verified' || isCategoryDowngraded(id)) {
        suspiciousOnZero = true;
      }
    } else if (entry.kind === 'first') {
      const subIds = expandGroupCategoryIds(id);
      const subFast = subIds.length > 0 && subIds.every((sid) => categorySupportsFastPath(sid));
      const subCov = subIds.length > 0 && subIds.every((sid) => categorySupportsCoverage(sid));
      if (subFast && subCov && subIds.length <= 8) {
        for (const sid of subIds) {
          const subEntry = CATEGORY_BY_ID.get(sid);
          if (subEntry?.keyword) keywords.add(subEntry.keyword);
        }
      } else {
        allFastPath = false;
        allCoverage = false;
        suspiciousOnZero = true;
        cannotUseKeywordUnion = true;
      }
    } else {
      allFastPath = false;
      allCoverage = false;
      suspiciousOnZero = true;
      cannotUseKeywordUnion = true;
    }
  }

  if (cannotUseKeywordUnion) {
    return {
      index,
      condition: c,
      keywords: [],
      fallbackAliases: {},
      categoryIds,
      coverageVerified: false,
      fastPathEligible: false,
      suspiciousOnZero: true,
    };
  }

  return {
    index,
    condition: c,
    keywords: [...keywords],
    fallbackAliases,
    categoryIds,
    coverageVerified: allCoverage && keywords.size > 0,
    fastPathEligible: allFastPath && keywords.size > 0,
    suspiciousOnZero,
  };
}

export function planConditionRows(conditions: readonly ItemCondition[]): PlannedConditionRow[] {
  const active = conditions.map(cleanCondition).filter((c) => !conditionIsEmpty(c));
  return active.map((c, idx) => planConditionRow(c, idx));
}
