// 收藏监测（业务流程 §2、§5）：一轮未结束不重叠，结束后再等待配置间隔；立即检查 30 秒冷却并复用进行中的轮次。
import type { MonitorView } from '../../shared/dto';
import { RENT_META, type RentKind, supportsRent } from '../../shared/rent';
import { MONITOR_MIN_SECONDS } from '../../shared/settings';
import type { AccountStatus } from '../../shared/status';
import { type MonitorState, type Observation, observe } from '../domain/monitor';
import type { Logger } from '../logger';
import { isCancelled, userMessage } from '../platform/errors';
import { Priority } from '../platform/queue';
import type { DbClient } from '../storage/client';
import type { FavoriteRow, OpArgs } from '../storage/ops';
import type { AccountService } from './account-service';
import type { FavoritesService } from './favorites-service';
import type { ImageCache } from './image-cache';
import type { AvailableAccount, NotificationService } from './notification-service';
import { presetDigest } from './notification-service';
import { type AccountSummary, summarize } from './views';

const COOLDOWN = 30_000;

function rowState(row: FavoriteRow): MonitorState {
  return {
    trustedStatus: (row.trusted_status as AccountStatus | null) ?? null,
    trustedAt: row.trusted_at,
    displayStatus: (row.display_status as AccountStatus) ?? 'UNKNOWN',
    displayError: row.display_error,
    checkedAt: row.checked_at,
    expireTimeMs: row.expire_time_ms,
    lastChangeAt: row.last_change_at,
    lastChangeFrom: (row.last_change_from as AccountStatus | null) ?? null,
    lastChangeTo: (row.last_change_to as AccountStatus | null) ?? null,
    cycleId: row.cycle_id,
    notifiedCycle: row.notified_cycle,
    baselinePending: row.baseline_pending === 1,
    unseen: row.unseen === 1,
  };
}

export interface MonitorDeps {
  db: DbClient;
  favorites: FavoritesService;
  accounts: AccountService;
  notifications: NotificationService;
  images: ImageCache | null;
  profile: () => string | null;
  settings: () => {
    intervalSeconds: number;
    enabled: boolean;
    notifications: boolean;
    sound: boolean;
  };
  onChange: () => void;
  onAvailable?: (accountNos: string[]) => void;
  logger: Logger;
  now?: () => number;
}

export class MonitorService {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt: number | null = null;
  private cooldownUntil: number | null = null;
  private lastRoundAt: number | null = null;
  private lastRoundError: string | null = null;
  private counts = { monitored: 0, available: 0, badge: 0 };
  private active = false;
  private readonly now: () => number;

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 身份确认后启动（若设置开启）。 */
  start() {
    this.active = true;
    void this.refreshCounts();
    if (this.deps.settings().enabled) this.schedule(0);
    this.deps.onChange();
  }

  /** 登录失效或切换用户：停止计时并取消排队中的监测请求。 */
  halt() {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.deps.onChange();
  }

  /** 设置变化（全局开关、间隔）后重新安排下次检查。 */
  reschedule() {
    if (!this.active) return;
    if (!this.deps.settings().enabled) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.nextAt = null;
    } else if (!this.running) {
      this.schedule(this.intervalMs());
    }
    this.deps.onChange();
  }

  private intervalMs() {
    return Math.max(MONITOR_MIN_SECONDS, this.deps.settings().intervalSeconds) * 1000;
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextAt = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runRound();
    }, delay);
  }

  checkNow(): { started: boolean; cooldownUntil: number | null } {
    if (!this.active) return { started: false, cooldownUntil: null };
    if (this.running) return { started: true, cooldownUntil: this.cooldownUntil };
    const now = this.now();
    if (this.cooldownUntil && now < this.cooldownUntil)
      return { started: false, cooldownUntil: this.cooldownUntil };
    this.cooldownUntil = now + COOLDOWN;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.runRound();
    return { started: true, cooldownUntil: this.cooldownUntil };
  }

  runRound(): Promise<void> {
    if (this.running) return this.running;
    this.nextAt = null;
    this.running = this.round()
      .catch((error: unknown) => {
        if (!isCancelled(error)) this.lastRoundError = userMessage(error);
      })
      .finally(() => {
        this.running = null;
        this.lastRoundAt = this.now();
        if (this.active && this.deps.settings().enabled) this.schedule(this.intervalMs());
        this.deps.onChange();
      });
    this.deps.onChange();
    return this.running;
  }

  private async round() {
    const profileId = this.deps.profile();
    if (!profileId) return;
    const snapshot = await this.deps.favorites.sync(Priority.MONITOR);
    if (this.deps.profile() !== profileId) return;
    const rows = await this.deps.favorites.rows();
    let failures = 0;
    const updates: OpArgs<'favorites.applyObservations'>['updates'] = [];
    const notifyRows: { row: FavoriteRow; summary: AccountSummary | null }[] = [];
    for (const row of rows) {
      if (!this.active || this.deps.profile() !== profileId) return;
      if (row.monitor_enabled !== 1) continue;
      let obs: Observation;
      let summaryJson: string | null = null;
      const fromSnapshot = snapshot?.records.get(row.account_no);
      if (fromSnapshot?.statusKnown) {
        obs = { ok: true, status: fromSnapshot.status, expireTimeMs: fromSnapshot.expireTimeMs };
      } else {
        try {
          const detail = await this.deps.accounts.detail(row.account_no, {
            priority: Priority.MONITOR,
            group: 'monitor',
            refresh: true,
          });
          obs = {
            ok: true,
            status: detail.record.status,
            expireTimeMs: detail.record.expireTimeMs,
          };
          summaryJson = JSON.stringify(summarize(detail.record));
        } catch (error) {
          if (isCancelled(error)) return;
          failures++;
          obs = { ok: false, error: userMessage(error) };
        }
      }
      const result = observe(rowState(row), obs, this.now());
      const n = result.next;
      updates.push({
        accountNo: row.account_no,
        trustedStatus: n.trustedStatus,
        trustedAt: n.trustedAt,
        displayStatus: n.displayStatus,
        displayError: n.displayError,
        checkedAt: n.checkedAt ?? this.now(),
        expireTimeMs: n.expireTimeMs,
        lastChangeAt: n.lastChangeAt,
        lastChangeFrom: n.lastChangeFrom,
        lastChangeTo: n.lastChangeTo,
        cycleId: n.cycleId,
        notifiedCycle: n.notifiedCycle,
        baselinePending: n.baselinePending ? 1 : 0,
        unseen: n.unseen ? 1 : 0,
        summaryJson,
      });
      if (result.notify) {
        let summary: AccountSummary | null = null;
        try {
          summary = JSON.parse(summaryJson ?? row.summary_json ?? 'null') as AccountSummary | null;
        } catch {
          summary = null;
        }
        notifyRows.push({ row, summary });
      }
    }
    await this.deps.db.call('favorites.applyObservations', {
      profileId,
      updates,
    });
    this.lastRoundError =
      snapshot && !snapshot.complete
        ? '平台收藏同步不完整，本地收藏不受影响'
        : failures > 0
          ? `${failures} 个账号检查失败`
          : snapshot == null
            ? '平台收藏同步失败'
            : null;
    await this.refreshCounts();
    if (notifyRows.length > 0) await this.notify(profileId, notifyRows);
    this.deps.onChange();
  }

  private async notify(
    profileId: string,
    list: { row: FavoriteRow; summary: AccountSummary | null }[],
  ) {
    const s = this.deps.settings();
    const presets = await Promise.all(
      list.map((x) => this.deps.favorites.preset(x.row.account_no)),
    );
    const accounts: AvailableAccount[] = [];
    for (const [i, { row, summary }] of list.entries()) {
      const preset = presets[i] ?? null;
      let kind: RentKind | null = preset?.rentKind ?? null;
      if (!kind && summary) {
        kind =
          (['HOUR', 'DAY', 'WEEK', 'EARLY', 'NOON', 'NIGHT'] as RentKind[]).find((k) =>
            supportsRent(summary.pricing, k),
          ) ?? null;
      }
      const price = kind && summary ? summary.pricing.prices[kind] : null;
      accounts.push({
        accountNo: row.account_no,
        tagline: (summary?.tags ?? []).join(' ').slice(0, 24),
        priceText: price && kind ? `¥${price}/${RENT_META[kind].unit}` : null,
        imagePath:
          list.length === 1 && this.deps.images
            ? await this.deps.images.localPath(summary?.thumbnailSource ?? null)
            : null,
        presetDigest: preset ? presetDigest(preset) : null,
      });
    }
    this.deps.onAvailable?.(accounts.map((a) => a.accountNo));
    await this.deps.notifications.notifyAvailable(profileId, accounts, {
      enabled: s.notifications,
      sound: s.sound,
    });
  }

  async refreshCounts() {
    const rows = await this.deps.favorites.rows();
    const monitored = rows.filter((r) => r.monitor_enabled === 1);
    this.counts = {
      monitored: monitored.length,
      available: monitored.filter((r) => r.display_status === 'AVAILABLE').length,
      badge: rows.filter((r) => r.display_status === 'AVAILABLE').length,
    };
  }

  view(): MonitorView {
    const s = this.deps.settings();
    return {
      enabled: s.enabled,
      running: this.running != null,
      intervalSeconds: s.intervalSeconds,
      nextAt: this.nextAt,
      cooldownUntil:
        this.cooldownUntil && this.cooldownUntil > this.now() ? this.cooldownUntil : null,
      lastRoundAt: this.lastRoundAt,
      lastRoundError: this.lastRoundError,
      monitored: this.counts.monitored,
      available: this.counts.available,
      badge: this.counts.badge,
      paused: !s.enabled || !this.active,
    };
  }
}
