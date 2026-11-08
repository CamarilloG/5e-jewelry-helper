// 筛选扫描（业务流程 §3）：IDLE → CANDIDATES → VERIFYING → COMPLETE，可 STOPPED / FAILED。
// 每个非空条件选单个关键词取候选并按候选数从少到多补齐分页取交集；空交集立即结束；
// 加入本地已知账号；含饰品条件时逐个完整库存确认（同件匹配、行间交集、命中去重）。
import Decimal from 'decimal.js';
import type { FilterConditions, ScanResultView, ScanView } from '../../shared/dto';
import { RENT_META, supportsRent } from '../../shared/rent';
import {
  conditionIsEmpty,
  conditionKeyword,
  type ItemCondition,
  matchInventory,
} from '../domain/matching';
import type { Logger } from '../logger';
import type { PlatformApi } from '../platform/api';
import { isCancelled, PlatformError, userMessage } from '../platform/errors';
import { Priority } from '../platform/queue';
import type { AccountRecord, InventoryItem } from '../platform/schemas';
import type { AccountService } from './account-service';
import { toAccountView, toItemView } from './views';

interface Candidate {
  accountNo: string;
  record: AccountRecord;
  origin: 'platform' | 'local';
}

const MAX_PAGES_PER_KEYWORD = 200;

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

export class ScanService {
  private scanId = 0;
  private token = 0;
  private view: ScanView = emptyView(0);
  private candidates: Candidate[] = [];
  private candidatesReady = false;
  private cursor = 0;
  private retryQueue: string[] = [];
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly api: PlatformApi,
    private readonly accounts: AccountService,
    private readonly localFavorites: () => Promise<Set<string>>,
    private readonly onChange: (view: ScanView) => void,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  state(): ScanView {
    return this.view;
  }

  isActive() {
    return this.view.phase === 'CANDIDATES' || this.view.phase === 'VERIFYING';
  }

  private group() {
    return `scan:${this.scanId}`;
  }

  start(conditions: FilterConditions): ScanView {
    this.halt();
    this.scanId += 1;
    const items = conditions.items.filter((c) => !conditionIsEmpty(c));
    this.view = {
      ...emptyView(this.scanId),
      phase: 'CANDIDATES',
      conditions: structuredClone(conditions),
      hasItemConditions: items.length > 0,
      startedAt: this.now(),
    };
    this.candidates = [];
    this.candidatesReady = false;
    this.cursor = 0;
    this.retryQueue = [];
    this.logger.info('scan.start', { count: items.length, kind: conditions.rentKind });
    void this.run(this.token);
    this.flush();
    return this.view;
  }

  stop(): ScanView {
    if (!this.isActive()) return this.view;
    this.halt();
    this.view = { ...this.view, phase: 'STOPPED' };
    this.flush();
    return this.view;
  }

  continue(): ScanView {
    if (this.view.phase !== 'STOPPED' || !this.view.conditions) return this.view;
    this.token += 1;
    this.view = {
      ...this.view,
      phase: this.candidatesReady ? 'VERIFYING' : 'CANDIDATES',
      finishedAt: null,
    };
    void this.run(this.token);
    this.flush();
    return this.view;
  }

  retryFailed(): ScanView {
    if (this.isActive() || this.view.failedAccounts.length === 0 || !this.view.conditions)
      return this.view;
    this.token += 1;
    this.retryQueue = [...this.view.failedAccounts];
    this.view = {
      ...this.view,
      phase: 'VERIFYING',
      failedAccounts: [],
      confirmed: Math.max(0, this.view.confirmed - this.retryQueue.length),
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
    this.view = { ...this.view, phase: 'STOPPED', error: reason };
    this.flush();
  }

  private halt() {
    this.token += 1;
    this.api.queue.cancelGroup(this.group());
  }

  private alive(token: number) {
    return token === this.token;
  }

  private async run(token: number) {
    try {
      if (!this.candidatesReady) {
        await this.collectCandidates(token);
        if (!this.alive(token)) return;
      }
      await this.verify(token);
      if (!this.alive(token)) return;
      this.view = { ...this.view, phase: 'COMPLETE', finishedAt: this.now() };
      this.logger.info('scan.complete', {
        count: this.view.results.length,
        state: this.view.incomplete ? 'INCOMPLETE' : 'FULL',
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
        finishedAt: this.now(),
      };
      this.logger.warn('scan.failed', {
        reason: error instanceof PlatformError ? error.code : 'ERROR',
      });
      this.flush();
    }
  }

  private async fetchKeyword(
    keyword: string,
    token: number,
    first?: { total: number; accounts: AccountRecord[] },
  ): Promise<{ records: Map<string, AccountRecord>; complete: boolean }> {
    const c = this.view.conditions as FilterConditions;
    const records = new Map<string, AccountRecord>();
    let total = first?.total ?? Number.POSITIVE_INFINITY;
    let page = 1;
    let complete = true;
    if (first) {
      for (const r of first.accounts) records.set(r.accountNo, r);
      if (first.accounts.length === 0 || records.size >= total) return { records, complete };
      page = 2;
    }
    for (; page <= MAX_PAGES_PER_KEYWORD; page++) {
      if (!this.alive(token)) return { records, complete: false };
      let result: { total: number; accounts: AccountRecord[] };
      try {
        result = await this.api.search(
          { keyword, page, rentKind: c.rentKind, couponOnly: c.couponOnly },
          { priority: Priority.SCAN, group: this.group() },
        );
      } catch (error) {
        if (isCancelled(error)) throw error;
        if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
        complete = false;
        break;
      }
      total = result.total;
      if (result.accounts.length === 0) break;
      let fresh = 0;
      for (const r of result.accounts) {
        if (!records.has(r.accountNo)) fresh++;
        records.set(r.accountNo, r);
      }
      if (fresh === 0) {
        // 重复页：本轮不完整
        complete = false;
        break;
      }
      if (records.size >= total) break;
    }
    return { records, complete };
  }

  private async collectCandidates(token: number) {
    const c = this.view.conditions as FilterConditions;
    const rows: ItemCondition[] = c.items.filter((x) => !conditionIsEmpty(x));
    const keywords = [...new Set(rows.map(conditionKeyword).filter((k): k is string => !!k))];
    const warnings: string[] = [];
    let candidateMap: Map<string, AccountRecord>;
    let complete = true;
    if (keywords.length === 0) {
      if (rows.length > 0) {
        warnings.push(
          '所选大类无法用单个关键词检索，将浏览该租期的全部账号并逐个确认库存，耗时较长。',
        );
      }
      const result = await this.fetchKeyword('', token);
      candidateMap = result.records;
      complete = result.complete;
    } else {
      // 先取各关键词第一页，再按候选数从少到多补齐
      const firsts: {
        keyword: string;
        first: { total: number; accounts: AccountRecord[] } | null;
      }[] = [];
      for (const keyword of keywords) {
        if (!this.alive(token)) return;
        try {
          const first = await this.api.search(
            { keyword, page: 1, rentKind: c.rentKind, couponOnly: c.couponOnly },
            { priority: Priority.SCAN, group: this.group() },
          );
          firsts.push({ keyword, first });
          if (first.total === 0 || first.accounts.length === 0) break;
        } catch (error) {
          if (isCancelled(error)) throw error;
          if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
          firsts.push({ keyword, first: null });
          complete = false;
        }
      }
      firsts.sort(
        (a, b) =>
          (a.first?.total ?? Number.MAX_SAFE_INTEGER) - (b.first?.total ?? Number.MAX_SAFE_INTEGER),
      );
      let intersection: Map<string, AccountRecord> | null = null;
      for (const entry of firsts) {
        if (!this.alive(token)) return;
        if (!entry.first) continue;
        const result = await this.fetchKeyword(entry.keyword, token, entry.first);
        if (!result.complete) complete = false;
        if (intersection == null) {
          intersection = result.records;
        } else {
          const next = new Map<string, AccountRecord>();
          for (const [no, record] of intersection) if (result.records.has(no)) next.set(no, record);
          intersection = next;
        }
        if (intersection.size === 0) break;
      }
      if (firsts.length < keywords.length && firsts.some((f) => f.first && f.first.total === 0)) {
        intersection = new Map();
      }
      candidateMap = intersection ?? new Map();
    }
    if (!this.alive(token)) return;
    const platform: Candidate[] = [...candidateMap.values()]
      .filter((r) => fitsBasics(r, c))
      .map((record) => ({ accountNo: record.accountNo, record, origin: 'platform' as const }));
    const seen = new Set(platform.map((p) => p.accountNo));
    // 本地已知账号：收藏 + 详情/收藏快照中状态已知、符合租期价格范围的账号
    const favorites = await this.localFavorites();
    const known = await this.accounts.knownAccounts();
    const local: Candidate[] = [];
    const empty = keywords.length > 0 && candidateMap.size === 0 && complete;
    for (const record of known) {
      if (seen.has(record.accountNo)) continue;
      if (!favorites.has(record.accountNo) && !record.statusKnown) continue;
      if (!fitsBasics(record, c)) continue;
      seen.add(record.accountNo);
      local.push({ accountNo: record.accountNo, record, origin: 'local' });
    }
    // 交集为空且候选完整时立即结束，不扫本地以外的库存
    this.candidates = empty && rows.length > 0 ? local : [...platform, ...local];
    this.candidatesReady = true;
    this.cursor = 0;
    this.view = {
      ...this.view,
      phase: 'VERIFYING',
      candidates: this.candidates.length,
      incomplete: this.view.incomplete || !complete,
      warnings,
    };
    this.flush();
  }

  private async verify(token: number) {
    const c = this.view.conditions as FilterConditions;
    const rows = c.items.filter((x) => !conditionIsEmpty(x));
    const itemMode = rows.length > 0;
    const work: Candidate[] = [];
    if (this.retryQueue.length > 0) {
      const retry = new Set(this.retryQueue);
      for (const cand of this.candidates) if (retry.has(cand.accountNo)) work.push(cand);
      this.retryQueue = [];
    }
    const processOne = async (cand: Candidate) => {
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
      let score = 0;
      let hitItems: InventoryItem[] = [];
      if (itemMode) {
        const inv = await this.accounts.inventory(cand.accountNo, {
          priority: Priority.SCAN,
          group: this.group(),
        });
        if (!this.alive(token)) return;
        const match = matchInventory(
          inv.items.map((i) => ({ key: i.key, marketName: i.marketName, firstType: i.firstType })),
          rows,
        );
        if (!match.matched) return;
        score = match.score;
        const hit = new Set(match.hitKeys);
        hitItems = inv.items
          .filter((i) => hit.has(i.key))
          .sort((a, b) => Number(b.price ?? 0) - Number(a.price ?? 0));
        if (!record.statusKnown) {
          const d = await this.accounts.detail(cand.accountNo, {
            priority: Priority.SCAN,
            group: this.group(),
          });
          if (!this.alive(token)) return;
          record = d.record;
          fetchedAt = d.at;
        }
      }
      this.accounts.noteSeen(cand.record);
      if (!fitsBasics(record, c)) return;
      const result: ScanResultView = {
        account: toAccountView(record, fetchedAt),
        score,
        hitItems: hitItems.slice(0, 4).map(toItemView),
        hitCount: score,
        favorite: false,
        origin: cand.origin,
      };
      const results = this.view.results.filter((r) => r.account.accountNo !== cand.accountNo);
      results.push(result);
      this.view = { ...this.view, results };
    };
    const handle = async (cand: Candidate) => {
      try {
        await processOne(cand);
      } catch (error) {
        if (isCancelled(error) || !this.alive(token)) throw error;
        if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
        this.view = {
          ...this.view,
          failedAccounts: [...new Set([...this.view.failedAccounts, cand.accountNo])],
          incomplete: true,
        };
      }
      if (!this.alive(token)) return;
      this.view = { ...this.view, confirmed: this.view.confirmed + 1 };
      this.emitThrottled();
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

  private emitThrottled() {
    const now = this.now();
    if (now - this.lastEmit >= 300) {
      this.flush();
      return;
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.flush();
      }, 300);
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
  };
}

export const RENT_UNIT = (kind: FilterConditions['rentKind']) => RENT_META[kind].unit;
