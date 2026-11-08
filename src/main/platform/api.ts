// 平台接口适配器：全部请求经统一队列；只读请求可退避重试，写入类请求（预检、创建、解锁、收藏写回）只发送一次。
import { RENT_META, type RentKind } from '../../shared/rent';
import type { CallResult, PlatformClient } from './client';
import { Priority, type RequestQueue } from './queue';
import {
  type AccountRecord,
  authInfoSchema,
  channelDataSchema,
  couponDataSchema,
  createDataSchema,
  durationSchema,
  favoritesDataSchema,
  globalConfigSchema,
  type InventoryItem,
  inventoryDataSchema,
  lockDataSchema,
  normalizeAccount,
  normalizeInventory,
  orderDetailsSchema,
  orderListSchema,
  payStatusSchema,
  rawAccountSchema,
  searchDataSchema,
  userInfoSchema,
} from './schemas';

export const PAGE_SIZE = 100;
export const ORDER_PAGE_SIZE = 10;
const READ_TIMEOUT = 15_000;
const CREATE_TIMEOUT = 20_000;
const UNLOCK_TIMEOUT = 10_000;

export interface CallOptions {
  priority: Priority;
  group?: string;
}

const flag = (v: unknown) => v === true || Number(v) === 1;

export interface UserInfo {
  profileId: string;
  certified: boolean;
  banned: boolean;
  maintenance: boolean;
}

export interface CouponRaw {
  id: string;
  couponType: number;
  discountType: number;
  discountValue: string;
  thresholdAmount: string;
  status: number;
  validStartAtMs: number | null;
  validEndAtMs: number | null;
}

function timeToMs(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1e12 ? n : n * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export interface CreateOrderBody {
  accountNo: string;
  buyCount: number;
  buyTimeType: number;
  payChannel: number;
  /** 分，十进制字符串 */
  realAmount: string;
  propId: string | number;
  payChannelId: string | number;
}

export class PlatformApi {
  constructor(
    private readonly client: PlatformClient,
    readonly queue: RequestQueue,
  ) {}

  private read<T>(
    label: string,
    opts: CallOptions,
    fn: () => Promise<CallResult<T>>,
  ): Promise<CallResult<T>> {
    return this.queue.runRead({ priority: opts.priority, group: opts.group, label }, fn);
  }

  private write<T>(label: string, opts: CallOptions, fn: () => Promise<CallResult<T>>) {
    return this.queue.run({ priority: opts.priority, group: opts.group, label }, fn);
  }

  async userInfo(opts: CallOptions): Promise<UserInfo> {
    const { data } = await this.read('user.info', opts, () =>
      this.client.post('/rent/user/info/get', {}, userInfoSchema, READ_TIMEOUT),
    );
    return {
      profileId: data.uuid,
      certified: flag(data.isCertify),
      banned: flag(data.isBan),
      maintenance: flag(data.isPlatformMaintenance),
    };
  }

  async authInfo(opts: CallOptions): Promise<{ agreementDone: boolean }> {
    const { data } = await this.read('user.auth_info', opts, () =>
      this.client.post('/rent/user/auth_info', {}, authInfoSchema, READ_TIMEOUT),
    );
    return { agreementDone: data.frontPageStatus === 1 && data.orderPageStatus === 1 };
  }

  async globalConfig(opts: CallOptions) {
    const { data } = await this.read('config.global', opts, () =>
      this.client.post('/rent/config/global', {}, globalConfigSchema, READ_TIMEOUT),
    );
    return data;
  }

  async search(
    params: { keyword: string; page: number; rentKind: RentKind; couponOnly: boolean },
    opts: CallOptions,
  ): Promise<{ total: number; accounts: AccountRecord[] }> {
    const body = {
      price: [],
      page: params.page,
      searchContent: params.keyword,
      size: PAGE_SIZE,
      sortType: '',
      sortField: '',
      rentType: RENT_META[params.rentKind].code,
      useCoupon: params.couponOnly ? 1 : -1,
    };
    const { data } = await this.read('account.search', opts, () =>
      this.client.post('/rent/account/search', body, searchDataSchema, READ_TIMEOUT),
    );
    return { total: data.total, accounts: data.list.map(normalizeAccount) };
  }

  async accountInfo(
    accountNo: string,
    opts: CallOptions,
  ): Promise<AccountRecord & { serverTimeMs: number | null }> {
    const { data, serverTimeMs } = await this.read('account.get_info', opts, () =>
      this.client.post('/rent/account/get_info', { accountNo }, rawAccountSchema, READ_TIMEOUT),
    );
    return { ...normalizeAccount(data), serverTimeMs };
  }

  async inventory(accountNo: string, opts: CallOptions): Promise<InventoryItem[]> {
    const { data } = await this.read('account.inventory', opts, () =>
      this.client.post(
        '/rent/account/inventory/display/info',
        { accountNo },
        inventoryDataSchema,
        READ_TIMEOUT,
      ),
    );
    return normalizeInventory(data.list);
  }

  async durations(accountNo: string, opts: CallOptions) {
    const { data } = await this.read('account.durations', opts, () =>
      this.client.post(
        '/rent/account/price/preset_duration/get_info',
        { accountNo },
        durationSchema,
        READ_TIMEOUT,
      ),
    );
    return data;
  }

  async favoritesPage(page: number, opts: CallOptions) {
    const body = { page, size: PAGE_SIZE, rentType: 0, isCanRent: 0, sortType: '', sortField: '' };
    const { data } = await this.read('favorites.list', opts, () =>
      this.client.post('/rent/account/favorites/list', body, favoritesDataSchema, READ_TIMEOUT),
    );
    return { total: data.total, accounts: data.list.map(normalizeAccount) };
  }

  /** 有副作用：设定平台收藏目标状态；不自动重试。 */
  async favoriteUpdate(accountNo: string, status: 0 | 1, opts: CallOptions): Promise<void> {
    await this.write('favorites.update', opts, () =>
      this.client.post(
        '/rent/account/favorites/update',
        { accountNo, status },
        lockDataSchema,
        READ_TIMEOUT,
      ),
    );
  }

  async coupons(
    opts: CallOptions,
  ): Promise<{ items: CouponRaw[]; complete: boolean; serverTimeMs: number | null }> {
    const { data, serverTimeMs } = await this.read('coupon.list', opts, () =>
      this.client.post('/rent/coupon/list', { statuses: ['1'] }, couponDataSchema, READ_TIMEOUT),
    );
    const items: CouponRaw[] = data.items.map((c) => ({
      id: c.id,
      couponType: c.couponType ?? -1,
      discountType: c.discountType ?? -1,
      discountValue: c.discountValue,
      thresholdAmount: c.thresholdAmount || '0',
      status: c.status ?? -1,
      validStartAtMs: timeToMs(c.validStartAt),
      validEndAtMs: timeToMs(c.validEndAt),
    }));
    const complete =
      data.nextPageToken === '' &&
      Number.isFinite(data.totalSize) &&
      data.totalSize <= items.length;
    return { items, complete, serverTimeMs };
  }

  async payChannels(opts: CallOptions): Promise<{ payChannel: 1 | 2; payChannelId: string }[]> {
    const { data } = await this.read('pay.channels', opts, () =>
      this.client.post('/rent/order/pay/channel/list', {}, channelDataSchema, READ_TIMEOUT),
    );
    return data.items
      .map((c) => ({ payChannel: Number(c.payChannel), payChannelId: c.payChannelId }))
      .filter(
        (c): c is { payChannel: 1 | 2; payChannelId: string } =>
          (c.payChannel === 1 || c.payChannel === 2) && c.payChannelId !== '',
      );
  }

  /** 可能获取锁的预检：只在手动出码后调用，不重试。 */
  async checkLock(accountNo: string): Promise<void> {
    await this.write('order.check_lock', { priority: Priority.CHECKOUT }, () =>
      this.client.post(
        '/rent/order/check_account_lock',
        { accountNo },
        lockDataSchema,
        READ_TIMEOUT,
      ),
    );
  }

  /** 创建订单：20 秒超时，绝不自动重发。 */
  async createOrder(body: CreateOrderBody) {
    const { data, serverTimeMs } = await this.write(
      'order.create',
      { priority: Priority.CHECKOUT },
      () => this.client.post('/rent/order/create', body, createDataSchema, CREATE_TIMEOUT),
    );
    return { ...data, serverTimeMs };
  }

  async payStatus(paymentOrderId: string) {
    const { data, serverTimeMs } = await this.read(
      'order.get_status',
      { priority: Priority.ORDER_RECOVERY },
      () =>
        this.client.post(
          '/rent/order/get_status',
          { orderId: paymentOrderId },
          payStatusSchema,
          READ_TIMEOUT,
        ),
    );
    return { ...data, serverTimeMs };
  }

  /** 申请释放账户锁：10 秒超时，不自动重复发送。成功仅代表受理。 */
  async unlock(accountNo: string): Promise<void> {
    await this.write('order.unlock', { priority: Priority.ORDER_RECOVERY }, () =>
      this.client.post('/rent/order/unlock_account', { accountNo }, lockDataSchema, UNLOCK_TIMEOUT),
    );
  }

  async orderList(page: number, opts: CallOptions) {
    const { data } = await this.read('order.list', opts, () =>
      this.client.post(
        '/rent/order/list',
        { page, pageSize: ORDER_PAGE_SIZE },
        orderListSchema,
        READ_TIMEOUT,
      ),
    );
    return data;
  }

  async orderDetails(rentalOrderNo: string, opts: CallOptions) {
    const { data } = await this.read('order.details', opts, () =>
      this.client.post(
        '/rent/order/details',
        { orderNo: rentalOrderNo },
        orderDetailsSchema,
        READ_TIMEOUT,
      ),
    );
    return data;
  }
}
