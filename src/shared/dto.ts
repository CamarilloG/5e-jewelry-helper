// 主进程投影给界面的显示 DTO。界面只渲染这些结果，不复制计费、状态判定或调度规则。
import type { ItemCondition } from './conditions';
import { compareDecimalText } from './money';
import type { RentKind } from './rent';
import type { DeviceSettings, OrderPreset, ProfileSettings } from './settings';
import type { AccountStatus } from './status';

export type AuthPhase =
  | 'INIT'
  | 'CHECKING'
  | 'OK'
  | 'NO_CLIENT'
  | 'NO_LOGIN'
  | 'EXPIRED'
  | 'READ_FAILED'
  | 'NETWORK';

export interface AuthView {
  phase: AuthPhase;
  /** 运行中失效：显示顶部横幅而不是引导页 */
  runtimeExpired: boolean;
  daysLeft: number | null;
  readAt: number | null;
  dataDir: string;
  customDir: boolean;
  errorSummary: string | null;
  restrictions: {
    certified: boolean;
    banned: boolean;
    maintenance: boolean;
    agreementDone: boolean;
  } | null;
}

export interface RequestView {
  limit: number;
  lastMinute: number;
  queued: number;
  waitingMs: number;
  pausedReason: string | null;
  backoffUntil: number | null;
}

export interface MonitorView {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  nextAt: number | null;
  cooldownUntil: number | null;
  lastRoundAt: number | null;
  lastRoundError: string | null;
  monitored: number;
  available: number;
  badge: number;
  paused: boolean;
}

export interface StatusView {
  auth: AuthView;
  requests: RequestView;
  monitor: MonitorView;
  scan: { confirmed: number; candidates: number; active: boolean } | null;
  banners: BannerView[];
  dbError: string | null;
  version: string;
}

export interface BannerView {
  id: string;
  kind: 'error' | 'warning' | 'info';
  text: string;
  action?: 'RELOAD_AUTH' | 'RETRY_SCAN' | 'SYNC_FAVORITES';
}

export interface ItemView {
  key: string;
  name: string;
  exterior: string;
  wear: string | null;
  price: string | null;
  image: string | null;
  fallbackImage: string | null;
  rarityColor: string | null;
  rarityName: string;
  statTrak: boolean;
  firstType: string;
  stickers: string[];
}

export interface PriceView {
  kind: RentKind;
  supported: boolean;
  price: string | null;
  firstPrice: string | null;
  actPrice: string | null;
}

export interface AccountView {
  accountNo: string;
  status: AccountStatus;
  expireTimeMs: number | null;
  tags: string[];
  value: string | null;
  prices: PriceView[];
  supported: RentKind[];
  rentPeriod: number | null;
  weekRange: { EARLY: number[]; NOON: number[]; NIGHT: number[] };
  couponAllowed: boolean;
  isFirst: boolean;
  displayItems: ItemView[];
  platformFavorited: boolean | null;
  fetchedAt: number;
}

export type ScanPhase = 'IDLE' | 'CANDIDATES' | 'VERIFYING' | 'COMPLETE' | 'STOPPED' | 'FAILED';

export type MatchEvidenceKind = 'inventory' | 'search';
export type SummarySourceKind = 'inventory' | 'display' | 'empty_inventory';

export interface ScanResultView {
  account: AccountView;
  /** 库存确认路径为去重命中件数；搜索证据快速路径未读库存时为 null（“未计算”） */
  score: number | null;
  hitItems: ItemView[];
  /** 已读完整库存时，未命中饰品按估价从高到低的前几件，用于填满卡片饰品位 */
  fillItems?: ItemView[];
  /** 库存确认路径为去重命中件数；搜索证据快速路径未读库存时为 null（“未计算”） */
  hitCount: number | null;
  favorite: boolean;
  origin: 'platform' | 'local';
  /** 匹配证据类型：完整库存（inventory）或已认证类别搜索证据（search） */
  evidence?: MatchEvidenceKind;
  /** 证据核验时间戳 */
  verifiedAt?: number;
  /** 是否来自上次结果/历史快照且尚未完成本轮远程复核 */
  fromHistory?: boolean;
  /** 本轮复核请求失败（保留历史条目并标“未能复核”） */
  reverifyFailed?: boolean;
  /** 离线、身份未确认或库存过期时的历史/待核验标记，不计为实时可租 */
  stale?: boolean;
}

export interface FailedSearchPage {
  keyword: string;
  page: number;
  error: string;
}

export interface ScanView {
  scanId: number;
  phase: ScanPhase;
  conditions: FilterConditions | null;
  hasItemConditions: boolean;
  candidates: number;
  confirmed: number;
  results: ScanResultView[];
  failedAccounts: string[];
  incomplete: boolean;
  error: string | null;
  warnings: string[];
  startedAt: number | null;
  finishedAt: number | null;
  /** 候选发现是否已结束（发现未结束时不显示固定总量百分比） */
  discoveryComplete?: boolean;
  /** 已检查数量 */
  checkedCount?: number;
  /** 待检查数量 */
  pendingCount?: number;
  /** 覆盖是否完整（区别于任务 phase === 'COMPLETE'） */
  coverageComplete?: boolean;
  /** 未完整覆盖的具体原因列表 */
  partialReasons?: string[];
  /** 失败的搜索分页列表（可随 retryFailed 一并恢复） */
  failedPages?: FailedSearchPage[];
  /** 候选快照时间（命中五分钟分页缓存或本地历史快照时显示） */
  snapshotAt?: number | null;
  /** 本轮候选是否复用了五分钟搜索缓存 */
  fromCache?: boolean;
  /** 是否为独立“本地匹配”模式 */
  localOnly?: boolean;
  /** 空结果原因（如无本地记录、候选来源不可用） */
  emptyReason?: 'NO_LOCAL_RECORDS' | 'SOURCE_UNAVAILABLE' | null;
}

export interface FilterConditions {
  items: ItemCondition[];
  rentKind: RentKind;
  priceMin: string | null;
  priceMax: string | null;
  couponOnly: boolean;
}

export interface DetailView {
  account: AccountView;
  durations: Record<'HOUR' | 'DAY' | 'WEEK', number[]> | null;
  channels: { payChannel: 1 | 2; available: boolean }[];
  favorite: boolean;
  preset: OrderPreset | null;
  defaultParams: OrderPreset;
  agreementAccepted: boolean;
  platformAgreementDone: boolean;
  orderBlockedReason: string | null;
}

export interface InventoryView {
  accountNo: string;
  items: ItemView[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface QuoteView {
  rentKind: RentKind;
  quantity: number;
  unitYuan: string;
  originalYuan: string;
  amountYuan: string;
  discountYuan: string;
  couponApplied: boolean;
  quantityOptions: number[];
  error: string | null;
}

export interface FavoriteView {
  accountNo: string;
  status: AccountStatus;
  trustedStatus: AccountStatus | null;
  monitorEnabled: boolean;
  source: 'local' | 'platform';
  platformState: 'favorited' | 'removed' | 'unknown';
  pendingSync: boolean;
  syncError: string | null;
  lastChange: { at: number; from: string | null; to: string | null } | null;
  checkedAt: number | null;
  checkError: string | null;
  expireTimeMs: number | null;
  unseen: boolean;
  createdAt: number;
  tags: string[];
  thumbnail: string | null;
  /** C1–C3：摘要版本（v2 支持 3×3 宫格选图与来源区分） */
  summaryVersion?: 1 | 2;
  /** C1–C3：3×3 宫格饰品条目（至多 9 件） */
  gridItems?: ItemView[];
  /** C3：摘要来源（inventory 完整库存 / display 列表展示位 / empty_inventory 已确认空库存） */
  summarySource?: SummarySourceKind;
  /** C3：摘要来源时间 */
  summaryUpdatedAt?: number | null;
  prices: PriceView[];
  preset: OrderPreset | null;
  presetSummary: string | null;
  presetPrice: string | null;
}

export interface FavoritesView {
  items: FavoriteView[];
  tombstones: { accountNo: string; removedAt: number; reason: string }[];
  sync: { lastAt: number | null; ok: boolean | null; error: string | null; running: boolean };
}

export type CheckoutState =
  | 'CHECKING'
  | 'CREATING'
  | 'PENDING'
  | 'CREATE_UNKNOWN'
  | 'STATUS_UNKNOWN'
  | 'RELEASE_PENDING'
  | 'RELEASE_ACCEPTED'
  | 'RELEASE_UNKNOWN'
  | 'PAID'
  | 'EXPIRED'
  | 'REJECTED'
  | 'PREFLIGHT_CANCELLED'
  | 'MANUALLY_RESOLVED';

export interface CheckoutView {
  attemptId: string;
  accountNo: string;
  state: CheckoutState;
  params: { rentKind: RentKind; quantity: number; payChannel: 1 | 2; autoCoupon: boolean } | null;
  quote: {
    amountYuan: string;
    originalYuan: string;
    discountYuan: string;
    couponApplied: boolean;
  } | null;
  paymentImage: string | null;
  imageError: boolean;
  deadlineMs: number | null;
  remainingMs: number | null;
  statusText: string;
  reason: { code: string; text: string; retryable: boolean } | null;
  releaseState: 'NONE' | 'REQUESTED' | 'ACCEPTED' | 'FAILED' | 'NOT_NEEDED';
  finished: boolean;
  canCancel: boolean;
  canRetry: boolean;
  needsManualCheck: boolean;
  createdAt: number;
}

export type CheckoutStartResult =
  | { kind: 'STARTED'; attemptId: string }
  | { kind: 'EXISTING'; attemptId: string }
  | { kind: 'NEEDS_PRESET'; accountNo: string }
  | { kind: 'NEEDS_AGREEMENT'; accountNo: string }
  | { kind: 'BLOCKED'; reason: string };

export interface FilterPresetView {
  id: string;
  name: string;
  conditions: FilterConditions;
  summary: string;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface SettingsView {
  device: DeviceSettings;
  profile: ProfileSettings | null;
  cache: { inventoryBytes: number; inventoryEntries: number; imageBytes: number };
  defaultDataDir: string;
  appVersion: string;
  releasesUrl: string;
  repoUrl: string;
}

export type NavigateTarget =
  | { page: 'FILTER' }
  | { page: 'FAVORITES'; accountNo?: string; filter?: 'AVAILABLE' }
  | { page: 'PRESETS' }
  | { page: 'SETTINGS'; section?: string };

export type MainEvent =
  | { type: 'status'; payload: StatusView }
  | { type: 'scan'; payload: ScanView }
  | { type: 'favorites'; payload: FavoritesView }
  | { type: 'checkout'; payload: CheckoutView | null }
  | { type: 'navigate'; payload: NavigateTarget }
  | {
      type: 'checkoutRequest';
      payload: { accountNo: string; reason: 'NEEDS_PRESET' | 'NEEDS_AGREEMENT' };
    }
  | { type: 'toast'; payload: { kind: 'success' | 'info' | 'warning' | 'error'; text: string } }
  | { type: 'confirmQuit'; payload: { hasAttempt: boolean } };

export type MainEventType = MainEvent['type'];
export const MAIN_EVENT_TYPES: MainEventType[] = [
  'status',
  'scan',
  'favorites',
  'checkout',
  'navigate',
  'checkoutRequest',
  'toast',
  'confirmQuit',
];

export type SortKey = 'SCORE' | 'PRICE_ASC' | 'PRICE_DESC' | 'VALUE_ASC' | 'VALUE_DESC';
export type StatusFilter = 'AVAILABLE' | 'ALL' | 'RENTED' | 'OFF_SHELF';

export function sortResultList(
  list: ScanResultView[],
  sort: SortKey,
  rentKind: RentKind,
): ScanResultView[] {
  const priceOf = (r: ScanResultView) =>
    r.account.prices.find((p) => p.kind === rentKind)?.price ?? null;
  const sorted = [...list];
  sorted.sort((a, b) => {
    switch (sort) {
      case 'SCORE': {
        // A3（R04）：按匹配度排序仅比较已确认库存（score != null）的结果，未计算项排在后面按价格升序
        const aHas = a.evidence !== 'search' && a.score != null;
        const bHas = b.evidence !== 'search' && b.score != null;
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        if (aHas && bHas) {
          const diff = (b.score ?? 0) - (a.score ?? 0);
          if (diff !== 0) return diff;
        }
        return compareDecimalText(priceOf(a), priceOf(b));
      }
      case 'PRICE_ASC':
        return compareDecimalText(priceOf(a), priceOf(b));
      case 'PRICE_DESC':
        return compareDecimalText(priceOf(b), priceOf(a));
      case 'VALUE_ASC':
        return compareDecimalText(a.account.value, b.account.value);
      case 'VALUE_DESC':
        return compareDecimalText(b.account.value, a.account.value);
    }
    return 0;
  });
  return sorted;
}

/**
 * A5（R05）：在默认“仅可租”视图下，将状态待确认（UNKNOWN 或离线历史 stale）的结果分入独立的
 * “已匹配，状态待确认”分组；状态确认后自动移入对应状态分组，“当前可租”只统计已确认可租项。
 */
/** 结果卡片/列表的饰品位：命中饰品优先，空位用补位候选按估价从高到低补齐。 */
export function resultDisplayItems(
  hitItems: readonly ItemView[],
  fillCandidates: readonly ItemView[],
  limit: number,
): ItemView[] {
  const shown = hitItems.slice(0, limit);
  const used = new Set(shown.map((item) => item.key));
  const fill = fillCandidates
    .filter((item) => !used.has(item.key))
    .sort(
      (a, b) =>
        // 与 null 比较时有效估价得 -1、缺失得 0，保证缺失估价排在最后
        compareDecimalText(a.price, null) - compareDecimalText(b.price, null) ||
        compareDecimalText(b.price, a.price),
    );
  return [...shown, ...fill.slice(0, Math.max(0, limit - shown.length))];
}

export function partitionResultsForFilter(
  allResults: ScanResultView[],
  sort: SortKey,
  statusFilter: StatusFilter,
  rentKind: RentKind,
): {
  mainResults: ScanResultView[];
  pendingResults: ScanResultView[];
  availableCount: number;
  hiddenNonAvailableCount: number;
} {
  const isPending = (r: ScanResultView) => r.account.status === 'UNKNOWN' || Boolean(r.stale);
  const confirmedAvailable = allResults.filter(
    (r) => !isPending(r) && r.account.status === 'AVAILABLE',
  );
  const pending = allResults.filter(isPending);
  const hiddenNonAvailableCount = allResults.filter(
    (r) => !isPending(r) && (r.account.status === 'RENTED' || r.account.status === 'OFF_SHELF'),
  ).length;

  if (statusFilter === 'AVAILABLE') {
    return {
      mainResults: sortResultList(confirmedAvailable, sort, rentKind),
      pendingResults: sortResultList(pending, sort, rentKind),
      availableCount: confirmedAvailable.length,
      hiddenNonAvailableCount,
    };
  }

  if (statusFilter === 'ALL') {
    return {
      mainResults: sortResultList(allResults, sort, rentKind),
      pendingResults: [],
      availableCount: confirmedAvailable.length,
      hiddenNonAvailableCount: 0,
    };
  }

  const filtered = allResults.filter((r) => !isPending(r) && r.account.status === statusFilter);
  return {
    mainResults: sortResultList(filtered, sort, rentKind),
    pendingResults: [],
    availableCount: confirmedAvailable.length,
    hiddenNonAvailableCount: 0,
  };
}
