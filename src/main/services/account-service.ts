// 账号详情与库存：详情状态缓存 30 秒（仅浏览用）；库存缓存按设置（本次运行不落盘）；出码时必须强制刷新。
import { CACHE_TTL_MS, type CacheTtl } from '../../shared/settings';
import type { PlatformApi } from '../platform/api';
import type { Priority } from '../platform/queue';
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

export class AccountService {
  private details = new Map<
    string,
    { record: AccountRecord; at: number; serverTimeMs: number | null }
  >();
  private sessionInventory = new Map<string, { items: InventoryItem[]; at: number }>();

  constructor(
    private readonly api: PlatformApi,
    private readonly db: DbClient,
    private readonly cacheTtl: () => CacheTtl,
    private readonly now: () => number = Date.now,
  ) {}

  async detail(
    accountNo: string,
    opts: FetchOptions,
  ): Promise<{ record: AccountRecord; at: number; serverTimeMs: number | null }> {
    const cached = this.details.get(accountNo);
    if (!opts.refresh && cached && this.now() - cached.at < DETAIL_TTL) return cached;
    const { serverTimeMs, ...record } = await this.api.accountInfo(accountNo, {
      priority: opts.priority,
      group: opts.group,
    });
    const entry = { record, at: this.now(), serverTimeMs };
    this.details.set(accountNo, entry);
    await this.remember([record], 'detail');
    return entry;
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

  async knownAccounts(): Promise<AccountRecord[]> {
    const rows = await this.db.call('snapshots.all', { schemaVersion: ACCOUNT_SNAPSHOT_VERSION });
    const out: AccountRecord[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.data_json) as AccountRecord);
      } catch {
        // 跳过损坏记录
      }
    }
    return out;
  }

  async inventory(
    accountNo: string,
    opts: FetchOptions,
  ): Promise<{ items: InventoryItem[]; fetchedAt: number; fromCache: boolean }> {
    const ttl = this.cacheTtl();
    const now = this.now();
    if (!opts.refresh) {
      if (ttl === 'SESSION') {
        const hit = this.sessionInventory.get(accountNo);
        if (hit) return { items: hit.items, fetchedAt: hit.at, fromCache: true };
      } else {
        const row = await this.db.call('inventory.get', {
          accountNo,
          now,
          schemaVersion: INVENTORY_CACHE_VERSION,
        });
        if (row) {
          try {
            return {
              items: JSON.parse(row.items_json) as InventoryItem[],
              fetchedAt: row.fetched_at,
              fromCache: true,
            };
          } catch {
            // 缓存损坏时重新读取
          }
        }
      }
    }
    const items = await this.api.inventory(accountNo, {
      priority: opts.priority,
      group: opts.group,
    });
    const at = this.now();
    if (ttl === 'SESSION') {
      this.sessionInventory.set(accountNo, { items, at });
    } else {
      await this.db.call('inventory.put', {
        accountNo,
        itemsJson: JSON.stringify(items),
        now: at,
        expiresAt: at + CACHE_TTL_MS[ttl],
        schemaVersion: INVENTORY_CACHE_VERSION,
        maxBytes: INVENTORY_MAX_BYTES,
      });
    }
    return { items, fetchedAt: at, fromCache: false };
  }

  async clearCaches() {
    this.details.clear();
    this.sessionInventory.clear();
    await this.db.call('cache.clear', undefined);
  }

  forgetDetails() {
    this.details.clear();
  }
}
