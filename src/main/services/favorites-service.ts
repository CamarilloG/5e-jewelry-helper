// 收藏同步（业务流程 §4）：完整分页快照才用于合并；只增不删；移除记录不被导入；
// 每个账号只有一条最新写回意图，revision 递增，旧响应只能更新自身 revision。
import type { FavoritesView, FavoriteView } from '../../shared/dto';
import { RENT_META, type RentKind, supportsRent } from '../../shared/rent';
import type { OrderPreset } from '../../shared/settings';
import { ACCOUNT_STATUSES, type AccountStatus } from '../../shared/status';
import type { Logger } from '../logger';
import type { PlatformApi } from '../platform/api';
import { isCancelled, PlatformError, userMessage } from '../platform/errors';
import { Priority } from '../platform/queue';
import type { AccountRecord } from '../platform/schemas';
import type { DbClient } from '../storage/client';
import type { FavoriteRow, PresetRow } from '../storage/ops';
import type { AccountService } from './account-service';
import { type AccountSummary, priceViews, summarize } from './views';

const MAX_PAGES = 100;

export interface PlatformSnapshot {
  records: Map<string, AccountRecord>;
  complete: boolean;
}

function asStatus(value: string | null): AccountStatus | null {
  return value && (ACCOUNT_STATUSES as readonly string[]).includes(value)
    ? (value as AccountStatus)
    : null;
}

export function presetFromRow(row: PresetRow | undefined | null): OrderPreset | null {
  if (!row) return null;
  if (!(row.rent_kind in RENT_META)) return null;
  return {
    rentKind: row.rent_kind as RentKind,
    quantity: row.quantity,
    payChannel: row.pay_channel === 2 ? 2 : 1,
    autoCoupon: row.auto_coupon === 1,
  };
}

export function presetSummary(preset: OrderPreset | null): string | null {
  if (!preset) return null;
  const meta = RENT_META[preset.rentKind];
  const qty = meta.slot ? '' : ` × ${preset.quantity ?? '最小'}`;
  return `${meta.label}${qty} · ${preset.payChannel === 2 ? '微信' : '支付宝'}${preset.autoCoupon ? ' · 用券' : ''}`;
}

export class FavoritesService {
  private lastSync: { at: number | null; ok: boolean | null; error: string | null } = {
    at: null,
    ok: null,
    error: null,
  };
  private syncing: Promise<PlatformSnapshot | null> | null = null;

  constructor(
    private readonly api: PlatformApi,
    private readonly db: DbClient,
    private readonly accounts: AccountService,
    private readonly profile: () => string | null,
    private readonly onChange: () => void,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private requireProfile(): string {
    const id = this.profile();
    if (!id) throw new PlatformError('NO_CREDENTIAL', 'NO_PROFILE');
    return id;
  }

  async localSet(): Promise<Set<string>> {
    const id = this.profile();
    if (!id) return new Set();
    const { favorites } = await this.db.call('favorites.list', { profileId: id });
    return new Set(favorites.map((f) => f.account_no));
  }

  async rows(): Promise<FavoriteRow[]> {
    const id = this.profile();
    if (!id) return [];
    return (await this.db.call('favorites.list', { profileId: id })).favorites;
  }

  /** 工具内手动收藏：本地立即生效，随后按最新 revision 写回平台。 */
  async add(accountNo: string, record: AccountRecord | null): Promise<{ pendingSync: boolean }> {
    const profileId = this.requireProfile();
    const summary = record ? JSON.stringify(summarize(record)) : null;
    const { revision } = await this.db.call('favorites.addManual', {
      profileId,
      accountNo,
      now: this.now(),
      summaryJson: summary,
    });
    this.onChange();
    const ok = await this.writeBack(profileId, accountNo, 1, revision);
    this.onChange();
    return { pendingSync: !ok };
  }

  /** 平台已取消、本地仍收藏时“重新在平台收藏”。 */
  async platformFavorite(accountNo: string) {
    return this.add(accountNo, null);
  }

  async remove(accountNo: string, alsoPlatform: boolean): Promise<void> {
    const profileId = this.requireProfile();
    const { revision } = await this.db.call('favorites.removeManual', {
      profileId,
      accountNo,
      alsoPlatform,
      now: this.now(),
    });
    this.onChange();
    if (alsoPlatform && revision != null) {
      await this.writeBack(profileId, accountNo, 0, revision);
      this.onChange();
    }
  }

  async restore(accountNo: string): Promise<boolean> {
    const profileId = this.requireProfile();
    const ok = await this.db.call('favorites.restore', { profileId, accountNo, now: this.now() });
    this.onChange();
    return ok;
  }

  async setMonitor(accountNo: string, enabled: boolean) {
    await this.db.call('favorites.setMonitor', {
      profileId: this.requireProfile(),
      accountNo,
      enabled,
    });
    this.onChange();
  }

  async markSeen(accountNo: string | null) {
    await this.db.call('favorites.markSeen', { profileId: this.requireProfile(), accountNo });
    this.onChange();
  }

  async savePreset(accountNo: string, preset: OrderPreset & { quantity: number }) {
    await this.db.call('presets.save', {
      profileId: this.requireProfile(),
      accountNo,
      rentKind: preset.rentKind,
      quantity: preset.quantity,
      payChannel: preset.payChannel,
      autoCoupon: preset.autoCoupon,
      now: this.now(),
    });
    this.onChange();
  }

  async preset(accountNo: string): Promise<OrderPreset | null> {
    const id = this.profile();
    if (!id) return null;
    return presetFromRow(await this.db.call('presets.get', { profileId: id, accountNo }));
  }

  /** 执行一次写回；成功只在 revision 仍为最新时生效；失败留待下轮同步重试。 */
  private async writeBack(
    profileId: string,
    accountNo: string,
    target: 0 | 1,
    revision: number,
  ): Promise<boolean> {
    try {
      await this.api.favoriteUpdate(accountNo, target, { priority: Priority.USER });
      const res = await this.db.call('syncOps.succeeded', { profileId, accountNo, revision });
      this.logger.info('favorites.write', { state: res.current ? 'APPLIED' : 'SUPERSEDED' });
      return true;
    } catch (error) {
      if (isCancelled(error)) return false;
      await this.db.call('syncOps.failed', {
        profileId,
        accountNo,
        revision,
        error: userMessage(error),
        nextAttemptAt: 0,
      });
      this.logger.warn('favorites.write', {
        state: 'FAILED',
        reason: error instanceof PlatformError ? error.code : 'ERROR',
      });
      return false;
    }
  }

  /** 同步一轮：先执行待写回的最新意图，再完整读取平台收藏并合并。 */
  sync(priority: Priority = Priority.MONITOR): Promise<PlatformSnapshot | null> {
    if (!this.syncing) {
      this.syncing = this.doSync(priority).finally(() => {
        this.syncing = null;
        this.onChange();
      });
      this.onChange();
    }
    return this.syncing;
  }

  isSyncing() {
    return this.syncing != null;
  }

  private async doSync(priority: Priority): Promise<PlatformSnapshot | null> {
    const profileId = this.profile();
    if (!profileId) return null;
    const due = await this.db.call('syncOps.due', { profileId, now: this.now() });
    for (const op of due) {
      await this.writeBack(profileId, op.account_no, op.target_status, op.revision);
    }
    const records = new Map<string, AccountRecord>();
    let complete = true;
    let total = Number.POSITIVE_INFINITY;
    let error: string | null = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const result = await this.api.favoritesPage(page, { priority, group: 'favorites' });
        total = result.total;
        if (result.accounts.length === 0) break;
        let fresh = 0;
        for (const r of result.accounts) {
          if (!records.has(r.accountNo)) fresh++;
          records.set(r.accountNo, r);
        }
        if (fresh === 0) {
          complete = false;
          error = '平台收藏分页重复，本轮不合并删除状态';
          break;
        }
        if (records.size >= total) break;
      } catch (e) {
        if (isCancelled(e)) return null;
        complete = false;
        error = userMessage(e);
        break;
      }
    }
    if (complete && records.size < total && Number.isFinite(total)) complete = false;
    if (!profileId || this.profile() !== profileId) return null;
    for (const record of records.values()) this.accounts.noteRecord(record);
    await this.accounts.remember([...records.values()], 'favorite');
    const merge = await this.db.call('favorites.mergePlatform', {
      profileId,
      accounts: [...records.values()].map((r) => ({
        accountNo: r.accountNo,
        summaryJson: JSON.stringify(summarize(r)),
      })),
      complete,
      now: this.now(),
    });
    this.lastSync = {
      at: this.now(),
      ok: complete && error == null,
      error: complete ? null : (error ?? '平台收藏读取不完整'),
    };
    this.logger.info('favorites.sync', {
      count: records.size,
      state: complete ? 'COMPLETE' : 'INCOMPLETE',
      reason: merge.added.length ? 'ADDED' : undefined,
    });
    return { records, complete };
  }

  async view(): Promise<FavoritesView> {
    const id = this.profile();
    if (!id) {
      return {
        items: [],
        tombstones: [],
        sync: {
          lastAt: this.lastSync.at,
          ok: this.lastSync.ok,
          error: this.lastSync.error,
          running: this.isSyncing(),
        },
      };
    }
    const data = await this.db.call('favorites.list', { profileId: id });
    const ops = new Map(data.syncOps.map((o) => [o.account_no, o]));
    const presets = new Map(data.presets.map((p) => [p.account_no, p]));
    const items: FavoriteView[] = data.favorites.map((row) => {
      let summary: AccountSummary | null = null;
      try {
        summary = row.summary_json ? (JSON.parse(row.summary_json) as AccountSummary) : null;
      } catch {
        summary = null;
      }
      const preset = presetFromRow(presets.get(row.account_no));
      const op = ops.get(row.account_no);
      const prices = summary ? priceViews(summary.pricing) : [];
      const presetKind: RentKind | null =
        preset?.rentKind ??
        (summary
          ? ((['HOUR', 'DAY', 'WEEK', 'EARLY', 'NOON', 'NIGHT'] as RentKind[]).find((k) =>
              supportsRent(summary.pricing, k),
            ) ?? null)
          : null);
      const price = presetKind && summary ? (summary.pricing.prices[presetKind] ?? null) : null;
      return {
        accountNo: row.account_no,
        status: (asStatus(row.display_status) ?? 'UNKNOWN') as AccountStatus,
        trustedStatus: asStatus(row.trusted_status),
        monitorEnabled: row.monitor_enabled === 1,
        source: row.source,
        platformState: row.platform_state,
        pendingSync: !!op && op.target_status === 1,
        syncError: op?.last_error ?? null,
        lastChange: row.last_change_at
          ? { at: row.last_change_at, from: row.last_change_from, to: row.last_change_to }
          : null,
        checkedAt: row.checked_at,
        checkError: row.display_error,
        expireTimeMs: row.expire_time_ms,
        unseen: row.unseen === 1,
        createdAt: row.created_at,
        tags: summary?.tags ?? [],
        thumbnail: summary?.thumbnail ?? null,
        prices,
        preset,
        presetSummary: presetSummary(preset),
        presetPrice: price && presetKind ? `${price}/${RENT_META[presetKind].unit}` : null,
      };
    });
    return {
      items,
      tombstones: data.tombstones.map((t) => ({
        accountNo: t.account_no,
        removedAt: t.removed_at,
        reason: t.reason,
      })),
      sync: {
        lastAt: this.lastSync.at,
        ok: this.lastSync.ok,
        error: this.lastSync.error,
        running: this.isSyncing(),
      },
    };
  }

  reset() {
    this.lastSync = { at: null, ok: null, error: null };
  }
}
