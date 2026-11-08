// 主进程投影给界面的显示 DTO。界面只渲染这些结果，不复制计费、状态判定或调度规则。
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

export interface ScanResultView {
  account: AccountView;
  score: number;
  hitItems: ItemView[];
  hitCount: number;
  favorite: boolean;
  origin: 'platform' | 'local';
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
}

export interface FilterConditions {
  items: { categoryId: string | null; name: string | null }[];
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
