// 筛选扫描（业务流程 §3，v1.0.3 修订）：IDLE → CANDIDATES → VERIFYING → COMPLETE，可 STOPPED / FAILED。
// 支持：
// - A1/A2：关键词三类独立证据、可疑零结果回退（别名 → 其他可靠行 → 空关键词浏览 + 完整库存确认 → 候选来源不可用）
// - A3：已认证纯类别行搜索证据快速路径（evidence='search'，未读库存时 score/hitCount 为 null；库存确认不符时撤销并降级）
// - A4：大类展开与按成本规划求交（比较剩余搜索页成本与未缓存候选库存确认成本，不用不完整分页排除可靠来源）
// - A5：逐页逐账号流式输出（满足全部条件行即输出，首条立即推送，后续 100–300 ms 节流；读到候选页即开始核验首条结果）
// - A6：5 分钟分页搜索缓存（按查询范围与代际隔离，支持候选快照时间与 forceRefresh 强制刷新）
// - A7：任务完整性与恢复（保存各来源页游标、已去重账号、条件证据、待确认队列、失败页；区分完成与覆盖完整及 partialReasons）
// - B1–B4：上次结果按账号增量合并、独立本地匹配入口（startLocal）、小条件变化复用、两层缓存联动
import Decimal from 'decimal.js';
import {
  CATALOG_VERSION,
  categorySupportsFastPath,
  downgradeCategoryEvidence,
} from '../../shared/catalog';
import { cleanCondition } from '../../shared/conditions';
import type {
  FailedSearchPage,
  FilterConditions,
  ItemView,
  MatchEvidenceKind,
  ScanResultView,
  ScanView,
} from '../../shared/dto';
import { RENT_META, supportsRent } from '../../shared/rent';
import {
  conditionFingerprint,
  conditionIsEmpty,
  type ItemCondition,
  matchInventory,
  type PlannedConditionRow,
  planConditionRows,
} from '../domain/matching';
import type { Logger } from '../logger';
import type { PlatformApi } from '../platform/api';
import { isCancelled, PlatformError, userMessage } from '../platform/errors';
import { Priority } from '../platform/queue';
import type { AccountRecord, InventoryItem } from '../platform/schemas';
import type { AccountService } from './account-service';
import { selectFillItems, toAccountView, toItemView } from './views';

interface Candidate {
  accountNo: string;
  record: AccountRecord;
  origin: 'platform' | 'local';
  searchMatchedAllRows: boolean;
}

interface KeywordPaginationState {
  keyword: string;
  nextPage: number;
  total: number | null;
  records: Map<string, AccountRecord>;
  done: boolean;
  complete: boolean;
  failedPages: number[];
  fromCache: boolean;
  snapshotAt: number | null;
}

interface CachedSearchPage {
  accounts: AccountRecord[];
  total: number;
  fetchedAt: number;
}

interface SearchScopeCacheEntry {
  scopeKey: string;
  userScope: string;
  keyword: string;
  generation: number;
  snapshotAt: number;
  pages: Map<number, CachedSearchPage>;
  total: number | null;
  complete: boolean;
  failureReason: string | null;
  ruleVersion: string;
}

interface UserQuerySnapshot {
  userScope: string;
  conditions: FilterConditions;
  itemFingerprint: string;
  catalogVersion: string;
  results: Map<string, ScanResultView>;
  records: Map<string, { record: AccountRecord; fetchedAt: number }>;
  coverageComplete: boolean;
  snapshotAt: number;
}

export interface ScanStartOptions {
  forceRefresh?: boolean;
}

const MAX_PAGES_PER_KEYWORD = 200;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const DETAIL_FRESH_TTL_MS = 30 * 1000;

export function fitsBasics(record: AccountRecord, c: FilterConditions): boolean {
  if (!supportsRent(record.pricing, c.rentKind)) return false;
  const price = record.pricing.prices[c.rentKind];
  if (!price) return false;
  try {
    const value = new Decimal(price);
    if (c.priceMin != null && value.lt(c.priceMin)) return false;
    if (c.priceMax != null && value.gt(c.priceMax)) return false;
  } catch {
    return false;
  }
  if (c.couponOnly && !record.useCoupon) return false;
  return true;
}

/** 判断新条件是否为旧完整快照在相同饰品指纹与租期下的价格/用券收紧（B3 R10）。 */
function isTightenedConditionSubset(prev: FilterConditions, next: FilterConditions): boolean {
  if (prev.rentKind !== next.rentKind) return false;
  if (prev.couponOnly && !next.couponOnly) return false;
  let stricter = !prev.couponOnly && next.couponOnly;
  try {
    if (prev.priceMin != null) {
      if (next.priceMin == null) return false;
      const prevMin = new Decimal(prev.priceMin);
      const nextMin = new Decimal(next.priceMin);
      if (nextMin.lt(prevMin)) return false;
      if (nextMin.gt(prevMin)) stricter = true;
    } else if (next.priceMin != null) {
      stricter = true;
    }
    if (prev.priceMax != null) {
      if (next.priceMax == null) return false;
      const prevMax = new Decimal(prev.priceMax);
      const nextMax = new Decimal(next.priceMax);
      if (nextMax.gt(prevMax)) return false;
      if (nextMax.lt(prevMax)) stricter = true;
    } else if (next.priceMax != null) {
      stricter = true;
    }
  } catch {
    return false;
  }
  return stricter;
}

export class ScanService {
  private scanId = 0;
  private token = 0;
  private view: ScanView = emptyView(0);

  // 当前任务可恢复上下文（A7 R14）
  private plannedRows: PlannedConditionRow[] = [];
  private keywordStates = new Map<string, KeywordPaginationState>();
  private rowDelegated = new Set<number>();
  private accountRowHits = new Map<string, Set<number>>();
  private discoveredRecords = new Map<string, AccountRecord>();
  private earlyVerified = new Set<string>();
  private candidates: Candidate[] = [];
  private candidatesReady = false;
  private cursor = 0;
  private retryQueue: string[] = [];
  private historyToReverify = new Set<string>();
  private partialReasonSet = new Set<string>();
  private failedPageMap = new Map<string, Map<number, string>>();
  private searchComplete = true;
  private forceRefresh = false;
  private firstResultFlushed = false;
  private activeUserScope = '__default__';
  private activeRuleVersion = CATALOG_VERSION;

  // 5 分钟分页搜索缓存（A6 R07）与用户级查询结果快照（B1/B3/B4）
  private searchCache = new Map<string, SearchScopeCacheEntry>();
  private searchGenerationSeq = 1;
  private userSnapshots = new Map<string, UserQuerySnapshot[]>();
  private userKnownRecords = new Map<
    string,
    Map<string, { record: AccountRecord; fetchedAt: number }>
  >();

  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: PlatformApi,
    private readonly accounts: AccountService,
    private readonly localFavorites: () => Promise<Set<string>>,
    private readonly onChange: (view: ScanView) => void,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
    private readonly profileId: () => string | null = () => '__default__',
    private readonly isOnline: () => boolean = () => true,
  ) {
    // A3（R04）：打开详情或补读完整库存后，核对当前搜索证据匹配结果；若不符则立即撤销并降级关键词证据
    this.accounts.onInventoryLoaded((accountNo, items) => {
      this.handleInventoryLoaded(accountNo, items);
    });
  }

  state(): ScanView {
    return this.view;
  }

  isActive() {
    return this.view.phase === 'CANDIDATES' || this.view.phase === 'VERIFYING';
  }

  private group() {
    return `scan:${this.scanId}`;
  }

  private currentUserScope(): string {
    return this.profileId() ?? '__default__';
  }

  /** 清除搜索分页缓存与历史结果快照（配合 cache.clear）。 */
  clearCaches() {
    this.searchCache.clear();
    this.userSnapshots.clear();
    this.userKnownRecords.clear();
  }

  /** 测试辅助：模拟关键词规则版本升级（R07）。 */
  setRuleVersionForTest(version: string) {
    this.activeRuleVersion = version;
  }

  private handleInventoryLoaded(accountNo: string, items: InventoryItem[]) {
    const conditions = this.view.conditions;
    if (!conditions) return;
    const rows = conditions.items.filter((x) => !conditionIsEmpty(x));
    if (rows.length === 0) return;
    const existing = this.view.results.find((r) => r.account.accountNo === accountNo);
    if (!existing) return;

    const match = matchInventory(
      items.map((i) => ({ key: i.key, marketName: i.marketName, firstType: i.firstType })),
      rows,
    );
    if (!match.matched) {
      // 完整库存证实不符：撤销匹配，并对未能命中的已认证类别降级证据
      for (const row of rows) {
        const rowMatch = matchInventory(
          items.map((i) => ({ key: i.key, marketName: i.marketName, firstType: i.firstType })),
          [row],
        );
        if (!rowMatch.matched && row.names.length === 0) {
          for (const catId of row.categoryIds) {
            if (categorySupportsFastPath(catId)) {
              downgradeCategoryEvidence(catId);
            }
          }
        }
      }
      this.removeResult(accountNo);
      this.flush();
      return;
    }

    if (existing.evidence === 'search') {
      const hit = new Set(match.hitKeys);
      const hitItems = items
        .filter((i) => hit.has(i.key))
        .sort((a, b) => Number(b.price ?? 0) - Number(a.price ?? 0))
        .slice(0, 4)
        .map(toItemView);
      this.upsertResult({
        ...existing,
        score: match.score,
        hitCount: match.score,
        hitItems,
        fillItems: selectFillItems(items, hit),
        evidence: 'inventory',
        verifiedAt: this.now(),
      });
      this.flush();
    }
  }

  start(input: FilterConditions, options: ScanStartOptions = {}): ScanView {
    this.halt();
    this.scanId += 1;
    this.activeUserScope = this.currentUserScope();
    this.forceRefresh = Boolean(options.forceRefresh);
    if (this.forceRefresh) {
      this.invalidateUserSearchCache(this.activeUserScope);
    }

    const conditions: FilterConditions = {
      ...input,
      items: input.items.map(cleanCondition).filter((c) => !conditionIsEmpty(c)),
    };
    const items = conditions.items;
    this.plannedRows = planConditionRows(items);
    this.keywordStates.clear();
    this.rowDelegated.clear();
    this.accountRowHits.clear();
    this.discoveredRecords.clear();
    this.earlyVerified.clear();
    this.candidates = [];
    this.candidatesReady = false;
    this.cursor = 0;
    this.retryQueue = [];
    this.historyToReverify.clear();
    this.partialReasonSet.clear();
    this.failedPageMap.clear();
    this.searchComplete = true;
    this.firstResultFlushed = false;

    for (const r of this.plannedRows) {
      if (!r.keywords || r.keywords.length === 0) {
        this.rowDelegated.add(r.index);
      }
    }

    // B1（R08）& B3（R10）：在发起远程搜索前先加载当前用户范围内的历史命中结果
    const initialHistory = this.loadInitialHistoryResults(this.activeUserScope, conditions);
    for (const r of initialHistory.results) {
      this.historyToReverify.add(r.account.accountNo);
    }

    this.view = {
      ...emptyView(this.scanId),
      phase: 'CANDIDATES',
      conditions: structuredClone(conditions),
      hasItemConditions: items.length > 0,
      results: initialHistory.results,
      snapshotAt: initialHistory.snapshotAt,
      fromCache: initialHistory.results.length > 0,
      startedAt: this.now(),
    };
    if (initialHistory.results.length > 0) {
      this.firstResultFlushed = true;
    }

    this.logger.info('scan.start', {
      count: items.length,
      kind: conditions.rentKind,
      forceRefresh: this.forceRefresh,
    });
    void this.run(this.token);
    this.flush();
    return this.view;
  }

  /** B2（R09）：独立于在线认证的本地匹配入口。 */
  startLocal(input: FilterConditions): ScanView {
    this.halt();
    this.scanId += 1;
    this.activeUserScope = this.currentUserScope();
    const conditions: FilterConditions = {
      ...input,
      items: input.items.map(cleanCondition).filter((c) => !conditionIsEmpty(c)),
    };
    const items = conditions.items;
    this.plannedRows = planConditionRows(items);
    this.keywordStates.clear();
    this.rowDelegated.clear();
    this.accountRowHits.clear();
    this.discoveredRecords.clear();
    this.earlyVerified.clear();
    this.candidates = [];
    this.candidatesReady = true;
    this.cursor = 0;
    this.retryQueue = [];
    this.historyToReverify.clear();
    this.partialReasonSet.clear();
    this.failedPageMap.clear();
    this.firstResultFlushed = false;

    // 第一批：立即返回当前用户范围内已知历史命中（避免遍历全部本地库存导致首屏等待）
    const initialHistory = this.loadInitialHistoryResults(this.activeUserScope, conditions, {
      markStale: true,
    });

    this.view = {
      ...emptyView(this.scanId),
      phase: 'VERIFYING',
      conditions: structuredClone(conditions),
      hasItemConditions: items.length > 0,
      discoveryComplete: true,
      localOnly: true,
      fromCache: true,
      snapshotAt: initialHistory.snapshotAt,
      results: initialHistory.results,
      startedAt: this.now(),
    };
    this.flush();
    void this.runLocal(this.token, conditions);
    return this.view;
  }

  stop(): ScanView {
    if (!this.isActive()) return this.view;
    this.halt();
    this.view = {
      ...this.view,
      phase: 'STOPPED',
      incomplete: true,
      coverageComplete: false,
    };
    this.saveCurrentSnapshot(false);
    this.flush();
    return this.view;
  }

  continue(): ScanView {
    if (this.view.phase !== 'STOPPED' || !this.view.conditions) return this.view;
    this.token += 1;
    this.view = {
      ...this.view,
      phase: this.candidatesReady ? 'VERIFYING' : 'CANDIDATES',
      error: null,
      finishedAt: null,
    };
    void this.run(this.token);
    this.flush();
    return this.view;
  }

  retryFailed(): ScanView {
    if (
      this.isActive() ||
      (this.view.failedAccounts.length === 0 && (this.view.failedPages?.length ?? 0) === 0) ||
      !this.view.conditions
    ) {
      return this.view;
    }
    this.token += 1;
    const hasFailedPages = (this.view.failedPages?.length ?? 0) > 0;
    if (hasFailedPages) {
      for (const fp of this.view.failedPages ?? []) {
        const st = this.keywordStates.get(fp.keyword);
        if (st) {
          st.failedPages = [];
          st.complete = true;
          st.done = false;
          if (fp.page < st.nextPage) st.nextPage = fp.page;
        }
      }
      this.failedPageMap.clear();
      this.partialReasonSet.delete('缺页');
      this.partialReasonSet.delete('候选来源不可用');
      this.searchComplete = true;
      this.candidatesReady = false;
    }
    this.retryQueue = [...this.view.failedAccounts];
    this.partialReasonSet.delete('失败账号未重试');
    this.view = {
      ...this.view,
      phase: hasFailedPages ? 'CANDIDATES' : 'VERIFYING',
      failedAccounts: [],
      failedPages: [],
      partialReasons: [...this.partialReasonSet],
      incomplete: this.partialReasonSet.size > 0,
      confirmed: Math.max(0, this.view.confirmed - this.retryQueue.length),
      error: null,
      emptyReason: null,
      finishedAt: null,
    };
    void this.run(this.token);
    this.flush();
    return this.view;
  }

  /** 登录失效等外部原因暂停：取消排队请求，保留结果与游标。 */
  interrupt(reason: string) {
    if (!this.isActive()) return;
    this.halt();
    this.view = {
      ...this.view,
      phase: 'STOPPED',
      error: reason,
      incomplete: true,
      coverageComplete: false,
    };
    this.saveCurrentSnapshot(false);
    this.flush();
  }

  private halt() {
    this.token += 1;
    this.api.queue.cancelGroup(this.group());
  }

  private alive(token: number) {
    return token === this.token;
  }

  private addPartialReason(reason: string) {
    this.partialReasonSet.add(reason);
    this.view = {
      ...this.view,
      incomplete: true,
      coverageComplete: false,
      partialReasons: [...this.partialReasonSet],
    };
  }

  private recordFailedPage(keyword: string, page: number, errorMsg: string) {
    let map = this.failedPageMap.get(keyword);
    if (!map) {
      map = new Map();
      this.failedPageMap.set(keyword, map);
    }
    map.set(page, errorMsg);
    const failedPages: FailedSearchPage[] = [];
    for (const [kw, pages] of this.failedPageMap) {
      for (const [p, err] of pages) failedPages.push({ keyword: kw, page: p, error: err });
    }
    this.view = {
      ...this.view,
      failedPages,
    };
  }

  private async run(token: number) {
    try {
      const cleared = await this.accounts.syncCacheEpoch();
      if (!this.alive(token)) return;
      if (cleared) {
        this.clearCaches();
        this.historyToReverify.clear();
        this.view = {
          ...this.view,
          results: [],
          fromCache: false,
          snapshotAt: null,
        };
      }

      if (!this.candidatesReady) {
        await this.collectCandidates(token);
        if (!this.alive(token)) return;
      }
      await this.verify(token);
      if (!this.alive(token)) return;

      const hasFailedAccounts = this.view.failedAccounts.length > 0;
      if (hasFailedAccounts) {
        this.addPartialReason('失败账号未重试');
      }
      const hasFailedPages = (this.view.failedPages?.length ?? 0) > 0;
      const incomplete =
        this.view.incomplete ||
        !this.searchComplete ||
        hasFailedAccounts ||
        hasFailedPages ||
        this.partialReasonSet.size > 0;
      const coverageComplete = !incomplete && Boolean(this.view.discoveryComplete);

      this.view = {
        ...this.view,
        phase: 'COMPLETE',
        incomplete,
        coverageComplete,
        partialReasons: [...this.partialReasonSet],
        pendingCount: 0,
        finishedAt: this.now(),
      };
      this.saveCurrentSnapshot(coverageComplete);
      this.logger.info('scan.complete', {
        count: this.view.results.length,
        state: incomplete ? 'INCOMPLETE' : 'FULL',
      });
      this.flush();
    } catch (error) {
      if (!this.alive(token) || isCancelled(error)) return;
      this.halt();
      this.view = {
        ...this.view,
        phase: 'FAILED',
        error: userMessage(error),
        incomplete: true,
        coverageComplete: false,
        finishedAt: this.now(),
      };
      this.saveCurrentSnapshot(false);
      this.logger.warn('scan.failed', {
        reason: error instanceof PlatformError ? error.code : 'ERROR',
      });
      this.flush();
    }
  }

  private async runLocal(token: number, conditions: FilterConditions) {
    try {
      const cleared = await this.accounts.syncCacheEpoch();
      if (!this.alive(token)) return;
      if (cleared) {
        this.clearCaches();
        this.view = { ...this.view, results: [], snapshotAt: null };
      }

      const rows = conditions.items.filter((x) => !conditionIsEmpty(x));
      const favorites = await this.localFavorites();
      const snapshots = await this.accounts.knownAccountSnapshots();
      const validInventories = await this.accounts.allValidInventories();
      if (!this.alive(token)) return;

      const recordMap = new Map<string, { record: AccountRecord; fetchedAt: number }>();
      for (const snap of snapshots) {
        recordMap.set(snap.record.accountNo, snap);
      }
      const userKnown = this.userKnownRecords.get(this.activeUserScope);
      if (userKnown) {
        for (const [no, snap] of userKnown) {
          if (!recordMap.has(no)) recordMap.set(no, snap);
        }
      }

      if (
        recordMap.size === 0 &&
        validInventories.size === 0 &&
        favorites.size === 0 &&
        (this.view.results?.length ?? 0) === 0
      ) {
        this.view = {
          ...this.view,
          phase: 'COMPLETE',
          discoveryComplete: true,
          coverageComplete: false,
          localOnly: true,
          emptyReason: 'NO_LOCAL_RECORDS',
          finishedAt: this.now(),
        };
        this.flush();
        return;
      }

      const online = this.isOnline();
      const now = this.now();
      let earliestSnapshotAt: number | null = this.view.snapshotAt ?? null;
      let checked = 0;

      for (const [accountNo, snap] of recordMap) {
        if (!this.alive(token)) return;
        const { record, fetchedAt } = snap;
        if (
          !favorites.has(accountNo) &&
          !userKnown?.has(accountNo) &&
          !validInventories.has(accountNo)
        ) {
          continue;
        }
        if (!fitsBasics(record, conditions)) {
          this.removeResult(accountNo);
          continue;
        }

        let score: number | null = 0;
        let hitCount: number | null = 0;
        let hitItems: InventoryItem[] = [];
        let fillItems: ItemView[] | undefined;
        let evidence: MatchEvidenceKind = 'inventory';
        let verifiedAt = fetchedAt;

        if (rows.length > 0) {
          const inv =
            validInventories.get(accountNo) ?? this.accounts.peekMemoryInventory(accountNo);
          if (inv) {
            const match = this.accounts.matchInventoryWithCache(
              accountNo,
              inv.items,
              inv.fetchedAt,
              rows,
            );
            if (!match.matched) {
              this.removeResult(accountNo);
              continue;
            }
            score = match.score;
            hitCount = match.score;
            verifiedAt = match.verifiedAt;
            const hit = new Set(match.hitKeys);
            fillItems = selectFillItems(inv.items, hit);
            hitItems = inv.items
              .filter((i: InventoryItem) => hit.has(i.key))
              .sort(
                (a: InventoryItem, b: InventoryItem) => Number(b.price ?? 0) - Number(a.price ?? 0),
              );
          } else {
            // 无有效完整库存缓存时，仅允许复用同用户同饰品指纹的历史搜索证据
            const existing = this.view.results.find((r) => r.account.accountNo === accountNo);
            if (!existing) continue;
            score = existing.score;
            hitCount = existing.hitCount;
            fillItems = existing.fillItems;
            evidence = existing.evidence ?? 'search';
            verifiedAt = existing.verifiedAt ?? fetchedAt;
          }
        }

        checked += 1;
        earliestSnapshotAt =
          earliestSnapshotAt == null ? fetchedAt : Math.min(earliestSnapshotAt, fetchedAt);

        const isStale = !online || !record.statusKnown || now - fetchedAt > DETAIL_FRESH_TTL_MS;
        const accountView = toAccountView(record, fetchedAt);
        if (isStale) {
          accountView.status = 'UNKNOWN';
        }

        this.upsertResult({
          account: accountView,
          score,
          hitItems: hitItems.slice(0, 4).map(toItemView),
          fillItems,
          hitCount,
          favorite: favorites.has(accountNo),
          origin: 'local',
          evidence,
          verifiedAt,
          fromHistory: true,
          reverifyFailed: false,
          stale: isStale,
        });
      }

      this.view = {
        ...this.view,
        phase: 'COMPLETE',
        candidates: checked,
        confirmed: checked,
        checkedCount: checked,
        pendingCount: 0,
        discoveryComplete: true,
        coverageComplete: false,
        localOnly: true,
        fromCache: true,
        snapshotAt: earliestSnapshotAt ?? now,
        emptyReason: this.view.results.length === 0 && checked === 0 ? 'NO_LOCAL_RECORDS' : null,
        finishedAt: now,
      };
      this.flush();
    } catch (error) {
      if (!this.alive(token) || isCancelled(error)) return;
      this.view = {
        ...this.view,
        phase: 'FAILED',
        error: userMessage(error),
        incomplete: true,
        coverageComplete: false,
        finishedAt: this.now(),
      };
      this.flush();
    }
  }

  private scopeKeyFor(keyword: string, c: FilterConditions): string {
    return JSON.stringify({
      user: this.activeUserScope,
      kw: keyword,
      rent: c.rentKind,
      coupon: c.couponOnly ? 1 : 0,
      size: 100,
      sort: 'default',
      ver: this.activeRuleVersion,
    });
  }

  private invalidateUserSearchCache(userScope: string) {
    for (const [key, entry] of this.searchCache) {
      if (entry.userScope === userScope) {
        this.searchCache.delete(key);
      }
    }
  }

  private async fetchSearchPage(
    keyword: string,
    page: number,
    token: number,
  ): Promise<{ accounts: AccountRecord[]; total: number; fetchedAt: number; fromCache: boolean }> {
    const c = this.view.conditions as FilterConditions;
    const key = this.scopeKeyFor(keyword, c);
    const now = this.now();
    let entry = this.searchCache.get(key);

    if (
      entry &&
      !this.forceRefresh &&
      entry.ruleVersion === this.activeRuleVersion &&
      now - entry.snapshotAt < SEARCH_CACHE_TTL_MS
    ) {
      const cachedPage = entry.pages.get(page);
      if (cachedPage) {
        this.view = {
          ...this.view,
          fromCache: true,
          snapshotAt:
            this.view.snapshotAt == null
              ? cachedPage.fetchedAt
              : Math.min(this.view.snapshotAt, cachedPage.fetchedAt),
        };
        return {
          accounts: cachedPage.accounts,
          total: cachedPage.total,
          fetchedAt: cachedPage.fetchedAt,
          fromCache: true,
        };
      }
    } else if (entry) {
      // 已过期、强制刷新或规则升级：开启新代际，不与旧代际页拼接
      this.searchCache.delete(key);
      entry = undefined;
    }

    const result = await this.api.search(
      { keyword, page, rentKind: c.rentKind, couponOnly: c.couponOnly },
      { priority: Priority.SCAN, group: this.group() },
    );
    if (!this.alive(token)) {
      return { accounts: [], total: 0, fetchedAt: now, fromCache: false };
    }

    const fetchedAt = this.now();
    if (!entry) {
      entry = {
        scopeKey: key,
        userScope: this.activeUserScope,
        keyword,
        generation: this.searchGenerationSeq++,
        snapshotAt: fetchedAt,
        pages: new Map(),
        total: result.total,
        complete: false,
        failureReason: null,
        ruleVersion: this.activeRuleVersion,
      };
      this.searchCache.set(key, entry);
    }
    entry.total = result.total;
    entry.pages.set(page, {
      accounts: result.accounts,
      total: result.total,
      fetchedAt,
    });
    return {
      accounts: result.accounts,
      total: result.total,
      fetchedAt,
      fromCache: false,
    };
  }

  private getOrCreateKeywordState(keyword: string): KeywordPaginationState {
    let st = this.keywordStates.get(keyword);
    if (!st) {
      st = {
        keyword,
        nextPage: 1,
        total: null,
        records: new Map(),
        done: false,
        complete: true,
        failedPages: [],
        fromCache: false,
        snapshotAt: null,
      };
      this.keywordStates.set(keyword, st);
    }
    return st;
  }

  private async ensureKeywordPage1(
    keyword: string,
    token: number,
    rowIndex: number | null,
  ): Promise<KeywordPaginationState> {
    const st = this.getOrCreateKeywordState(keyword);
    if (st.nextPage > 1 || st.done) {
      if (rowIndex != null && st.records.size > 0) {
        this.recordRowPageHits(rowIndex, [...st.records.values()]);
      }
      return st;
    }

    try {
      const res = await this.fetchSearchPage(keyword, 1, token);
      if (!this.alive(token)) return st;
      st.total = res.total;
      st.fromCache = st.fromCache || res.fromCache;
      st.snapshotAt = res.fetchedAt;
      for (const acc of res.accounts) {
        st.records.set(acc.accountNo, acc);
        this.discoveredRecords.set(acc.accountNo, acc);
      }
      st.nextPage = 2;
      if (res.accounts.length === 0 && res.total > 0) {
        st.complete = false;
        st.done = true;
        this.searchComplete = false;
        this.addPartialReason('提前遇到空页');
      } else if (res.accounts.length === 0 || st.records.size >= res.total) {
        st.done = true;
      }
      if (rowIndex != null) {
        this.recordRowPageHits(rowIndex, res.accounts);
      }
    } catch (error) {
      if (isCancelled(error)) throw error;
      if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
      st.complete = false;
      st.failedPages.push(1);
      this.searchComplete = false;
      this.recordFailedPage(keyword, 1, userMessage(error));
      this.addPartialReason('缺页');
    }
    return st;
  }

  private async fetchKeywordRemainingPages(
    keyword: string,
    token: number,
    rowIndex: number | null,
  ): Promise<KeywordPaginationState> {
    const st = await this.ensureKeywordPage1(keyword, token, rowIndex);
    if (!this.alive(token) || st.done || !st.complete) return st;

    // A5（R05）：若当前属于单条件行（或无需额外搜索行）且需要库存确认，在请求第 2 页前先核验第 1 页首个命中候选，
    // 确保后续分页阻塞时首条匹配卡片依然已经推送并可见
    if (this.view.results.length === 0 && st.records.size > 0 && this.plannedRows.length <= 1) {
      await this.verifyFirstReadyFromPage([...st.records.values()], token);
      if (!this.alive(token)) return st;
    }

    for (let page = st.nextPage; !st.done && page <= MAX_PAGES_PER_KEYWORD; page = st.nextPage) {
      if (!this.alive(token)) return st;
      let res: { accounts: AccountRecord[]; total: number; fetchedAt: number; fromCache: boolean };
      try {
        res = await this.fetchSearchPage(keyword, page, token);
      } catch (error) {
        if (isCancelled(error)) throw error;
        if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
        st.complete = false;
        st.failedPages.push(page);
        this.searchComplete = false;
        this.recordFailedPage(keyword, page, userMessage(error));
        this.addPartialReason('缺页');
        break;
      }
      if (!this.alive(token)) return st;

      if (st.total != null && res.total !== st.total) {
        this.addPartialReason('total 变化未确认');
        st.complete = false;
        this.searchComplete = false;
      }
      st.total = res.total;
      st.nextPage = page + 1;

      if (res.accounts.length === 0) {
        if (st.records.size < (st.total ?? 0)) {
          st.complete = false;
          this.searchComplete = false;
          this.addPartialReason('提前遇到空页');
        }
        st.done = true;
        break;
      }

      let fresh = 0;
      for (const acc of res.accounts) {
        if (!st.records.has(acc.accountNo)) fresh += 1;
        st.records.set(acc.accountNo, acc);
        this.discoveredRecords.set(acc.accountNo, acc);
      }
      if (rowIndex != null) {
        this.recordRowPageHits(rowIndex, res.accounts);
      }

      if (fresh === 0) {
        st.complete = false;
        this.searchComplete = false;
        this.addPartialReason('重复页');
        st.done = true;
        break;
      }
      if (st.records.size >= (st.total ?? 0)) {
        st.done = true;
        break;
      }
      if (page === MAX_PAGES_PER_KEYWORD && st.records.size < (st.total ?? 0)) {
        st.complete = false;
        this.searchComplete = false;
        this.addPartialReason('达到 200 页上限被截断');
        st.done = true;
        break;
      }
    }
    return st;
  }

  /** A5（R05）：每拿到一页结果按账号记录行命中；若全部条件行均满足搜索快速路径证据，立即输出卡片。 */
  private recordRowPageHits(rowIndex: number, accounts: AccountRecord[]) {
    const c = this.view.conditions;
    if (!c || this.plannedRows.length === 0) return;

    const allFastPath =
      this.plannedRows.every((r) => r.fastPathEligible) && this.rowDelegated.size === 0;

    let added = false;
    for (const acc of accounts) {
      let set = this.accountRowHits.get(acc.accountNo);
      if (!set) {
        set = new Set();
        this.accountRowHits.set(acc.accountNo, set);
      }
      set.add(rowIndex);

      if (allFastPath && set.size === this.plannedRows.length && fitsBasics(acc, c)) {
        const existing = this.view.results.find((r) => r.account.accountNo === acc.accountNo);
        if (!existing || existing.fromHistory) {
          this.upsertResult({
            account: toAccountView(acc, this.now()),
            score: existing?.evidence === 'inventory' ? existing.score : null,
            hitItems: existing?.hitItems ?? [],
            fillItems: existing?.fillItems,
            hitCount: existing?.evidence === 'inventory' ? existing.hitCount : null,
            favorite: existing?.favorite ?? false,
            origin: 'platform',
            evidence: existing?.evidence === 'inventory' ? 'inventory' : 'search',
            verifiedAt: this.now(),
            fromHistory: false,
            reverifyFailed: false,
            stale: false,
          });
          added = true;
        }
      }
    }

    if (added) {
      if (!this.firstResultFlushed) {
        this.firstResultFlushed = true;
        this.flush();
      } else {
        this.emitThrottled();
      }
    }
  }

  /** A5（R05）：在请求后续分页前，先核验首条就绪候选，保证后续分页或详情接口挂住时首条匹配卡片已可见。 */
  private async verifyFirstReadyFromPage(accounts: AccountRecord[], token: number) {
    const c = this.view.conditions as FilterConditions;
    const rows = c.items.filter((x) => !conditionIsEmpty(x));
    for (const acc of accounts) {
      if (!this.alive(token) || this.view.results.length > 0) return;
      if (!fitsBasics(acc, c)) continue;
      if (rows.length === 0) {
        this.upsertResult({
          account: toAccountView(acc, this.now()),
          score: 0,
          hitItems: [],
          hitCount: 0,
          favorite: false,
          origin: 'platform',
          evidence: 'inventory',
          verifiedAt: this.now(),
          fromHistory: false,
          reverifyFailed: false,
          stale: false,
        });
        this.firstResultFlushed = true;
        this.flush();
        return;
      }

      const row = this.plannedRows[0];
      if (row?.fastPathEligible && !this.rowDelegated.has(0)) {
        this.upsertResult({
          account: toAccountView(acc, this.now()),
          score: null,
          hitItems: [],
          hitCount: null,
          favorite: false,
          origin: 'platform',
          evidence: 'search',
          verifiedAt: this.now(),
          fromHistory: false,
          reverifyFailed: false,
          stale: false,
        });
        this.firstResultFlushed = true;
        this.flush();
        return;
      }

      try {
        const inv = await this.accounts.inventory(acc.accountNo, {
          priority: Priority.SCAN,
          group: this.group(),
        });
        if (!this.alive(token)) return;
        const match = this.accounts.matchInventoryWithCache(
          acc.accountNo,
          inv.items,
          inv.fetchedAt,
          rows,
        );
        if (!match.matched) {
          this.earlyVerified.add(acc.accountNo);
          continue;
        }
        const hit = new Set(match.hitKeys);
        const hitItems = inv.items
          .filter((i: InventoryItem) => hit.has(i.key))
          .sort(
            (a: InventoryItem, b: InventoryItem) => Number(b.price ?? 0) - Number(a.price ?? 0),
          );
        this.upsertResult({
          account: toAccountView(acc, this.now()),
          score: match.score,
          hitItems: hitItems.slice(0, 4).map(toItemView),
          fillItems: selectFillItems(inv.items, hit),
          hitCount: match.score,
          favorite: false,
          origin: 'platform',
          evidence: 'inventory',
          verifiedAt: match.verifiedAt,
          fromHistory: false,
          reverifyFailed: false,
          stale: false,
        });
        this.firstResultFlushed = true;
        this.flush();
        return;
      } catch (error) {
        if (isCancelled(error) || !this.alive(token)) throw error;
        if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
        return;
      }
    }
  }

  /** 检查已知库存或候选展示位是否已包含满足该条件行的饰品（用于识别可疑零结果，A2 R03）。 */
  private hasContradictingKnownMatch(row: ItemCondition): boolean {
    for (const acc of this.discoveredRecords.values()) {
      const cached = this.accounts.peekMemoryInventory(acc.accountNo);
      if (cached) {
        const m = matchInventory(
          cached.items.map((i: InventoryItem) => ({
            key: i.key,
            marketName: i.marketName,
            firstType: i.firstType,
          })),
          [row],
        );
        if (m.matched) return true;
      }
      if (acc.displayItems.length > 0) {
        const m = matchInventory(
          acc.displayItems.map((i: InventoryItem) => ({
            key: i.key,
            marketName: i.marketName,
            firstType: i.firstType,
          })),
          [row],
        );
        if (m.matched) return true;
      }
    }
    return false;
  }

  /** 当前租期全部账号数（空关键词第 1 页的 total），用于估算一行搜索能排除多少候选；失败时返回 null。 */
  private async fetchUniverseTotal(token: number): Promise<number | null> {
    try {
      const res = await this.fetchSearchPage('', 1, token);
      if (!this.alive(token)) return null;
      return res.total > 0 ? res.total : null;
    } catch (error) {
      if (isCancelled(error)) throw error;
      if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
      return null;
    }
  }

  /**
   * 候选阶段提前确认（A5 R05）：已在所有来源行的已取分页中出现的账号一定会进入最终候选，
   * 立即逐个确认，不必等全部翻页结束。已全部走搜索证据快速路径时卡片已即时输出，无需提前确认。
   */
  private async verifyGuaranteedCandidates(token: number, sourceRowIndices: number[]) {
    // 单个来源行时由 verifyFirstReadyFromPage 负责首条结果，不在此提前确认
    if (sourceRowIndices.length < 2) return;
    const allFastPath =
      this.plannedRows.every((r) => r.fastPathEligible) && this.rowDelegated.size === 0;
    if (allFastPath) return;
    const c = this.view.conditions as FilterConditions;
    const ready: AccountRecord[] = [];
    for (const [no, hits] of this.accountRowHits) {
      if (this.earlyVerified.has(no)) continue;
      if (!sourceRowIndices.every((i) => hits.has(i))) continue;
      const record = this.discoveredRecords.get(no);
      if (record && fitsBasics(record, c)) ready.push(record);
    }
    if (ready.length === 0) return;
    const favorites = await this.localFavorites();
    for (const record of ready) {
      if (!this.alive(token)) return;
      try {
        await this.processCandidate(
          { accountNo: record.accountNo, record, origin: 'platform', searchMatchedAllRows: false },
          token,
          favorites,
        );
      } catch (error) {
        if (isCancelled(error) || !this.alive(token)) throw error;
        if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
        continue; // 失败的留给逐个确认阶段按常规重试与计数
      }
      if (!this.alive(token)) return;
      this.earlyVerified.add(record.accountNo);
      if (!this.firstResultFlushed && this.view.results.length > 0) {
        this.firstResultFlushed = true;
        this.flush();
      } else {
        this.emitThrottled();
      }
    }
  }

  private async collectCandidates(token: number) {
    const c = this.view.conditions as FilterConditions;
    const rows: ItemCondition[] = c.items.filter((x) => !conditionIsEmpty(x));
    const warnings: string[] = [];

    // B3（R10）：小条件变化——若上一轮存在完整未过期快照且仅收紧价格或勾选仅可用券，直接复用该完整快照计算子集
    const reusableSnapshot = this.findReusableCompleteSnapshot(this.activeUserScope, c);
    if (reusableSnapshot && !this.forceRefresh) {
      const favorites = await this.localFavorites();
      if (!this.alive(token)) return;
      const platform: Candidate[] = [];
      for (const { record } of reusableSnapshot.records.values()) {
        if (!fitsBasics(record, c)) {
          this.removeResult(record.accountNo);
          continue;
        }
        platform.push({
          accountNo: record.accountNo,
          record,
          origin: 'platform',
          searchMatchedAllRows: this.plannedRows.every((r) => r.fastPathEligible),
        });
      }
      this.candidates = platform;
      this.candidatesReady = true;
      this.cursor = 0;
      this.view = {
        ...this.view,
        phase: 'VERIFYING',
        candidates: platform.length,
        pendingCount: platform.length,
        discoveryComplete: true,
        fromCache: true,
        snapshotAt: reusableSnapshot.snapshotAt,
        results: this.view.results.filter(
          (r) =>
            platform.some((p) => p.accountNo === r.account.accountNo) ||
            favorites.has(r.account.accountNo),
        ),
      };
      this.flush();
      return;
    }

    // A4（R06）：只有覆盖已认证的行才能作为候选来源与求交依据；覆盖不完整（如格洛克18型、加利尔AR）
    // 或无法用关键词检索的行一律委托给完整库存确认，绝不用其搜索集合排除账号
    for (const r of this.plannedRows) {
      if (!r.coverageVerified) this.rowDelegated.add(r.index);
    }
    const activeRowPlans = this.plannedRows.filter(
      (r) =>
        r.coverageVerified &&
        r.keywords &&
        r.keywords.length > 0 &&
        !this.rowDelegated.has(r.index),
    );
    const sourceRowIndices = activeRowPlans.map((r) => r.index);

    let candidateMap = new Map<string, AccountRecord>();
    let platformZeroRow = false;
    let anySourceSucceeded = false;

    if (activeRowPlans.length === 0) {
      if (rows.length > 0) {
        const partialOnly = this.plannedRows.some((r) => r.keywords.length > 0);
        warnings.push(
          partialOnly
            ? '所选条件的平台搜索覆盖不完整，将浏览该租期的全部账号并逐个确认库存，耗时较长。'
            : '所选条件只有大类，无法用关键词检索，将浏览该租期的全部账号并逐个确认库存，耗时较长。',
        );
      }
      const st = await this.fetchKeywordRemainingPages('', token, rows.length === 1 ? 0 : null);
      if (!this.alive(token)) return;
      if (st.nextPage > 1) anySourceSucceeded = true;
      candidateMap = st.records;
    } else {
      // 1. 取各行关键词的第 1 页，探测候选规模并识别零结果
      const rowWordsMap = new Map<number, string[]>();
      for (const rowPlan of activeRowPlans) {
        const words = [...(rowPlan.keywords ?? [])];
        for (const keyword of words) {
          if (!this.alive(token)) return;
          const st = await this.ensureKeywordPage1(keyword, token, rowPlan.index);
          if (st.nextPage > 1) anySourceSucceeded = true;
        }

        const allZero = words.every((w) => {
          const st = this.keywordStates.get(w);
          return st && st.failedPages.length === 0 && st.total === 0;
        });
        const allFailed = words.every((w) => {
          const st = this.keywordStates.get(w);
          return !st || st.failedPages.length > 0;
        });

        if (allFailed) {
          this.rowDelegated.add(rowPlan.index);
          continue;
        }

        if (allZero) {
          // A2（R03）：先尝试已知回退别名
          let recoveredByAlias = false;
          const aliases = [...new Set(Object.values(rowPlan.fallbackAliases).flat())];
          for (const alias of aliases) {
            if (!this.alive(token)) return;
            const aliasSt = await this.ensureKeywordPage1(alias, token, rowPlan.index);
            if (aliasSt.nextPage > 1) anySourceSucceeded = true;
            if ((aliasSt.total ?? 0) > 0) {
              words.push(alias);
              recoveredByAlias = true;
            }
          }

          if (!recoveredByAlias) {
            const suspicious =
              rowPlan.suspiciousOnZero ||
              !rowPlan.coverageVerified ||
              this.hasContradictingKnownMatch(rowPlan.condition);
            if (suspicious) {
              // 可疑零结果：不能据此判空，委托给其他可靠行或空关键词浏览 + 完整库存确认
              this.rowDelegated.add(rowPlan.index);
              continue;
            } else {
              // 已认证且无本地矛盾的零结果：平台货架确实为 0
              platformZeroRow = true;
              break;
            }
          }
        }

        rowWordsMap.set(rowPlan.index, words);
      }

      if (!this.alive(token)) return;

      if (!platformZeroRow) {
        const usableRowIndices = [...rowWordsMap.keys()].filter(
          (idx) => !this.rowDelegated.has(idx),
        );

        if (usableRowIndices.length === 0) {
          // 所有条件行均为可疑零结果或失败：回退到当前租期空关键词浏览 + 完整库存确认（A2 R03）
          for (const r of this.plannedRows) this.rowDelegated.add(r.index);
          const fallbackSt = await this.fetchKeywordRemainingPages('', token, null);
          if (!this.alive(token)) return;
          if (fallbackSt.nextPage > 1) anySourceSucceeded = true;
          candidateMap = fallbackSt.records;
        } else {
          // 2. A4（R06）：按候选规模从小到大规划分页与求交
          const plans = usableRowIndices
            .map((rowIndex) => {
              const words = rowWordsMap.get(rowIndex) ?? [];
              const totals = words.map((w) => this.keywordStates.get(w)?.total ?? 0);
              const pages = words.reduce((sum, w) => {
                const st = this.keywordStates.get(w);
                if (!st || st.records.size === 0 || (st.total ?? 0) <= st.records.size) return sum;
                return sum + Math.max(0, Math.ceil((st.total ?? 0) / 100) - 1);
              }, 0);
              return {
                rowIndex,
                words,
                size: totals.reduce((a, b) => a + b, 0),
                pages,
              };
            })
            .sort((a, b) => a.size - b.size);

          // 候选阶段提前确认：各来源行第 1 页都出现的账号必然留在最终交集里，先核验它们以尽早出结果
          await this.verifyGuaranteedCandidates(token, sourceRowIndices);
          if (!this.alive(token)) return;

          let intersection: Map<string, AccountRecord> | null = null;
          let universe: number | null | undefined;
          for (const plan of plans) {
            if (!this.alive(token)) return;
            // A4（R06）按请求成本规划：翻完该行还需 plan.pages 次搜索；不翻则交集中预计多留下的账号
            // 各需 1 次库存确认。预计节省的确认数不超过翻页数时不再翻页，交给完整库存确认把关。
            if (intersection != null && plan.pages > 0) {
              const fastStill =
                this.plannedRows.every((r) => r.fastPathEligible) && this.rowDelegated.size === 0;
              let benefit = intersection.size;
              if (!fastStill) {
                if (universe === undefined) universe = await this.fetchUniverseTotal(token);
                if (!this.alive(token)) return;
                if (universe != null && universe > 0) {
                  benefit = intersection.size * Math.max(0, 1 - plan.size / universe);
                }
              }
              if (plan.pages >= benefit) {
                this.rowDelegated.add(plan.rowIndex);
                continue;
              }
            }

            const union = new Map<string, AccountRecord>();
            let rowComplete = true;
            for (const keyword of plan.words) {
              const st = await this.fetchKeywordRemainingPages(keyword, token, plan.rowIndex);
              if (!this.alive(token)) return;
              if (!st.complete) rowComplete = false;
              for (const [no, record] of st.records) union.set(no, record);
            }

            if (intersection == null) {
              intersection = union;
            } else if (rowComplete) {
              const next = new Map<string, AccountRecord>();
              for (const [no, record] of intersection) {
                if (union.has(no)) next.set(no, record);
              }
              intersection = next;
            } else {
              // A4（R06）：未完成、失败或截断的分页集合不能用来硬性排除其他可靠来源中的候选；
              // 保留已有候选并委托完整库存确认核验该行
              this.rowDelegated.add(plan.rowIndex);
            }

            if (intersection.size === 0 && rowComplete) break;
            await this.verifyGuaranteedCandidates(token, sourceRowIndices);
            if (!this.alive(token)) return;
          }
          candidateMap = intersection ?? new Map();
        }
      }
    }

    if (!this.alive(token)) return;

    // A2（R03）：若所有候选来源均失败，明确标记“候选来源不可用”
    if (!anySourceSucceeded && candidateMap.size === 0 && this.failedPageMap.size > 0) {
      this.addPartialReason('候选来源不可用');
      this.view = {
        ...this.view,
        emptyReason: 'SOURCE_UNAVAILABLE',
      };
    }

    const allFastPath =
      rows.length > 0 &&
      this.plannedRows.every((r) => r.fastPathEligible) &&
      this.rowDelegated.size === 0;

    // 命中来源行越多的账号越可能满足全部条件，优先确认以尽早出结果
    const hitsOf = (no: string) => this.accountRowHits.get(no)?.size ?? 0;
    const platform: Candidate[] = [...candidateMap.values()]
      .filter((r) => fitsBasics(r, c))
      .sort((a, b) => hitsOf(b.accountNo) - hitsOf(a.accountNo))
      .map((record) => ({
        accountNo: record.accountNo,
        record,
        origin: 'platform' as const,
        searchMatchedAllRows: allFastPath,
      }));

    const seen = new Set(platform.map((p) => p.accountNo));
    const favorites = await this.localFavorites();
    const known = await this.accounts.knownAccounts();
    if (!this.alive(token)) return;

    const local: Candidate[] = [];
    for (const record of known) {
      if (seen.has(record.accountNo)) continue;
      if (!favorites.has(record.accountNo) && !record.statusKnown) continue;
      if (!fitsBasics(record, c)) continue;
      seen.add(record.accountNo);
      local.push({
        accountNo: record.accountNo,
        record,
        origin: 'local',
        searchMatchedAllRows: false,
      });
    }
    for (const favNo of favorites) {
      if (seen.has(favNo)) continue;
      seen.add(favNo);
      const fallbackRecord: AccountRecord = this.accounts.lastSeen(favNo) ?? {
        accountNo: favNo,
        tags: [],
        value: null,
        status: 'UNKNOWN',
        statusKnown: false,
        expireTimeMs: null,
        useCoupon: true,
        couponAllowed: true,
        isFirst: false,
        platformFavorited: null,
        pricing: {
          rentType: [1, 2, 3, 4, 5, 6],
          prices: {},
          firstPrices: {},
          actPrices: {},
          rentPeriod: 1,
          weekRange: { EARLY: [], NOON: [], NIGHT: [] },
        },
        displayItems: [],
      };
      local.push({
        accountNo: favNo,
        record: fallbackRecord,
        origin: 'local',
        searchMatchedAllRows: false,
      });
    }

    // B1（R08）：上一轮历史结果中本轮未出现在货架候选里的账号，排入复核队列以确认是否仍满足或标记未能复核
    for (const histNo of this.historyToReverify) {
      if (seen.has(histNo)) continue;
      const lastRecord =
        this.accounts.lastSeen(histNo) ??
        this.userKnownRecords.get(this.activeUserScope)?.get(histNo)?.record;
      if (lastRecord) {
        seen.add(histNo);
        local.push({
          accountNo: histNo,
          record: lastRecord,
          origin: 'local',
          searchMatchedAllRows: false,
        });
      }
    }

    const emptyPlatform =
      activeRowPlans.length > 0 && candidateMap.size === 0 && this.searchComplete;
    this.candidates = emptyPlatform && rows.length > 0 ? local : [...platform, ...local];
    this.candidatesReady = true;
    this.cursor = 0;

    // A3/A5：若快速路径已完备，还未输出的平台候选立即以状态待确认加入结果列表
    if (allFastPath) {
      for (const cand of platform) {
        const existing = this.view.results.find((r) => r.account.accountNo === cand.accountNo);
        if (!existing) {
          this.upsertResult({
            account: toAccountView(cand.record, this.now()),
            score: null,
            hitItems: [],
            hitCount: null,
            favorite: favorites.has(cand.accountNo),
            origin: 'platform',
            evidence: 'search',
            verifiedAt: this.now(),
            fromHistory: false,
            reverifyFailed: false,
            stale: false,
          });
        }
      }
    }

    this.view = {
      ...this.view,
      phase: 'VERIFYING',
      candidates: this.candidates.length,
      pendingCount: Math.max(0, this.candidates.length - this.view.confirmed),
      discoveryComplete: true,
      incomplete: this.view.incomplete || !this.searchComplete,
      warnings,
    };
    this.flush();
  }

  /** 核验单个候选（完整库存或搜索证据快速路径 + 状态详情），供逐个确认与候选阶段提前确认共用。 */
  private async processCandidate(cand: Candidate, token: number, favorites: Set<string>) {
    const c = this.view.conditions as FilterConditions;
    const rows = c.items.filter((x) => !conditionIsEmpty(x));
    const itemMode = rows.length > 0;
    if (this.earlyVerified.has(cand.accountNo)) {
      return;
    }

    const isHistoryOnly =
      this.historyToReverify.has(cand.accountNo) &&
      cand.origin === 'local' &&
      !favorites.has(cand.accountNo);

    // R08：对本轮未再出现的非收藏历史账号，若本轮平台搜索覆盖已完整且来源可靠，直接移除
    if (isHistoryOnly && this.searchComplete && this.rowDelegated.size === 0) {
      this.removeResult(cand.accountNo);
      return;
    }

    let record = cand.record;
    let fetchedAt = this.now();

    if (cand.origin === 'local' || (!itemMode && !record.statusKnown)) {
      const d = await this.accounts.detail(cand.accountNo, {
        priority: Priority.SCAN,
        group: this.group(),
        refresh: cand.origin === 'local',
      });
      record = d.record;
      fetchedAt = d.at;
    }
    if (!this.alive(token)) return;

    let score: number | null = 0;
    let hitCount: number | null = 0;
    let hitItems: InventoryItem[] = [];
    let fillItems: ItemView[] | undefined;
    let evidence: MatchEvidenceKind = 'inventory';
    let verifiedAt = fetchedAt;

    if (itemMode) {
      const cachedInv = this.forceRefresh
        ? null
        : await this.accounts.peekCachedInventory(cand.accountNo);
      if (!this.alive(token)) return;
      if (cand.searchMatchedAllRows && !cachedInv) {
        // A3（R04）：搜索证据快速路径，跳过完整库存请求，仅核验账号详情/状态
        score = null;
        hitCount = null;
        hitItems = [];
        evidence = 'search';
        if (!record.statusKnown || this.forceRefresh) {
          const d = await this.accounts.detail(cand.accountNo, {
            priority: Priority.SCAN,
            group: this.group(),
            refresh: this.forceRefresh,
          });
          if (!this.alive(token)) return;
          record = d.record;
          fetchedAt = d.at;
          verifiedAt = d.at;
        }
      } else {
        const inv =
          cachedInv ??
          (await this.accounts.inventory(cand.accountNo, {
            priority: Priority.SCAN,
            group: this.group(),
            refresh: this.forceRefresh,
          }));
        if (!this.alive(token)) return;
        const match = this.accounts.matchInventoryWithCache(
          cand.accountNo,
          inv.items,
          inv.fetchedAt,
          rows,
        );
        if (!match.matched) {
          // R08：证实不符时立即从匹配集中撤出
          this.removeResult(cand.accountNo);
          return;
        }
        score = match.score;
        hitCount = match.score;
        evidence = 'inventory';
        verifiedAt = match.verifiedAt;
        const hit = new Set(match.hitKeys);
        fillItems = selectFillItems(inv.items, hit);
        hitItems = inv.items
          .filter((i: InventoryItem) => hit.has(i.key))
          .sort(
            (a: InventoryItem, b: InventoryItem) => Number(b.price ?? 0) - Number(a.price ?? 0),
          );
        if (!record.statusKnown || this.forceRefresh) {
          const d = await this.accounts.detail(cand.accountNo, {
            priority: Priority.SCAN,
            group: this.group(),
            refresh: this.forceRefresh,
          });
          if (!this.alive(token)) return;
          record = d.record;
          fetchedAt = d.at;
        }
      }
    }

    this.accounts.noteSeen(record);
    this.rememberUserRecord(this.activeUserScope, record, fetchedAt);

    if (!fitsBasics(record, c)) {
      this.removeResult(cand.accountNo);
      return;
    }

    const result: ScanResultView = {
      account: toAccountView(record, fetchedAt),
      score,
      hitItems: hitItems.slice(0, 4).map(toItemView),
      fillItems,
      hitCount,
      favorite: favorites.has(cand.accountNo),
      origin: cand.origin,
      evidence,
      verifiedAt,
      fromHistory: false,
      reverifyFailed: false,
      stale: false,
    };
    this.upsertResult(result);
  }

  private async verify(token: number) {
    const favorites = await this.localFavorites();
    if (!this.alive(token)) return;

    const work: Candidate[] = [];
    if (this.retryQueue.length > 0) {
      const retry = new Set(this.retryQueue);
      for (const cand of this.candidates) if (retry.has(cand.accountNo)) work.push(cand);
      this.retryQueue = [];
    }

    const processOne = (cand: Candidate) => this.processCandidate(cand, token, favorites);

    const handle = async (cand: Candidate) => {
      try {
        await processOne(cand);
      } catch (error) {
        if (isCancelled(error) || !this.alive(token)) throw error;
        if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
        // R08：若该账号原本在历史结果中，请求失败时保留并标注“未能复核”（reverifyFailed=true）
        const existing = this.view.results.find((r) => r.account.accountNo === cand.accountNo);
        if (existing) {
          this.upsertResult({
            ...existing,
            reverifyFailed: true,
          });
        }
        this.view = {
          ...this.view,
          failedAccounts: [...new Set([...this.view.failedAccounts, cand.accountNo])],
          incomplete: true,
          coverageComplete: false,
        };
      }
      if (!this.alive(token)) return;
      const confirmed = this.view.confirmed + 1;
      this.view = {
        ...this.view,
        confirmed,
        checkedCount: confirmed,
        pendingCount: Math.max(0, this.candidates.length - confirmed),
      };
      if (!this.firstResultFlushed && this.view.results.length > 0) {
        this.firstResultFlushed = true;
        this.flush();
      } else {
        this.emitThrottled();
      }
    };

    for (const cand of work) {
      if (!this.alive(token)) return;
      await handle(cand);
    }
    while (this.cursor < this.candidates.length) {
      if (!this.alive(token)) return;
      const cand = this.candidates[this.cursor];
      if (!cand) break;
      await handle(cand);
      if (!this.alive(token)) return;
      this.cursor += 1;
    }
  }

  private upsertResult(result: ScanResultView) {
    const idx = this.view.results.findIndex(
      (r) => r.account.accountNo === result.account.accountNo,
    );
    if (idx < 0) {
      this.view = { ...this.view, results: [...this.view.results, result] };
    } else {
      const next = [...this.view.results];
      next[idx] = result;
      this.view = { ...this.view, results: next };
    }
  }

  private removeResult(accountNo: string) {
    if (!this.view.results.some((r) => r.account.accountNo === accountNo)) return;
    this.view = {
      ...this.view,
      results: this.view.results.filter((r) => r.account.accountNo !== accountNo),
    };
  }

  private rememberUserRecord(userScope: string, record: AccountRecord, fetchedAt: number) {
    let map = this.userKnownRecords.get(userScope);
    if (!map) {
      map = new Map();
      this.userKnownRecords.set(userScope, map);
    }
    map.set(record.accountNo, { record, fetchedAt });
  }

  private saveCurrentSnapshot(coverageComplete: boolean) {
    const conditions = this.view.conditions;
    if (!conditions) return;
    const rows = conditions.items.filter((x) => !conditionIsEmpty(x));
    const fp = conditionFingerprint(rows);
    const results = new Map<string, ScanResultView>();
    const records = new Map<string, { record: AccountRecord; fetchedAt: number }>();
    const userKnown = this.userKnownRecords.get(this.activeUserScope);
    const now = this.now();

    for (const [accNo, rec] of this.discoveredRecords) {
      const known = userKnown?.get(accNo);
      records.set(accNo, {
        record: known?.record ?? rec,
        fetchedAt: known?.fetchedAt ?? now,
      });
    }

    for (const r of this.view.results) {
      results.set(r.account.accountNo, structuredClone(r));
      const known =
        userKnown?.get(r.account.accountNo) ??
        (this.accounts.lastSeen(r.account.accountNo)
          ? {
              record: this.accounts.lastSeen(r.account.accountNo) as AccountRecord,
              fetchedAt: r.account.fetchedAt,
            }
          : null);
      if (known) {
        records.set(r.account.accountNo, known);
      }
    }

    const snap: UserQuerySnapshot = {
      userScope: this.activeUserScope,
      conditions: structuredClone(conditions),
      itemFingerprint: fp,
      catalogVersion: this.activeRuleVersion,
      results,
      records,
      coverageComplete,
      snapshotAt: this.view.snapshotAt ?? now,
    };

    const list = this.userSnapshots.get(this.activeUserScope) ?? [];
    const filtered = list.filter(
      (s) =>
        !(
          s.itemFingerprint === fp &&
          s.conditions.rentKind === conditions.rentKind &&
          s.coverageComplete === coverageComplete
        ),
    );
    filtered.unshift(snap);
    this.userSnapshots.set(this.activeUserScope, filtered.slice(0, 10));
  }

  private findReusableCompleteSnapshot(
    userScope: string,
    conditions: FilterConditions,
  ): UserQuerySnapshot | null {
    const rows = conditions.items.filter((x) => !conditionIsEmpty(x));
    const fp = conditionFingerprint(rows);
    const now = this.now();
    const list = this.userSnapshots.get(userScope) ?? [];
    for (const snap of list) {
      if (!snap.coverageComplete) continue;
      if (snap.catalogVersion !== this.activeRuleVersion) continue;
      if (now - snap.snapshotAt >= SEARCH_CACHE_TTL_MS) continue;
      if (snap.itemFingerprint !== fp) continue;
      if (isTightenedConditionSubset(snap.conditions, conditions)) {
        return snap;
      }
    }
    return null;
  }

  private loadInitialHistoryResults(
    userScope: string,
    conditions: FilterConditions,
    options: { markStale?: boolean } = {},
  ): { results: ScanResultView[]; snapshotAt: number | null } {
    const rows = conditions.items.filter((x) => !conditionIsEmpty(x));
    const fp = conditionFingerprint(rows);
    const list = this.userSnapshots.get(userScope) ?? [];
    const now = this.now();

    // 优先匹配相同饰品指纹的最新快照
    const sameFpSnap = list.find(
      (s) => s.itemFingerprint === fp && s.catalogVersion === this.activeRuleVersion,
    );
    if (sameFpSnap) {
      const out: ScanResultView[] = [];
      for (const [accountNo, res] of sameFpSnap.results) {
        const recSnap = sameFpSnap.records.get(accountNo);
        if (recSnap && !fitsBasics(recSnap.record, conditions)) continue;
        // 若原证据是库存缓存，检查内存库存缓存是否依然匹配
        const cachedInv = this.accounts.peekMemoryInventory(accountNo);
        if (rows.length > 0 && res.evidence === 'inventory' && cachedInv) {
          const match = this.accounts.matchInventoryWithCache(
            accountNo,
            cachedInv.items,
            cachedInv.fetchedAt,
            rows,
          );
          if (!match.matched) continue;
        }
        const cloned = structuredClone(res);
        cloned.fromHistory = true;
        cloned.reverifyFailed = false;
        const isStale =
          Boolean(options.markStale) ||
          !this.isOnline() ||
          now - cloned.account.fetchedAt > DETAIL_FRESH_TTL_MS ||
          sameFpSnap.conditions.rentKind !== conditions.rentKind;
        if (isStale) {
          cloned.stale = true;
          cloned.account.status = 'UNKNOWN';
        }
        out.push(cloned);
      }
      return { results: out, snapshotAt: sameFpSnap.snapshotAt };
    }

    // B3（R10）：饰品条件变化时，复用当前用户已知账号中仍然有效的原始库存缓存重新匹配
    const userKnown = this.userKnownRecords.get(userScope);
    if (!userKnown || userKnown.size === 0) {
      return { results: [], snapshotAt: null };
    }
    const out: ScanResultView[] = [];
    let earliestAt: number | null = null;
    for (const [accountNo, { record, fetchedAt }] of userKnown) {
      if (!fitsBasics(record, conditions)) continue;
      if (rows.length > 0) {
        const inv = this.accounts.peekMemoryInventory(accountNo);
        if (!inv) continue;
        const match = this.accounts.matchInventoryWithCache(
          accountNo,
          inv.items,
          inv.fetchedAt,
          rows,
        );
        if (!match.matched) continue;
        const hit = new Set(match.hitKeys);
        const hitItems = inv.items
          .filter((i: InventoryItem) => hit.has(i.key))
          .sort((a: InventoryItem, b: InventoryItem) => Number(b.price ?? 0) - Number(a.price ?? 0))
          .slice(0, 4)
          .map(toItemView);
        const accountView = toAccountView(record, fetchedAt);
        const isStale =
          Boolean(options.markStale) || !this.isOnline() || now - fetchedAt > DETAIL_FRESH_TTL_MS;
        if (isStale) accountView.status = 'UNKNOWN';
        earliestAt = earliestAt == null ? fetchedAt : Math.min(earliestAt, fetchedAt);
        out.push({
          account: accountView,
          score: match.score,
          hitItems,
          fillItems: selectFillItems(inv.items, hit),
          hitCount: match.score,
          favorite: false,
          origin: 'local',
          evidence: 'inventory',
          verifiedAt: match.verifiedAt,
          fromHistory: true,
          reverifyFailed: false,
          stale: isStale,
        });
      }
    }
    return { results: out, snapshotAt: earliestAt };
  }

  private emitThrottled() {
    const now = this.now();
    if (now - this.lastEmit >= 200) {
      this.flush();
      return;
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.flush();
      }, 200);
    }
  }

  private flush() {
    this.lastEmit = this.now();
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.onChange(this.view);
  }

  reset() {
    this.halt();
    this.view = emptyView(this.scanId);
    this.candidates = [];
    this.candidatesReady = false;
    this.keywordStates.clear();
    this.rowDelegated.clear();
    this.accountRowHits.clear();
    this.discoveredRecords.clear();
    this.earlyVerified.clear();
    this.historyToReverify.clear();
    this.partialReasonSet.clear();
    this.failedPageMap.clear();
    this.flush();
  }
}

function emptyView(scanId: number): ScanView {
  return {
    scanId,
    phase: 'IDLE',
    conditions: null,
    hasItemConditions: false,
    candidates: 0,
    confirmed: 0,
    results: [],
    failedAccounts: [],
    incomplete: false,
    error: null,
    warnings: [],
    startedAt: null,
    finishedAt: null,
    discoveryComplete: false,
    checkedCount: 0,
    pendingCount: 0,
    coverageComplete: false,
    partialReasons: [],
    failedPages: [],
    snapshotAt: null,
    fromCache: false,
    localOnly: false,
    emptyReason: null,
  };
}

export const RENT_UNIT = (kind: FilterConditions['rentKind']) => RENT_META[kind].unit;
