// 账号详情与库存：详情状态缓存 30 秒（仅浏览用）；库存缓存按设置（本次运行不落盘）；出码时必须强制刷新。
// 支持按账号+接口合并在途请求（B4/R11）与库存匹配结果缓存。
import { CATALOG_VERSION } from '../../shared/catalog';
import type { ItemCondition } from '../../shared/conditions';
import { CACHE_TTL_MS, type CacheTtl } from '../../shared/settings';
import { conditionFingerprint, matchInventory } from '../domain/matching';
import type { PlatformApi } from '../platform/api';
import { CancelledError } from '../platform/errors';
import type { Priority, RequestQueue } from '../platform/queue';
import {
  ACCOUNT_SNAPSHOT_VERSION,
  type AccountRecord,
  INVENTORY_CACHE_VERSION,
  type InventoryItem,
} from '../platform/schemas';
import type { DbClient } from '../storage/client';

const DETAIL_TTL = 30_000;
const INVENTORY_MAX_BYTES = 100 * 1024 * 1024;

export interface FetchOptions {
  priority: Priority;
  group?: string;
  /** 忽略缓存 */
  refresh?: boolean;
}

export interface CachedInventoryMatch {
  matched: boolean;
  score: number;
  hitKeys: string[];
  verifiedAt: number;
}

interface Waiter<T> {
  group?: string;
  priority: Priority;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface InflightEntry<T> {
  sharedGroup: string;
  minPriority: Priority;
  waiters: Waiter<T>[];
}

function computeItemsVersion(items: readonly InventoryItem[], fetchedAt: number): string {
  if (items.length === 0) return `${fetchedAt}:0`;
  const first = items[0]?.key ?? '';
  const last = items[items.length - 1]?.key ?? '';
  return `${fetchedAt}:${items.length}:${first}:${last}`;
}

export class AccountService {
  private details = new Map<
    string,
    { record: AccountRecord; at: number; serverTimeMs: number | null }
  >();
  private sessionInventory = new Map<string, { items: InventoryItem[]; at: number }>();
  private matchCache = new Map<string, CachedInventoryMatch>();
  private inflightDetails = new Map<
    string,
    InflightEntry<{
      record: AccountRecord;
      at: number;
      serverTimeMs: number | null;
    }>
  >();
  private inflightInventories = new Map<
    string,
    InflightEntry<{ items: InventoryItem[]; fetchedAt: number; fromCache: boolean }>
  >();
  private inflightSeq = 0;
  private lastSeenCacheClearAt = 0;
  private inventoryListeners = new Set<
    (accountNo: string, items: InventoryItem[], fetchedAt: number) => void
  >();

  constructor(
    private readonly api: PlatformApi,
    private readonly db: DbClient,
    private readonly cacheTtl: () => CacheTtl,
    private readonly now: () => number = Date.now,
    private readonly queue?: RequestQueue,
  ) {
    if (this.queue) {
      this.queue.onCancelGroup((prefix) => this.handleCancelGroup(prefix));
    }
  }

  onInventoryLoaded(
    listener: (accountNo: string, items: InventoryItem[], fetchedAt: number) => void,
  ): () => void {
    this.inventoryListeners.add(listener);
    return () => {
      this.inventoryListeners.delete(listener);
    };
  }

  private emitInventoryLoaded(accountNo: string, items: InventoryItem[], fetchedAt: number) {
    for (const listener of this.inventoryListeners) {
      try {
        listener(accountNo, items, fetchedAt);
      } catch {
        // 忽略监听器内部异常
      }
    }
  }

  private handleCancelGroup(prefix: string) {
    const pruneMap = <T>(map: Map<string, InflightEntry<T>>) => {
      for (const [accNo, entry] of map) {
        const keep: Waiter<T>[] = [];
        for (const w of entry.waiters) {
          if (w.group?.startsWith(prefix)) {
            w.reject(new CancelledError());
          } else {
            keep.push(w);
          }
        }
        entry.waiters = keep;
        if (keep.length === 0) {
          map.delete(accNo);
          this.queue?.cancelGroup(entry.sharedGroup);
        }
      }
    };
    pruneMap(this.inflightDetails);
    pruneMap(this.inflightInventories);
  }

  async syncCacheEpoch(): Promise<boolean> {
    try {
      const clearedAt = await this.db.call('cache.clearedAt', undefined);
      if (clearedAt > this.lastSeenCacheClearAt) {
        this.lastSeenCacheClearAt = clearedAt;
        this.details.clear();
        this.sessionInventory.clear();
        this.matchCache.clear();
        return true;
      }
    } catch {
      // 忽略
    }
    return false;
  }

  async detail(
    accountNo: string,
    opts: FetchOptions,
  ): Promise<{ record: AccountRecord; at: number; serverTimeMs: number | null }> {
    const cached = this.details.get(accountNo);
    if (!opts.refresh && cached && this.now() - cached.at < DETAIL_TTL) return cached;

    const existing = this.inflightDetails.get(accountNo);
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.waiters.push({
          group: opts.group,
          priority: opts.priority,
          resolve,
          reject,
        });
        if (opts.priority < existing.minPriority) {
          existing.minPriority = opts.priority;
          this.queue?.upgradeGroupPriority(existing.sharedGroup, opts.priority);
        }
      });
    }

    const sharedGroup = this.queue
      ? `coalesce:detail:${accountNo}:${++this.inflightSeq}`
      : (opts.group ?? `coalesce:detail:${accountNo}:${++this.inflightSeq}`);
    const entry: InflightEntry<{
      record: AccountRecord;
      at: number;
      serverTimeMs: number | null;
    }> = {
      sharedGroup,
      minPriority: opts.priority,
      waiters: [],
    };
    this.inflightDetails.set(accountNo, entry);

    const waiterPromise = new Promise<{
      record: AccountRecord;
      at: number;
      serverTimeMs: number | null;
    }>((resolve, reject) => {
      entry.waiters.push({
        group: opts.group,
        priority: opts.priority,
        resolve,
        reject,
      });
    });

    void (async () => {
      try {
        const { serverTimeMs, ...record } = await this.api.accountInfo(accountNo, {
          priority: entry.minPriority,
          group: sharedGroup,
        });
        const res = { record, at: this.now(), serverTimeMs };
        this.details.set(accountNo, res);
        await this.remember([record], 'detail');
        this.inflightDetails.delete(accountNo);
        for (const w of entry.waiters) w.resolve(res);
      } catch (err) {
        this.inflightDetails.delete(accountNo);
        for (const w of entry.waiters) w.reject(err);
      }
    })();

    return waiterPromise;
  }

  private seen = new Map<string, AccountRecord>();

  /** 记录界面上见过的账号（含搜索列表的展示位），用于收藏摘要的缩略图。 */
  noteSeen(record: AccountRecord) {
    this.seen.set(record.accountNo, record);
    if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value as string);
  }

  /** 最近一次见到的账号记录：优先详情（状态可信），展示位缺失时用搜索列表补齐。 */
  lastSeen(accountNo: string): AccountRecord | null {
    const detail = this.details.get(accountNo)?.record ?? null;
    const seen = this.seen.get(accountNo) ?? null;
    if (detail && detail.displayItems.length === 0 && seen)
      return { ...detail, displayItems: seen.displayItems };
    return detail ?? seen;
  }

  peekDetail(accountNo: string) {
    return this.details.get(accountNo) ?? null;
  }

  /** 记录状态已知的账号快照（来自详情或收藏列表），供“本地已知账号”使用。 */
  noteRecord(record: AccountRecord) {
    if (!record.statusKnown) return;
    this.details.set(record.accountNo, { record, at: this.now(), serverTimeMs: null });
  }

  async remember(records: AccountRecord[], source: 'detail' | 'favorite' | 'search') {
    if (records.length === 0) return;
    await this.db.call('snapshots.put', {
      items: records.map((r) => ({ accountNo: r.accountNo, dataJson: JSON.stringify(r), source })),
      now: this.now(),
      schemaVersion: ACCOUNT_SNAPSHOT_VERSION,
    });
  }

  /** B2 (R09)：保留快照验证时间（fetched_at），不再丢弃。 */
  async knownAccountSnapshots(): Promise<{ record: AccountRecord; fetchedAt: number }[]> {
    const rows = await this.db.call('snapshots.all', { schemaVersion: ACCOUNT_SNAPSHOT_VERSION });
    const out: { record: AccountRecord; fetchedAt: number }[] = [];
    for (const row of rows) {
      try {
        const record = JSON.parse(row.data_json) as AccountRecord;
        out.push({ record, fetchedAt: row.fetched_at });
      } catch {
        // 跳过损坏记录
      }
    }
    return out;
  }

  async knownAccounts(): Promise<(AccountRecord & { snapshotFetchedAt?: number })[]> {
    const snapshots = await this.knownAccountSnapshots();
    return snapshots.map((s) => ({
      ...s.record,
      snapshotFetchedAt: s.fetchedAt,
    }));
  }

  /** 同步读取内存中的未过期库存缓存（不访问数据库、不发网络请求）。 */
  peekMemoryInventory(accountNo: string): { items: InventoryItem[]; fetchedAt: number } | null {
    const hit = this.sessionInventory.get(accountNo);
    if (!hit) return null;
    const ttl = this.cacheTtl();
    if (ttl !== 'SESSION' && this.now() - hit.at >= CACHE_TTL_MS[ttl]) {
      this.sessionInventory.delete(accountNo);
      return null;
    }
    return { items: hit.items, fetchedAt: hit.at };
  }

  /** 只读检查某个账号是否已有有效库存缓存（不发起网络请求）。 */
  async peekCachedInventory(
    accountNo: string,
  ): Promise<{ items: InventoryItem[]; fetchedAt: number } | null> {
    await this.syncCacheEpoch();
    const mem = this.peekMemoryInventory(accountNo);
    if (mem) return mem;
    const ttl = this.cacheTtl();
    if (ttl === 'SESSION') return null;
    const now = this.now();
    const row = await this.db.call('inventory.get', {
      accountNo,
      now,
      schemaVersion: INVENTORY_CACHE_VERSION,
    });
    if (!row) return null;
    try {
      const items = JSON.parse(row.items_json) as InventoryItem[];
      this.sessionInventory.set(accountNo, { items, at: row.fetched_at });
      return {
        items,
        fetchedAt: row.fetched_at,
      };
    } catch {
      return null;
    }
  }

  /** 批量获取当前所有未过期的库存缓存（供本地匹配与成本规划使用，不发网络请求）。 */
  async allValidInventories(): Promise<Map<string, { items: InventoryItem[]; fetchedAt: number }>> {
    await this.syncCacheEpoch();
    const ttl = this.cacheTtl();
    const now = this.now();
    const out = new Map<string, { items: InventoryItem[]; fetchedAt: number }>();
    if (ttl === 'SESSION') {
      for (const [accountNo, entry] of this.sessionInventory) {
        out.set(accountNo, { items: entry.items, fetchedAt: entry.at });
      }
      return out;
    }
    const rows = await this.db.call('inventory.allValid', {
      now,
      schemaVersion: INVENTORY_CACHE_VERSION,
    });
    for (const row of rows) {
      try {
        out.set(row.account_no, {
          items: JSON.parse(row.items_json) as InventoryItem[],
          fetchedAt: row.fetched_at,
        });
      } catch {
        // 跳过损坏记录
      }
    }
    return out;
  }

  /**
   * B4 (R11) 库存匹配层缓存：
   * 键 = 账号 + 库存版本标识 + 规范化条件指纹 + 词典版本。
   */
  matchInventoryWithCache(
    accountNo: string,
    items: readonly InventoryItem[],
    fetchedAt: number,
    conditions: readonly ItemCondition[],
  ): CachedInventoryMatch {
    const fp = conditionFingerprint(conditions);
    const invVer = computeItemsVersion(items, fetchedAt);
    const cacheKey = `${accountNo}|${invVer}|${fp}|${CATALOG_VERSION}`;
    const hit = this.matchCache.get(cacheKey);
    if (hit) return hit;

    const m = matchInventory(items, conditions);
    const entry: CachedInventoryMatch = {
      matched: m.matched,
      score: m.score,
      hitKeys: m.hitKeys,
      verifiedAt: fetchedAt,
    };
    this.matchCache.set(cacheKey, entry);
    if (this.matchCache.size > 10_000) {
      const oldestKey = this.matchCache.keys().next().value;
      if (oldestKey) this.matchCache.delete(oldestKey);
    }
    return entry;
  }

  async inventory(
    accountNo: string,
    opts: FetchOptions,
  ): Promise<{ items: InventoryItem[]; fetchedAt: number; fromCache: boolean }> {
    const existing = this.inflightInventories.get(accountNo);
    if (existing) {
      return new Promise((resolve, reject) => {
        existing.waiters.push({
          group: opts.group,
          priority: opts.priority,
          resolve,
          reject,
        });
        if (opts.priority < existing.minPriority) {
          existing.minPriority = opts.priority;
          this.queue?.upgradeGroupPriority(existing.sharedGroup, opts.priority);
        }
      });
    }

    const sharedGroup = this.queue
      ? `coalesce:inv:${accountNo}:${++this.inflightSeq}`
      : (opts.group ?? `coalesce:inv:${accountNo}:${++this.inflightSeq}`);
    const entry: InflightEntry<{
      items: InventoryItem[];
      fetchedAt: number;
      fromCache: boolean;
    }> = {
      sharedGroup,
      minPriority: opts.priority,
      waiters: [],
    };
    this.inflightInventories.set(accountNo, entry);

    const waiterPromise = new Promise<{
      items: InventoryItem[];
      fetchedAt: number;
      fromCache: boolean;
    }>((resolve, reject) => {
      entry.waiters.push({
        group: opts.group,
        priority: opts.priority,
        resolve,
        reject,
      });
    });

    void (async () => {
      try {
        await this.syncCacheEpoch();
        if (entry.waiters.length === 0) return;
        const ttl = this.cacheTtl();
        const now = this.now();
        if (!opts.refresh) {
          if (ttl === 'SESSION') {
            const hit = this.sessionInventory.get(accountNo);
            if (hit) {
              this.inflightInventories.delete(accountNo);
              this.emitInventoryLoaded(accountNo, hit.items, hit.at);
              const res = { items: hit.items, fetchedAt: hit.at, fromCache: true };
              for (const w of entry.waiters) w.resolve(res);
              return;
            }
          } else {
            const row = await this.db.call('inventory.get', {
              accountNo,
              now,
              schemaVersion: INVENTORY_CACHE_VERSION,
            });
            if (entry.waiters.length === 0) return;
            if (row) {
              try {
                const parsed = JSON.parse(row.items_json) as InventoryItem[];
                this.sessionInventory.set(accountNo, { items: parsed, at: row.fetched_at });
                this.inflightInventories.delete(accountNo);
                this.emitInventoryLoaded(accountNo, parsed, row.fetched_at);
                const res = {
                  items: parsed,
                  fetchedAt: row.fetched_at,
                  fromCache: true,
                };
                for (const w of entry.waiters) w.resolve(res);
                return;
              } catch {
                // 缓存损坏时重新读取
              }
            }
          }
        }

        const items = await this.api.inventory(accountNo, {
          priority: entry.minPriority,
          group: sharedGroup,
        });
        const at = this.now();
        const currentTtl = this.cacheTtl();
        this.sessionInventory.set(accountNo, { items, at });
        if (currentTtl !== 'SESSION') {
          await this.db.call('inventory.put', {
            accountNo,
            itemsJson: JSON.stringify(items),
            now: at,
            expiresAt: at + CACHE_TTL_MS[currentTtl],
            schemaVersion: INVENTORY_CACHE_VERSION,
            maxBytes: INVENTORY_MAX_BYTES,
          });
        }
        const res = { items, fetchedAt: at, fromCache: false };
        this.inflightInventories.delete(accountNo);
        this.emitInventoryLoaded(accountNo, items, at);
        for (const w of entry.waiters) w.resolve(res);
      } catch (err) {
        this.inflightInventories.delete(accountNo);
        for (const w of entry.waiters) w.reject(err);
      }
    })();

    return waiterPromise;
  }

  async clearCaches() {
    this.details.clear();
    this.sessionInventory.clear();
    this.matchCache.clear();
    await this.db.call('cache.clear', undefined);
    this.lastSeenCacheClearAt = this.now();
  }

  forgetDetails() {
    this.details.clear();
  }
}
