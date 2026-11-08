// 虚拟平台：实现与官方接口相同的信封和字段形状，只含虚拟账号与虚拟数据。
// 用于离线测试、离线预览与浏览器交互验收；不连接任何真实平台，也不读取真实登录态。
import type { HttpTransport, TransportResponse } from '../platform/client';

export interface FakeItem {
  marketName: string;
  firstType: string;
  price: string;
  rarity: number;
  rarityName: string;
  nameColor: string;
  exteriorName: string;
  wear: string;
}

export interface FakeAccount {
  accountNo: string;
  tags: string[];
  value: string;
  prices: {
    hour: string;
    day: string;
    week: string;
    morning: string;
    noon: string;
    evening: string;
  };
  firstPrices?: { hour?: string; day?: string; week?: string };
  rentType: number[];
  rentPeriod: number;
  weekRange: { morning: number[]; noon: number[]; evening: number[] };
  shelfStatus: number;
  rentStatus: number;
  expireTime: string;
  useCoupon: number;
  platformCouponConfig: number;
  inventory: FakeItem[];
  durations: { hour: number[]; day: number[]; week: number[] };
}

export interface FakeCoupon {
  id: string;
  couponType: number;
  discountType: number;
  discountValue: string;
  thresholdAmount: number;
  status: number;
  validStartAt: string;
  validEndAt: string;
}

export interface FakeOrder {
  orderId: string;
  accountNo: string;
  realAmount: string;
  buyTimeType: number;
  buyCount: number;
  payStatus: number;
  abnormalReason: number;
  createdAt: number;
  deadline: number;
}

type Failure =
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; retryAfter?: string }
  | { kind: 'business'; code: number; message: string }
  | { kind: 'schema' }
  | { kind: 'lost-after-apply' };

const ITEM_POOL: FakeItem[] = [
  item(
    '蝴蝶刀（★） | 多普勒 (崭新出厂)',
    '匕首',
    '12000.00',
    6,
    '隐秘',
    'eb4b4b',
    '崭新出厂',
    '0.012',
  ),
  item(
    '蝴蝶刀（★） | 渐变大理石 (崭新出厂)',
    '匕首',
    '9800.00',
    6,
    '隐秘',
    'eb4b4b',
    '崭新出厂',
    '0.031',
  ),
  item(
    '爪子刀（★） | 多普勒 (崭新出厂)',
    '匕首',
    '15800.00',
    6,
    '隐秘',
    'eb4b4b',
    '崭新出厂',
    '0.009',
  ),
  item(
    '爪子刀（★） | 虎牙 (崭新出厂)',
    '匕首',
    '11200.00',
    6,
    '隐秘',
    'eb4b4b',
    '崭新出厂',
    '0.021',
  ),
  item(
    'M9 刺刀（★） | 多普勒 (崭新出厂)',
    '匕首',
    '8800.00',
    6,
    '隐秘',
    'eb4b4b',
    '崭新出厂',
    '0.015',
  ),
  item(
    '刺刀（★） | 渐变之色 (崭新出厂)',
    '匕首',
    '4100.00',
    6,
    '隐秘',
    'eb4b4b',
    '崭新出厂',
    '0.018',
  ),
  item(
    '弯刀（★） | 森林 DDPAT (久经沙场)',
    '匕首',
    '520.00',
    6,
    '隐秘',
    'eb4b4b',
    '久经沙场',
    '0.311',
  ),
  item(
    '穿肠刀（★） | 狩猎网格 (略有磨损)',
    '匕首',
    '610.00',
    6,
    '隐秘',
    'eb4b4b',
    '略有磨损',
    '0.132',
  ),
  item(
    '运动手套（★） | 潘多拉之盒 (略有磨损)',
    '手套',
    '30500.00',
    6,
    '非凡',
    'eb4b4b',
    '略有磨损',
    '0.087',
  ),
  item(
    '裹手（★） | 森林色调 (久经沙场)',
    '手套',
    '780.00',
    6,
    '非凡',
    'eb4b4b',
    '久经沙场',
    '0.368',
  ),
  item(
    '专业手套（★） | 渐变大理石 (略有磨损)',
    '手套',
    '6200.00',
    6,
    '非凡',
    'eb4b4b',
    '略有磨损',
    '0.101',
  ),
  item('AK-47 | 火神 (略有磨损)', '步枪', '2100.00', 5, '隐秘', 'eb4b4b', '略有磨损', '0.110'),
  item('AWP | 二西莫夫 (久经沙场)', '步枪', '680.00', 5, '隐秘', 'eb4b4b', '久经沙场', '0.290'),
  item('M4A4 | 龙王 (崭新出厂)', '步枪', '1500.00', 4, '保密', 'd32ce6', '崭新出厂', '0.040'),
  item(
    'FN57（StatTrak™） | 暴怒野兽 (破损不堪)',
    '手枪',
    '60.00',
    4,
    '保密',
    'd32ce6',
    '破损不堪',
    '0.399',
  ),
  item('USP 消音版 | 皇后 (崭新出厂)', '手枪', '95.00', 4, '保密', 'd32ce6', '崭新出厂', '0.051'),
  item(
    'MAC-10 | 赤金锁链 (崭新出厂)',
    '微型冲锋枪',
    '12.00',
    3,
    '受限',
    '8847ff',
    '崭新出厂',
    '0.061',
  ),
  item(
    'P90 | 异星世界 (略有磨损)',
    '微型冲锋枪',
    '8.00',
    1,
    '军规级',
    '4b69ff',
    '略有磨损',
    '0.120',
  ),
];

function item(
  marketName: string,
  firstType: string,
  price: string,
  rarity: number,
  rarityName: string,
  nameColor: string,
  exteriorName: string,
  wear: string,
): FakeItem {
  return { marketName, firstType, price, rarity, rarityName, nameColor, exteriorName, wear };
}

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 生成可复现的虚拟账号集合。 */
export function generateAccounts(count = 48, seed = 7): FakeAccount[] {
  const rand = seeded(seed);
  const out: FakeAccount[] = [];
  for (let i = 0; i < count; i++) {
    const n = 3 + Math.floor(rand() * 8);
    const inventory: FakeItem[] = [];
    for (let j = 0; j < n; j++) {
      const pick = ITEM_POOL[Math.floor(rand() * ITEM_POOL.length)] as FakeItem;
      inventory.push({ ...pick });
    }
    const hour = (2 + Math.floor(rand() * 18) + (rand() > 0.5 ? 0.5 : 0)).toFixed(2);
    const value = inventory.reduce((sum, it) => sum + Number(it.price), 0).toFixed(2);
    const slots = rand() > 0.5;
    out.push({
      accountNo: `CS${String(1000000000 + i * 7919).padStart(10, '0')}`,
      tags: [['30w崭新', '原版爪子', '多普勒蝴蝶', '全皮肤', '高价手套', '新号'][i % 6] as string],
      value,
      prices: {
        hour,
        day: (Number(hour) * 10).toFixed(2),
        week: rand() > 0.4 ? (Number(hour) * 50).toFixed(2) : '0',
        morning: slots ? (Number(hour) * 2).toFixed(2) : '0',
        noon: slots ? (Number(hour) * 2).toFixed(2) : '0',
        evening: slots ? (Number(hour) * 3).toFixed(2) : '0',
      },
      firstPrices: i % 5 === 0 ? { hour: (Number(hour) * 0.5).toFixed(2) } : undefined,
      rentType: slots ? [1, 2, 3, 4, 5, 6] : [1, 2, 3],
      rentPeriod: 1 + Math.floor(rand() * 2),
      weekRange: { morning: [1, 2, 3, 4, 5], noon: [1, 2, 3, 4, 5, 6, 7], evening: [5, 6, 7] },
      shelfStatus: i % 13 === 12 ? 2 : 1,
      rentStatus: i % 4 === 3 ? 1 : 0,
      expireTime: String(Math.floor(Date.now() / 1000) + 3600 * (1 + (i % 5))),
      useCoupon: i % 3 === 0 ? 0 : 1,
      platformCouponConfig: 1,
      inventory,
      durations: { hour: [1, 2, 3, 4, 5, 6, 8, 10, 12], day: [1, 2, 3, 5, 7], week: [1, 2] },
    });
  }
  return out;
}

function ok(data: unknown, nowMs: number): unknown {
  return {
    status: true,
    code: 0,
    message: '',
    data,
    timestamp: Math.floor(nowMs / 1000),
    traceId: '0'.repeat(32),
    success: true,
    errcode: 0,
  };
}

function fail(code: number, message: string, nowMs: number): unknown {
  return {
    status: false,
    code,
    message,
    data: null,
    timestamp: Math.floor(nowMs / 1000),
    traceId: '0'.repeat(32),
    success: false,
    errcode: code,
  };
}

function rawItem(it: FakeItem, owner: string, index: number) {
  const id = `${owner.slice(2)}${String(index).padStart(3, '0')}`;
  const slug = encodeURIComponent(it.marketName.split('|')[0]?.trim() ?? 'item');
  return {
    id,
    steam64Id: '0',
    assetid: `9${id}`,
    marketName: it.marketName,
    marketHashName: it.marketName,
    name: it.marketName,
    nameColor: it.nameColor,
    steamImgUrl: `https://steamcommunity-a.akamaihd.net/economy/image/fake-${slug}`,
    ossImgUrl: `https://oss.5eplay.com/fake/${slug}.png`,
    rarity: it.rarity,
    rarityName: it.rarityName,
    exterior: 1,
    exteriorName: it.exteriorName,
    hasStattrak: -1,
    tag: '0',
    price: it.price,
    wear: it.wear,
    quality: 3,
    qualityName: '普通',
    style: '',
    firstType: it.firstType,
    secondType: 'weapon_fake',
    tradable: 0,
    stickers: {
      paintseed: 0,
      paintindex: 0,
      stickerInfo: [],
      keychainInfo: [],
      patchInfo: [],
      showStyle: '',
    },
  };
}

export class FakePlatform implements HttpTransport {
  accounts: FakeAccount[];
  favorites: string[] = [];
  coupons: FakeCoupon[] = [];
  couponsIncomplete = false;
  channels = [{ payChannel: 1, payChannelId: 4 }];
  orders = new Map<string, FakeOrder>();
  createCount = 0;
  unlockCount = 0;
  lockChecks = 0;
  favoriteWrites: { accountNo: string; status: number }[] = [];
  user = { uuid: 'fake-user-1', isCertify: 1, isBan: 0, isPlatformMaintenance: 0 };
  agreement = { frontPageStatus: 1, orderPageStatus: 1 };
  requests: { path: string; body: unknown; at: number; authorization: string | null }[] = [];
  private failures = new Map<string, Failure[]>();
  private orderSeq = 1;
  latencyMs = 0;
  validToken = 'fake-credential';
  now: () => number = Date.now;
  orderRemainSeconds = 181;
  /**
   * A8 契约回放模式：启用后按真实平台实测规则回放关键词差异
   * （如「格洛克」「加利尔」「M9 刺刀」「M4A1消音版」返回 0，「加利尔AR」不匹配带空格的「加利尔 AR」等）。
   */
  contractReplayMode = false;
  payImage =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+/b9sAAAAASUVORK5CYII=';

  constructor(accounts?: FakeAccount[]) {
    this.accounts = accounts ?? generateAccounts();
  }

  /** 为某个路径排入一次性故障（按顺序消费）。 */
  failNext(path: string, failure: Failure, times = 1) {
    const list = this.failures.get(path) ?? [];
    for (let i = 0; i < times; i++) list.push(failure);
    this.failures.set(path, list);
  }

  clearFailures() {
    this.failures.clear();
  }

  account(no: string) {
    return this.accounts.find((a) => a.accountNo === no);
  }

  setStatus(no: string, rentStatus: number, shelfStatus = 1) {
    const acc = this.account(no);
    if (acc) {
      acc.rentStatus = rentStatus;
      acc.shelfStatus = shelfStatus;
    }
  }

  pay(orderId?: string) {
    const order = orderId ? this.orders.get(orderId) : [...this.orders.values()].at(-1);
    if (order) {
      order.payStatus = 1;
      order.abnormalReason = 0;
      this.setStatus(order.accountNo, 1);
    }
    return order ?? null;
  }

  expire(orderId?: string) {
    const order = orderId ? this.orders.get(orderId) : [...this.orders.values()].at(-1);
    if (order && order.payStatus === 0) order.abnormalReason = 5;
    return order ?? null;
  }

  count(path: string) {
    return this.requests.filter((r) => r.path === path).length;
  }

  private accountJson(acc: FakeAccount, detail: boolean) {
    const base = {
      accountNo: acc.accountNo,
      value: acc.value,
      tags: acc.tags,
      hourPrice: acc.prices.hour,
      dayPrice: acc.prices.day,
      weekPrice: acc.prices.week,
      hourFirstPrice: acc.firstPrices?.hour ?? '',
      dayFirstPrice: acc.firstPrices?.day ?? '',
      weekFirstPrice: acc.firstPrices?.week ?? '',
      hourActPrice: '',
      dayActPrice: '',
      weekActPrice: '',
      priceTypeDisplay: [],
      rentType: acc.rentType,
      rentPeriod: acc.rentPeriod,
      weekRangeMorning: acc.weekRange.morning,
      weekRangeNoon: acc.weekRange.noon,
      weekRangeEvening: acc.weekRange.evening,
      useCoupon: acc.useCoupon,
      firstDisplay: 0,
    };
    const display = acc.inventory.slice(0, 5).map((it, i) => rawItem(it, acc.accountNo, i));
    if (!detail) return { ...base, displayInventory: display };
    return {
      ...base,
      vestAccountName: '虚拟账号',
      vestAccountImage: '',
      availableValue: acc.value,
      shelfStatus: acc.shelfStatus,
      rentStatus: acc.rentStatus,
      expireTime: acc.expireTime,
      isFirst: 0,
      steam64Id: '0',
      isSelf: false,
      morningPrice: acc.prices.morning,
      noonPrice: acc.prices.noon,
      eveningPrice: acc.prices.evening,
      isFavorited: this.favorites.includes(acc.accountNo),
      authStatus: 0,
      platformCouponConfig: acc.platformCouponConfig,
    };
  }

  private paged<T>(list: T[], page: number, size: number) {
    return list.slice((page - 1) * size, page * size);
  }

  async post(
    url: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<TransportResponse> {
    const path = new URL(url).pathname.replace(/^\/rentinterface\/http\/v1/, '');
    const payload = JSON.parse(body) as Record<string, unknown>;
    const now = this.now();
    this.requests.push({
      path,
      body: payload,
      at: now,
      authorization: headers.Authorization ?? null,
    });
    if (this.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.latencyMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    }
    const queue = this.failures.get(path);
    const failure = queue?.shift();
    if (failure) {
      if (failure.kind === 'network') throw new Error('net::ERR_CONNECTION_RESET');
      if (failure.kind === 'timeout') {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (failure.kind === 'http') return respond(failure.status, '{}', failure.retryAfter);
      if (failure.kind === 'business')
        return respond(200, JSON.stringify(fail(failure.code, failure.message, now)));
      if (failure.kind === 'schema')
        return respond(200, JSON.stringify(ok({ unexpected: true }, now)));
    }
    if (headers.Authorization !== this.validToken)
      return respond(200, JSON.stringify(fail(401, '未登录', now)));
    const result = this.route(path, payload, now);
    if (failure?.kind === 'lost-after-apply') throw new Error('net::ERR_CONNECTION_CLOSED');
    return respond(200, JSON.stringify(result));
  }

  private route(path: string, p: Record<string, unknown>, now: number): unknown {
    const accountNo = String(p.accountNo ?? '');
    const acc = this.account(accountNo);
    switch (path) {
      case '/rent/user/info/get':
        return ok(this.user, now);
      case '/rent/user/auth_info':
        return ok({ id: '1', ...this.agreement }, now);
      case '/rent/config/global':
        return ok({ rentType: [1, 2, 3, 4, 5, 6], hourlyRental: 1 }, now);
      case '/rent/account/search': {
        const keyword = String(p.searchContent ?? '');
        const rentType = Number(p.rentType);
        if (this.contractReplayMode && CONTRACT_ZERO_KEYWORDS.has(keyword)) {
          return ok({ total: '0', isFirst: 0, list: [] }, now);
        }
        const matches = this.accounts.filter(
          (a) =>
            a.shelfStatus === 1 &&
            a.rentType.includes(rentType) &&
            (Number(p.useCoupon) !== 1 || a.useCoupon === 1) &&
            (!keyword ||
              a.inventory.some((it) =>
                matchesFakeSearchKeyword(it, keyword, this.contractReplayMode),
              )),
        );
        const page = this.paged(matches, Number(p.page), Number(p.size));
        return ok(
          {
            total: String(matches.length),
            isFirst: 0,
            list: page.map((a) => this.accountJson(a, false)),
          },
          now,
        );
      }
      case '/rent/account/get_info':
        return acc ? ok(this.accountJson(acc, true), now) : fail(400, '账号不存在', now);
      case '/rent/account/inventory/display/info':
        return acc
          ? ok({ list: acc.inventory.map((it, i) => rawItem(it, acc.accountNo, i)) }, now)
          : fail(400, '账号不存在', now);
      case '/rent/account/price/preset_duration/get_info':
        return acc
          ? ok(
              {
                accountNo,
                hourDuration: acc.durations.hour,
                dayDuration: acc.durations.day,
                weekDuration: acc.durations.week,
                hourDurationRenewal: acc.durations.hour,
              },
              now,
            )
          : fail(400, '账号不存在', now);
      case '/rent/account/favorites/list': {
        const list = this.favorites
          .map((no) => this.account(no))
          .filter((a): a is FakeAccount => !!a);
        const page = this.paged(list, Number(p.page), Number(p.size));
        return ok(
          {
            total: String(list.length),
            list: page.map((a) => ({
              ...this.accountJson(a, false),
              isFavorited: true,
              expireTime: a.expireTime,
              shelfStatus: a.shelfStatus,
              rentStatus: a.rentStatus,
            })),
          },
          now,
        );
      }
      case '/rent/account/favorites/update': {
        const status = Number(p.status);
        this.favoriteWrites.push({ accountNo, status });
        if (status === 1 && !this.favorites.includes(accountNo)) this.favorites.push(accountNo);
        if (status === 0) this.favorites = this.favorites.filter((x) => x !== accountNo);
        return ok({}, now);
      }
      case '/rent/coupon/list':
        return ok(
          {
            totalSize: this.couponsIncomplete ? this.coupons.length + 5 : this.coupons.length,
            nextPageToken: this.couponsIncomplete ? 'next' : '',
            items: this.coupons,
            availableCount: this.coupons.length,
          },
          now,
        );
      case '/rent/order/pay/channel/list':
        return ok({ items: this.channels }, now);
      case '/rent/order/check_account_lock':
        this.lockChecks++;
        if (acc?.rentStatus !== 0 || acc?.shelfStatus !== 1)
          return fail(400, '账号已被他人锁定', now);
        return ok({}, now);
      case '/rent/order/create': {
        this.createCount++;
        if (!acc) return fail(400, '账号不存在', now);
        const orderId = `9${String(this.orderSeq++).padStart(17, '0')}`;
        const deadline = Math.floor(now / 1000) + this.orderRemainSeconds;
        this.orders.set(orderId, {
          orderId,
          accountNo,
          realAmount: String(p.realAmount),
          buyTimeType: Number(p.buyTimeType),
          buyCount: Number(p.buyCount),
          payStatus: 0,
          abnormalReason: 0,
          createdAt: now,
          deadline: deadline * 1000,
        });
        return ok(
          {
            orderId,
            channelType: 0,
            codeUrl: this.payImage,
            orderDateline: String(deadline),
            orderRemainSeconds: this.orderRemainSeconds,
          },
          now,
        );
      }
      case '/rent/order/get_status': {
        const order = this.orders.get(String(p.orderId));
        if (!order) return fail(400, '订单不存在', now);
        return ok({ payStatus: order.payStatus, abnormalReason: order.abnormalReason }, now);
      }
      case '/rent/order/unlock_account':
        this.unlockCount++;
        return ok({}, now);
      case '/rent/order/list':
        return ok({ totalSize: 0, nextPageToken: '', items: [] }, now);
      default:
        return fail(404, '未实现', now);
    }
  }
}

/** A8 真实平台只读实测确认返回 0 的关键词（详见 docs/验证记录.md 与 .validation/probes/probe-102-result.json）。 */
export const CONTRACT_ZERO_KEYWORDS = new Set([
  '格洛克',
  '格洛克 18 型',
  '加利尔',
  '加利尔 AR',
  'M9 刺刀',
  'CZ75自动手枪',
  'CZ75 自动手枪',
  'M4A1消音版',
  'M4A1 消音版',
  '匕首',
  '步枪',
  '手枪',
  '微型冲锋枪',
  '霰弹枪',
  '机枪',
  '探员',
]);

function matchesFakeSearchKeyword(
  item: FakeItem,
  keyword: string,
  contractReplayMode: boolean,
): boolean {
  if (contractReplayMode) {
    if (CONTRACT_ZERO_KEYWORDS.has(keyword)) return false;
    // 实测：加利尔AR 在真实平台只命中无空格的「加利尔AR」，对带空格的「加利尔 AR」漏召回
    if (keyword === '加利尔AR') {
      return item.marketName.includes('加利尔AR');
    }
    // 实测：格洛克18型 同样只命中无空格命名，对「格洛克 18 型」漏召回（coverage=partial）
    if (keyword === '格洛克18型') {
      return item.marketName.includes('格洛克18型');
    }
  }
  if (item.marketName.includes(keyword)) return true;
  const compactName = item.marketName.replace(/\s+/g, '');
  const compactKeyword = keyword.replace(/\s+/g, '');
  return compactKeyword.length > 0 && compactName.includes(compactKeyword);
}

function respond(status: number, text: string, retryAfter?: string): TransportResponse {
  return {
    status,
    header: (name) => (name.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null),
    text: async () => text,
  };
}
