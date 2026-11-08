// 组合根：与 Electron 无关，供桌面主进程和离线预览共用。主进程独占业务规则，界面只渲染 DTO。

import { BUILTIN_FILTER_PRESETS } from '../shared/builtin-presets';
import { categoryDisplay } from '../shared/catalog';
import {
  cleanCondition,
  conditionIsEmpty,
  FILTER_SCHEMA_VERSION,
  type ItemCondition,
  upgradeConditions,
} from '../shared/conditions';
import type {
  BannerView,
  DetailView,
  FilterConditions,
  FilterPresetView,
  MainEvent,
  NavigateTarget,
  SettingsView,
  StatusView,
} from '../shared/dto';
import type { IpcChannel, IpcInput, IpcOutputs } from '../shared/ipc';
import {
  quantityOptions,
  RENT_KINDS,
  RENT_META,
  type RentKind,
  supportsRent,
} from '../shared/rent';
import {
  AGREEMENT_VERSION,
  DEVICE_SCOPE,
  type DeviceSettings,
  deviceSettingsSchema,
  migrateDeviceSettings,
  type OrderPreset,
  type ProfileSettings,
  profileSettingsSchema,
} from '../shared/settings';
import { STATUS_LABEL } from '../shared/status';
import { AuthService } from './auth/auth-service';
import type { CredentialReader } from './auth/reader-process';
import { parseActivation } from './domain/activation';
import type { Logger } from './logger';
import { scrubText } from './logger';
import { defaultClientDataDir } from './paths';
import { PlatformApi } from './platform/api';
import { type HttpTransport, PlatformClient } from './platform/client';
import { isCancelled, PlatformError, userMessage } from './platform/errors';
import { Priority, RequestQueue } from './platform/queue';
import { AccountService } from './services/account-service';
import { CheckoutService } from './services/checkout-service';
import { FavoritesService } from './services/favorites-service';
import type { ImageCache } from './services/image-cache';
import { MonitorService } from './services/monitor-service';
import { NotificationService, type Notifier } from './services/notification-service';
import { computeQuote, quoteView } from './services/quote';
import { ScanService } from './services/scan-service';
import { summarize, toAccountView, toItemView } from './services/views';
import type { DbClient } from './storage/client';

export const RELEASES_URL = 'https://github.com/CamarilloG/5e-jewelry-helper/releases';
export const REPO_URL = 'https://github.com/CamarilloG/5e-jewelry-helper';
export const HELP_URL = 'https://github.com/CamarilloG/5e-jewelry-helper#readme';

export interface ShellBridge {
  openExternal(url: string): Promise<void>;
  chooseDirectory(current: string): Promise<string | null>;
  saveDiagnostics(defaultName: string, content: string): Promise<string | null>;
  confirmQuit(): void;
  showWindow(): void;
}

export interface ControllerDeps {
  db: DbClient;
  dbError: string | null;
  logger: Logger;
  transport: HttpTransport;
  reader: CredentialReader;
  notifier: Notifier;
  images: ImageCache | null;
  shell: ShellBridge;
  loadPaymentImage: (url: string) => Promise<string | null>;
  appVersion: string;
  readLogs?: () => Promise<string>;
  now?: () => number;
  mono?: () => number;
}

type Handler<C extends IpcChannel> = (input: IpcInput<C>) => Promise<IpcOutputs[C]> | IpcOutputs[C];

export class AppController {
  readonly queue: RequestQueue;
  readonly client: PlatformClient;
  readonly api: PlatformApi;
  readonly auth: AuthService;
  readonly accounts: AccountService;
  readonly favorites: FavoritesService;
  readonly scan: ScanService;
  readonly monitor: MonitorService;
  readonly notifications: NotificationService;
  readonly checkout: CheckoutService;
  private device: DeviceSettings = deviceSettingsSchema.parse({});
  private profileSettings: ProfileSettings | null = null;
  private lastProfileId: string | null = null;
  private listeners = new Set<(event: MainEvent) => void>();
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private contractBanner = false;
  private pendingActivations: string[] = [];
  private channelsCache: {
    at: number;
    list: { payChannel: 1 | 2; payChannelId: string }[];
  } | null = null;
  private couponsCache: { at: number; value: Awaited<ReturnType<PlatformApi['coupons']>> } | null =
    null;
  private durationsCache = new Map<
    string,
    { at: number; value: Awaited<ReturnType<PlatformApi['durations']>> }
  >();
  private readonly now: () => number;
  private started = false;
  private shuttingDown = false;
  private handlers: { [C in IpcChannel]: Handler<C> };

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    const logger = deps.logger;
    this.queue = new RequestQueue(this.device.rateLimitPerMinute, { now: this.now });
    this.auth = new AuthService(
      deps.reader,
      {
        confirmed: (profileId, previous) => this.onConfirmed(profileId, previous),
        lost: () => this.onAuthLost(),
      },
      logger,
      { path: defaultClientDataDir(), custom: false },
      this.now,
    );
    this.client = new PlatformClient(deps.transport, this.auth, logger);
    this.client.onAuthExpired = () => this.auth.markExpired();
    this.client.onContractChanged = () => {
      this.contractBanner = true;
      this.emitStatus();
    };
    this.api = new PlatformApi(this.client, this.queue);
    this.auth.attach(this.api);
    this.accounts = new AccountService(
      this.api,
      deps.db,
      () => this.device.inventoryCacheTtl,
      this.now,
      this.queue,
    );
    this.favorites = new FavoritesService(
      this.api,
      deps.db,
      this.accounts,
      () => this.effectiveProfileId(),
      () => this.emitFavorites(),
      logger,
      this.now,
      this.queue,
    );
    this.scan = new ScanService(
      this.api,
      this.accounts,
      () => this.favorites.localSet(),
      (view) => {
        this.emit({ type: 'scan', payload: view });
        this.emitStatus();
      },
      logger,
      this.now,
      () => this.effectiveProfileId(),
      () => this.auth.view().phase === 'OK',
    );
    this.notifications = new NotificationService(deps.db, deps.notifier, logger, this.now);
    this.monitor = new MonitorService({
      db: deps.db,
      favorites: this.favorites,
      accounts: this.accounts,
      notifications: this.notifications,
      images: deps.images,
      profile: () => this.auth.profileId(),
      settings: () => ({
        intervalSeconds: this.device.monitorIntervalSeconds,
        enabled: this.profileSettings?.monitorEnabled ?? this.device.autoStartMonitor,
        notifications: this.device.notifications,
        sound: this.device.sound,
      }),
      onChange: () => {
        this.emitStatus();
        this.emitFavorites();
      },
      logger,
      now: this.now,
    });
    this.checkout = new CheckoutService({
      api: this.api,
      db: deps.db,
      accounts: this.accounts,
      favorites: this.favorites,
      auth: this.auth,
      profile: () => this.auth.profileId(),
      agreementVersion: async () => this.profileSettings?.agreementVersion ?? null,
      defaultPreset: async () =>
        this.profileSettings?.defaultPreset ?? { payChannel: 1, autoCoupon: true },
      rateLimit: () => this.queue.getLimit(),
      loadPaymentImage: deps.loadPaymentImage,
      onChange: (view) => {
        this.emit({ type: 'checkout', payload: view });
        this.emitStatus();
      },
      onBusyChange: (busy) => {
        this.queue.setBlocked(Priority.SCAN, busy);
        this.queue.setBlocked(Priority.BACKGROUND, busy);
        if (busy) this.favorites.pauseBackfill();
        else if (this.auth.view().phase === 'OK') this.favorites.resumeBackfill();
      },
      logger,
      now: this.now,
      mono: deps.mono,
    });
    this.queue.onChange(() => this.emitStatus());
    this.handlers = this.buildHandlers();
  }

  // ---------- 事件 ----------

  subscribe(listener: (event: MainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MainEvent) {
    if (this.shuttingDown) return;
    for (const l of this.listeners) l(event);
  }

  private emitStatus() {
    if (this.shuttingDown || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.shuttingDown) return;
      this.emit({ type: 'status', payload: this.status() });
    }, 150);
  }

  private favoritesTimer: ReturnType<typeof setTimeout> | null = null;
  private emitFavorites() {
    if (this.shuttingDown || this.favoritesTimer) return;
    this.favoritesTimer = setTimeout(() => {
      this.favoritesTimer = null;
      if (this.shuttingDown) return;
      void this.favorites
        .view({ triggerBackfill: false })
        .then((payload) => this.emit({ type: 'favorites', payload }));
    }, 100);
  }

  effectiveProfileId(): string | null {
    return this.auth.profileId() ?? this.lastProfileId;
  }

  navigate(target: NavigateTarget) {
    this.deps.shell.showWindow();
    this.emit({ type: 'navigate', payload: target });
  }

  toast(kind: 'success' | 'info' | 'warning' | 'error', text: string) {
    this.emit({ type: 'toast', payload: { kind, text } });
  }

  // ---------- 生命周期 ----------

  async start() {
    if (this.started) return;
    this.started = true;
    if (this.deps.dbError) {
      this.queue.pause('数据库不可用');
      this.emitStatus();
      return;
    }
    this.lastProfileId = await this.deps.db.call('profile.lastUsed', undefined);
    const stored = await this.deps.db.call('settings.get', { scope: DEVICE_SCOPE, key: 'device' });
    const migrated = migrateDeviceSettings(stored);
    this.device = migrated.settings;
    if (migrated.migrated) {
      await this.deps.db.call('settings.set', {
        scope: DEVICE_SCOPE,
        key: 'device',
        value: this.device,
        now: this.now(),
      });
    }
    if (stored != null || this.queue.getLimit() === 30) {
      this.queue.setLimit(this.device.rateLimitPerMinute);
    }
    this.auth.setDataDir(this.dataDir());
    await this.auth.reload();
    this.emitStatus();
  }

  private dataDir() {
    return this.device.clientDataDir
      ? { path: this.device.clientDataDir, custom: true }
      : { path: defaultClientDataDir(), custom: false };
  }

  private async onConfirmed(profileId: string, previous: string | null) {
    const previousEffective = previous ?? this.lastProfileId;
    if (previousEffective && previousEffective !== profileId) {
      // 用户身份变化：停止旧身份任务，切换数据作用域，保留旧身份订单记录
      this.monitor.halt();
      this.scan.reset();
      this.checkout.detach();
      this.favorites.pauseBackfill();
      this.favorites.reset();
      this.accounts.forgetDetails();
      this.queue.cancelGroup('');
      this.deps.logger.info('auth.profile_switch', {});
    }
    this.lastProfileId = profileId;
    void this.deps.db.call('profile.touch', { profileId, now: this.now() });
    const stored = await this.deps.db.call('settings.get', { scope: profileId, key: 'profile' });
    const parsed = profileSettingsSchema.safeParse(stored ?? {});
    this.profileSettings = parsed.success ? parsed.data : profileSettingsSchema.parse({});
    if (stored == null) this.profileSettings.monitorEnabled = this.device.autoStartMonitor;
    this.queue.resume();
    this.favorites.resumeBackfill();
    // 优先处理未结束的订单记录，再启动收藏同步与监测
    await this.checkout.recover(profileId);
    this.monitor.start();
    this.emitFavorites();
    this.emitStatus();
    const pending = this.pendingActivations.splice(0);
    for (const url of pending) await this.handleActivation(url);
  }

  private onAuthLost() {
    this.favorites.pauseBackfill();
    this.queue.pause('登录态不可用');
    this.scan.interrupt('登录态失效，已暂停扫描');
    this.monitor.halt();
    this.queue.cancelGroup('monitor');
    this.queue.cancelGroup('favorites');
    this.queue.cancelGroup('favorites:backfill');
    this.emitStatus();
    const pending = this.pendingActivations.splice(0);
    if (pending.length > 0) this.navigate({ page: 'FAVORITES' });
  }

  async reloadAuth() {
    this.queue.resume();
    this.auth.setDataDir(this.dataDir());
    await this.auth.reload();
    this.emitStatus();
  }

  resumeFromSleep() {
    this.checkout.resumeFromSleep();
    void this.monitor.runRound();
  }

  async shutdown() {
    this.shuttingDown = true;
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.favoritesTimer) {
      clearTimeout(this.favoritesTimer);
      this.favoritesTimer = null;
    }
    await this.checkout.prepareQuit();
    this.favorites.pauseBackfill();
    this.monitor.halt();
    this.scan.interrupt('退出');
    this.queue.cancelGroup('favorites:backfill');
    this.queue.pause('退出');
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.favoritesTimer) {
      clearTimeout(this.favoritesTimer);
      this.favoritesTimer = null;
    }
    this.listeners.clear();
  }

  // ---------- 状态 ----------

  status(): StatusView {
    const q = this.queue.stats();
    const auth = this.auth.view();
    const banners: BannerView[] = [];
    if (auth.runtimeExpired && auth.phase !== 'OK') {
      banners.push({
        id: 'auth',
        kind: 'error',
        text: '登录态失效，已暂停监测。请在客户端重新登录后点击重新读取',
        action: 'RELOAD_AUTH',
      });
    }
    if (this.contractBanner) {
      banners.push({
        id: 'contract',
        kind: 'warning',
        text: '平台接口可能已变更，部分功能暂不可用',
      });
    }
    const scan = this.scan.state();
    let pausedReason = q.pausedReason;
    if (!pausedReason && this.queue.isBlocked(Priority.SCAN) && this.scan.isActive()) {
      pausedReason = '订单处理中，库存扫描已暂停';
    }
    return {
      auth,
      requests: {
        limit: q.limit,
        lastMinute: q.lastMinute,
        queued: q.queued,
        waitingMs: q.waitingMs,
        pausedReason,
        backoffUntil: q.backoffUntil,
      },
      monitor: this.monitor.view(),
      scan:
        scan.phase === 'IDLE' || !scan.hasItemConditions
          ? scan.phase === 'IDLE'
            ? null
            : {
                confirmed: scan.confirmed,
                candidates: scan.candidates,
                active: this.scan.isActive(),
              }
          : {
              confirmed: scan.confirmed,
              candidates: scan.candidates,
              active: this.scan.isActive(),
            },
      banners,
      dbError: this.deps.dbError,
      version: this.deps.appVersion,
    };
  }

  // ---------- 设置 ----------

  private async saveDevice(patch: Partial<DeviceSettings>) {
    this.device = deviceSettingsSchema.parse({ ...this.device, ...patch });
    await this.deps.db.call('settings.set', {
      scope: DEVICE_SCOPE,
      key: 'device',
      value: this.device,
      now: this.now(),
    });
  }

  private async saveProfile(patch: Partial<ProfileSettings>) {
    const profileId = this.auth.profileId();
    if (!profileId || !this.profileSettings) throw new Error('NO_PROFILE');
    this.profileSettings = profileSettingsSchema.parse({ ...this.profileSettings, ...patch });
    await this.deps.db.call('settings.set', {
      scope: profileId,
      key: 'profile',
      value: this.profileSettings,
      now: this.now(),
    });
  }

  deviceSettings() {
    return this.device;
  }

  async settingsView(): Promise<SettingsView> {
    const usage = this.deps.dbError
      ? { bytes: 0, entries: 0 }
      : await this.deps.db.call('inventory.usage', undefined);
    return {
      device: this.device,
      profile: this.profileSettings,
      cache: {
        inventoryBytes: usage.bytes,
        inventoryEntries: usage.entries,
        imageBytes: (await this.deps.images?.usage()) ?? 0,
      },
      defaultDataDir: defaultClientDataDir(),
      appVersion: this.deps.appVersion,
      releasesUrl: RELEASES_URL,
      repoUrl: REPO_URL,
    };
  }

  // ---------- 详情与报价 ----------

  private async durationsFor(accountNo: string, priority: Priority) {
    const hit = this.durationsCache.get(accountNo);
    if (hit && this.now() - hit.at < 30_000) return hit.value;
    const value = await this.api.durations(accountNo, { priority });
    this.durationsCache.set(accountNo, { at: this.now(), value });
    return value;
  }

  private async channels(priority: Priority) {
    if (this.channelsCache && this.now() - this.channelsCache.at < 60_000)
      return this.channelsCache.list;
    const list = await this.api.payChannels({ priority });
    this.channelsCache = { at: this.now(), list };
    return list;
  }

  private async coupons(priority: Priority) {
    if (this.couponsCache && this.now() - this.couponsCache.at < 30_000)
      return this.couponsCache.value;
    const value = await this.api.coupons({ priority });
    this.couponsCache = { at: this.now(), value };
    return value;
  }

  private defaultParamsFor(
    pricing: Parameters<typeof supportsRent>[0],
    durations: { hourDuration: number[]; dayDuration: number[]; weekDuration: number[] } | null,
    base: OrderPreset,
    available: (1 | 2)[],
  ): OrderPreset {
    const kind: RentKind = supportsRent(pricing, base.rentKind)
      ? base.rentKind
      : (RENT_KINDS.find((k) => supportsRent(pricing, k)) ?? base.rentKind);
    const options = quantityOptions(kind, durations, pricing.rentPeriod);
    const quantity =
      base.quantity != null && options.includes(base.quantity)
        ? base.quantity
        : (options[0] ?? null);
    const payChannel = available.includes(base.payChannel)
      ? base.payChannel
      : (available[0] ?? base.payChannel);
    return { rentKind: kind, quantity, payChannel, autoCoupon: base.autoCoupon };
  }

  async detail(accountNo: string, refresh: boolean): Promise<DetailView> {
    const { record, at } = await this.accounts.detail(accountNo, {
      priority: Priority.USER,
      refresh,
    });
    const favoriteSet = await this.favorites.localSet();
    const favorite = favoriteSet.has(accountNo);
    const profileId = this.auth.profileId();
    if (favorite && profileId) {
      await this.deps.db.call('favorites.updateSummary', {
        profileId,
        accountNo,
        summaryJson: JSON.stringify(summarize(this.accounts.lastSeen(accountNo) ?? record)),
      });
      this.emitFavorites();
    }
    let durations: DetailView['durations'] = null;
    try {
      const d = await this.durationsFor(accountNo, Priority.USER);
      durations = { HOUR: d.hourDuration, DAY: d.dayDuration, WEEK: d.weekDuration };
    } catch (error) {
      if (isCancelled(error)) throw error;
    }
    let channelList: { payChannel: 1 | 2 }[] = [];
    try {
      channelList = await this.channels(Priority.USER);
    } catch (error) {
      if (isCancelled(error)) throw error;
    }
    const available = channelList.map((c) => c.payChannel);
    const preset = favorite ? await this.favorites.preset(accountNo) : null;
    const base = preset ??
      this.profileSettings?.defaultPreset ?? {
        rentKind: 'HOUR',
        quantity: null,
        payChannel: 1,
        autoCoupon: true,
      };
    const durationsRaw = durations
      ? { hourDuration: durations.HOUR, dayDuration: durations.DAY, weekDuration: durations.WEEK }
      : null;
    const restrictions = this.auth.view().restrictions;
    let blocked: string | null = null;
    if (record.status !== 'AVAILABLE') blocked = `账号当前${STATUS_LABEL[record.status]}，无法出码`;
    else if (restrictions?.banned) blocked = '账号受平台限制，无法下单';
    else if (restrictions?.maintenance) blocked = '平台维护中';
    else if (restrictions && !restrictions.certified) blocked = '请先在 5E 客户端完成实名认证';
    else if (this.checkout.busy()) blocked = '已有进行中的出码，请先处理';
    return {
      account: toAccountView(record, at),
      durations,
      channels: ([1, 2] as const).map((payChannel) => ({
        payChannel,
        available: available.includes(payChannel),
      })),
      favorite,
      preset,
      defaultParams: this.defaultParamsFor(record.pricing, durationsRaw, base, available),
      agreementAccepted: this.profileSettings?.agreementVersion === AGREEMENT_VERSION,
      platformAgreementDone: restrictions?.agreementDone ?? false,
      orderBlockedReason: blocked,
    };
  }

  async quote(input: IpcInput<'account.quote'>) {
    const { record } = await this.accounts.detail(input.accountNo, { priority: Priority.USER });
    const p = input.params;
    const durations = RENT_META[p.rentKind].slot
      ? null
      : await this.durationsFor(input.accountNo, Priority.USER);
    const coupons = p.autoCoupon && record.couponAllowed ? await this.coupons(Priority.USER) : null;
    const quoteInput = {
      record,
      durations,
      rentKind: p.rentKind,
      quantity: p.quantity,
      autoCoupon: p.autoCoupon,
      coupons,
      nowMs: coupons?.serverTimeMs ?? this.now(),
    };
    return quoteView(quoteInput, computeQuote(quoteInput));
  }

  // ---------- 常用方案 ----------

  private summarizeConditions(c: FilterConditions): string {
    const items = c.items
      .filter((i) => !conditionIsEmpty(i))
      .map((i) =>
        [i.categoryIds.map(categoryDisplay).join('/'), i.names.join('/')]
          .filter(Boolean)
          .join(' · '),
      );
    const price =
      c.priceMin || c.priceMax
        ? `${c.priceMin ? `≥ ¥${c.priceMin}` : ''}${c.priceMin && c.priceMax ? ' ' : ''}${c.priceMax ? `≤ ¥${c.priceMax}` : ''}/${RENT_META[c.rentKind].unit}`
        : null;
    return [
      items.join(' + ') || '不限饰品',
      RENT_META[c.rentKind].label,
      price,
      c.couponOnly ? '仅可用券' : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }

  async filterPresets(): Promise<FilterPresetView[]> {
    const profileId = this.effectiveProfileId();
    if (!profileId) return [];
    try {
      await this.deps.db.call('filters.seedBuiltin', {
        profileId,
        presets: BUILTIN_FILTER_PRESETS.map((p) => ({
          key: p.key,
          id: crypto.randomUUID(),
          name: p.name,
          conditionsJson: JSON.stringify(p.conditions),
        })),
        schemaVersion: FILTER_SCHEMA_VERSION,
        now: this.now(),
      });
    } catch (error) {
      this.deps.logger.warn('filters.seed', { reason: (error as Error).name });
    }
    const rows = await this.deps.db.call('filters.list', { profileId });
    const out: FilterPresetView[] = [];
    for (const row of rows) {
      try {
        const conditions = upgradeConditions(JSON.parse(row.conditions_json));
        if (!conditions) continue;
        out.push({
          id: row.id,
          name: row.name,
          conditions,
          summary: this.summarizeConditions(conditions),
          lastUsedAt: row.last_used_at,
          createdAt: row.created_at,
        });
      } catch {
        // 忽略无法解析的旧方案
      }
    }
    return out;
  }

  // ---------- 通知激活 ----------

  async handleActivation(url: string) {
    const parsed = parseActivation(url);
    if (parsed === null) return;
    this.deps.shell.showWindow();
    if (parsed === 'INVALID') {
      this.navigate({ page: 'FAVORITES' });
      return;
    }
    if (this.auth.view().phase === 'INIT' || this.auth.view().phase === 'CHECKING') {
      this.pendingActivations.push(url);
      return;
    }
    const profileId = this.auth.profileId();
    const consumed = await this.notifications.consume(parsed.nonce, profileId);
    if (!consumed.ok || !consumed.intent) {
      this.deps.logger.info('activation.rejected', {
        reason: consumed.ok ? 'EMPTY' : consumed.reason,
      });
      this.navigate({ page: 'FAVORITES' });
      return;
    }
    const intent = consumed.intent;
    if (intent.action === 'list' || !intent.account_no) {
      this.navigate({ page: 'FAVORITES', filter: 'AVAILABLE' });
      return;
    }
    this.navigate({ page: 'FAVORITES', accountNo: intent.account_no });
    if (intent.action !== 'checkout') return;
    // 出码动作仍走同一个手动出码入口和订单互斥
    const result = await this.startCheckout(intent.account_no, null, 'NOTIFICATION', null);
    if (result.kind === 'NEEDS_PRESET' || result.kind === 'NEEDS_AGREEMENT') {
      this.emit({
        type: 'checkoutRequest',
        payload: { accountNo: intent.account_no, reason: result.kind },
      });
    } else if (result.kind === 'BLOCKED') {
      this.toast('warning', result.reason);
    }
  }

  private async startCheckout(
    accountNo: string,
    params: IpcInput<'checkout.start'>['params'],
    source: 'DETAIL' | 'FAVORITE' | 'NOTIFICATION',
    expectedAmountYuan: string | null,
  ) {
    let expectedUnitYuan: string | null = null;
    if (source !== 'DETAIL') {
      const fav = (await this.favorites.view()).items.find((f) => f.accountNo === accountNo);
      const kind = fav?.preset?.rentKind;
      const price = kind ? fav?.prices.find((p) => p.kind === kind)?.price : null;
      expectedUnitYuan = price ?? null;
    }
    return this.checkout.start({ accountNo, params, source, expectedAmountYuan, expectedUnitYuan });
  }

  // ---------- 诊断 ----------

  private async diagnostics(): Promise<string> {
    const favorites = await this.favorites.view();
    const scan = this.scan.state();
    const logs = this.deps.readLogs ? await this.deps.readLogs() : '';
    const report = {
      app: this.deps.appVersion,
      generatedAt: new Date(this.now()).toISOString(),
      auth: { phase: this.auth.view().phase, customDir: this.auth.view().customDir },
      settings: {
        ...this.device,
        clientDataDir: this.device.clientDataDir ? '[自定义目录]' : null,
      },
      queue: this.queue.stats(),
      monitor: this.monitor.view(),
      favorites: {
        count: favorites.items.length,
        removed: favorites.tombstones.length,
        sync: favorites.sync,
      },
      scan: {
        phase: scan.phase,
        candidates: scan.candidates,
        confirmed: scan.confirmed,
        results: scan.results.length,
      },
      checkout: this.checkout.view()?.state ?? null,
      logs: logs
        .split('\n')
        .slice(-400)
        .map((line) => scrubText(line).replace(/CS\d{6,}/g, '[account]'))
        .join('\n'),
    };
    return JSON.stringify(report, null, 2);
  }

  // ---------- IPC ----------

  handle<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcOutputs[C]> {
    const handler = this.handlers[channel] as Handler<C> | undefined;
    if (!handler) return Promise.reject(new Error('UNKNOWN_CHANNEL'));
    return Promise.resolve(handler(input));
  }

  private requireProfile(): string {
    const id = this.auth.profileId();
    if (!id) throw new PlatformError('NO_CREDENTIAL', '登录态不可用');
    return id;
  }

  private buildHandlers(): { [C in IpcChannel]: Handler<C> } {
    return {
      'app.status': () => this.status(),
      'app.openReleases': async () => {
        await this.deps.shell.openExternal(RELEASES_URL);
      },
      'app.openHelp': async () => {
        await this.deps.shell.openExternal(HELP_URL);
      },
      'app.quitConfirmed': async () => {
        this.deps.shell.confirmQuit();
      },
      'app.firstCloseHintShown': async () => {
        await this.saveDevice({ closeHintShown: true });
      },
      'auth.reload': async () => {
        await this.reloadAuth();
        return this.status();
      },
      'auth.chooseDirectory': async () => {
        const dir = await this.deps.shell.chooseDirectory(this.dataDir().path);
        if (dir) {
          await this.saveDevice({ clientDataDir: dir });
          await this.reloadAuth();
        }
        return this.status();
      },
      'auth.resetDirectory': async () => {
        await this.saveDevice({ clientDataDir: null });
        await this.reloadAuth();
        return this.status();
      },
      'scan.start': async (input) => {
        this.requireProfile();
        if (input.presetId) {
          await this.deps.db.call('filters.touch', {
            profileId: this.requireProfile(),
            id: input.presetId,
            now: this.now(),
          });
        }
        return this.scan.start(input.conditions, { forceRefresh: input.forceRefresh });
      },
      'scan.startLocal': async (input) => {
        const profileId = this.effectiveProfileId();
        if (input.presetId && profileId) {
          await this.deps.db.call('filters.touch', {
            profileId,
            id: input.presetId,
            now: this.now(),
          });
        }
        return this.scan.startLocal(input.conditions);
      },
      'scan.stop': () => this.scan.stop(),
      'scan.continue': () => this.scan.continue(),
      'scan.retryFailed': () => this.scan.retryFailed(),
      'scan.state': () => this.scan.state(),
      'account.detail': (input) => this.detail(input.accountNo, input.refresh),
      'account.inventory': async (input) => {
        const inv = await this.accounts.inventory(input.accountNo, {
          priority: Priority.USER,
          refresh: input.refresh,
        });
        // 收藏的账号用完整库存更新 3×3 宫格摘要
        const profileId = this.effectiveProfileId();
        const record = this.accounts.lastSeen(input.accountNo);
        if (profileId && record && (await this.favorites.localSet()).has(input.accountNo)) {
          await this.deps.db.call('favorites.updateSummary', {
            profileId,
            accountNo: input.accountNo,
            summaryJson: JSON.stringify(
              summarize(record, inv.items, { source: 'inventory', updatedAt: this.now() }),
            ),
          });
          this.emitFavorites();
        }
        return {
          accountNo: input.accountNo,
          items: inv.items.map(toItemView),
          fetchedAt: inv.fetchedAt,
          fromCache: inv.fromCache,
        };
      },
      'account.quote': (input) => this.quote(input),
      'favorites.state': () => this.favorites.view({ triggerBackfill: true }),
      'favorites.add': async (input) => {
        this.requireProfile();
        const record = this.accounts.lastSeen(input.accountNo);
        const result = await this.favorites.add(input.accountNo, record);
        if (result.pendingSync) this.toast('warning', '平台收藏同步失败，将在下次同步时重试');
        else this.toast('success', '已收藏');
        void this.monitor.refreshCounts().then(() => this.emitStatus());
        return result;
      },
      'favorites.remove': async (input) => {
        this.requireProfile();
        await this.favorites.remove(input.accountNo, input.alsoPlatform);
        this.toast('success', input.alsoPlatform ? '已取消收藏（含平台）' : '已从本地移除收藏');
        await this.monitor.refreshCounts();
        this.emitStatus();
      },
      'favorites.restore': async (input) => {
        this.requireProfile();
        const ok = await this.favorites.restore(input.accountNo);
        if (ok) this.toast('success', '已恢复本地收藏');
        return ok;
      },
      'favorites.platformFavorite': async (input) => {
        this.requireProfile();
        const result = await this.favorites.platformFavorite(input.accountNo);
        if (result.pendingSync) this.toast('warning', '平台收藏同步失败，将在下次同步时重试');
        else this.toast('success', '已在平台重新收藏');
        return result;
      },
      'favorites.setMonitor': async (input) => {
        this.requireProfile();
        await this.favorites.setMonitor(input.accountNo, input.enabled);
        await this.monitor.refreshCounts();
        this.emitStatus();
      },
      'favorites.markSeen': async (input) => {
        if (!this.auth.profileId()) return;
        await this.favorites.markSeen(input.accountNo);
      },
      'favorites.syncNow': async () => {
        this.requireProfile();
        void this.favorites.sync(Priority.USER).then(() => this.monitor.refreshCounts());
      },
      'favorites.savePreset': async (input) => {
        this.requireProfile();
        await this.favorites.savePreset(input.accountNo, input.preset);
        this.toast('success', '下单预设已保存');
      },
      'monitor.setEnabled': async (input) => {
        await this.saveProfile({ monitorEnabled: input.enabled });
        this.monitor.reschedule();
        this.emitStatus();
      },
      'monitor.checkNow': () => this.monitor.checkNow(),
      'filters.list': () => this.filterPresets(),
      'filters.save': async (input) => {
        const profileId = this.requireProfile();
        const res = await this.deps.db.call('filters.save', {
          profileId,
          id: crypto.randomUUID(),
          name: input.name,
          conditionsJson: JSON.stringify({
            ...input.conditions,
            items: input.conditions.items
              .map(cleanCondition)
              .filter((i: ItemCondition) => !conditionIsEmpty(i)),
          }),
          schemaVersion: FILTER_SCHEMA_VERSION,
          overwriteId: input.overwriteId,
          now: this.now(),
        });
        if (res.ok) this.toast('success', '方案已保存');
        return res;
      },
      'filters.rename': async (input) => {
        const res = await this.deps.db.call('filters.rename', {
          profileId: this.requireProfile(),
          id: input.id,
          name: input.name,
          now: this.now(),
        });
        return res.ok ? { ok: true } : { ok: false, reason: res.reason };
      },
      'filters.delete': (input) =>
        this.deps.db.call('filters.delete', { profileId: this.requireProfile(), id: input.id }),
      'checkout.start': (input) => {
        this.requireProfile();
        return this.startCheckout(
          input.accountNo,
          input.params,
          input.source,
          input.expectedAmountYuan,
        );
      },
      'checkout.state': () => this.checkout.view(),
      'checkout.cancel': async () => {
        await this.checkout.cancel();
      },
      'checkout.dismiss': async () => {
        this.checkout.dismiss();
      },
      'checkout.manualResolve': async (input) => {
        await this.checkout.manualResolve(input.result);
      },
      'agreement.accept': async (input) => {
        if (input.version !== AGREEMENT_VERSION) throw new Error('AGREEMENT_VERSION_MISMATCH');
        await this.saveProfile({
          agreementVersion: AGREEMENT_VERSION,
          agreementAcceptedAt: this.now(),
        });
      },
      'settings.get': () => this.settingsView(),
      'settings.update': async (input) => {
        const { defaultPreset, ...device } = input;
        if (Object.keys(device).length > 0) {
          await this.saveDevice(device);
          this.queue.setLimit(this.device.rateLimitPerMinute);
          this.monitor.reschedule();
        }
        if (defaultPreset) await this.saveProfile({ defaultPreset });
        this.emitStatus();
        return this.settingsView();
      },
      'cache.clear': async () => {
        await this.accounts.clearCaches();
        this.scan.clearCaches();
        await this.deps.images?.clear();
        this.toast('success', '缓存已清除（收藏、预设和订单记录不受影响）');
        return this.settingsView();
      },
      'diagnostics.export': async () => {
        const content = await this.diagnostics();
        const path = await this.deps.shell.saveDiagnostics(
          `jewelry-helper-diagnostics-${new Date(this.now()).toISOString().slice(0, 10)}.json`,
          content,
        );
        return { saved: path != null, path };
      },
    };
  }
}

export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof PlatformError) return { code: error.code, message: userMessage(error) };
  if (isCancelled(error)) return { code: 'CANCELLED', message: '已取消' };
  if (error instanceof Error && /^[A-Z_]+$/.test(error.message))
    return { code: error.message, message: error.message };
  return { code: 'ERROR', message: '操作失败，请重试' };
}
