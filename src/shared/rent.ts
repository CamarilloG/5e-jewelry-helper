// 六种租期的固定映射、开放判定、数量选项与包时段规则（接口与数据规范 §4）。
import Decimal from 'decimal.js';

export const RENT_KINDS = ['HOUR', 'DAY', 'WEEK', 'EARLY', 'NOON', 'NIGHT'] as const;
export type RentKind = (typeof RENT_KINDS)[number];
export type RentCode = 1 | 2 | 3 | 4 | 5 | 6;

export interface RentMeta {
  kind: RentKind;
  code: RentCode;
  label: string;
  unit: string;
  priceField:
    | 'hourPrice'
    | 'dayPrice'
    | 'weekPrice'
    | 'morningPrice'
    | 'noonPrice'
    | 'eveningPrice';
  firstPriceField?: 'hourFirstPrice' | 'dayFirstPrice' | 'weekFirstPrice';
  actPriceField?: 'hourActPrice' | 'dayActPrice' | 'weekActPrice';
  slot: boolean;
}

export const RENT_META: Record<RentKind, RentMeta> = {
  HOUR: {
    kind: 'HOUR',
    code: 1,
    label: '小时租',
    unit: '时',
    priceField: 'hourPrice',
    firstPriceField: 'hourFirstPrice',
    actPriceField: 'hourActPrice',
    slot: false,
  },
  DAY: {
    kind: 'DAY',
    code: 2,
    label: '天租',
    unit: '天',
    priceField: 'dayPrice',
    firstPriceField: 'dayFirstPrice',
    actPriceField: 'dayActPrice',
    slot: false,
  },
  WEEK: {
    kind: 'WEEK',
    code: 3,
    label: '周租',
    unit: '周',
    priceField: 'weekPrice',
    firstPriceField: 'weekFirstPrice',
    actPriceField: 'weekActPrice',
    slot: false,
  },
  EARLY: {
    kind: 'EARLY',
    code: 4,
    label: '包早',
    unit: '次',
    priceField: 'morningPrice',
    slot: true,
  },
  NOON: { kind: 'NOON', code: 5, label: '包午', unit: '次', priceField: 'noonPrice', slot: true },
  NIGHT: {
    kind: 'NIGHT',
    code: 6,
    label: '包夜',
    unit: '次',
    priceField: 'eveningPrice',
    slot: true,
  },
};

export function rentKindFromCode(code: number): RentKind | null {
  return RENT_KINDS.find((kind) => RENT_META[kind].code === code) ?? null;
}

/** 账号价格信息中与租期判定有关的部分（已归一化为字符串金额）。 */
export interface RentPricing {
  rentType: number[];
  prices: Partial<Record<RentKind, string>>;
  firstPrices: Partial<Record<RentKind, string>>;
  actPrices: Partial<Record<RentKind, string>>;
  rentPeriod: number | null;
  weekRange: { EARLY: number[]; NOON: number[]; NIGHT: number[] };
}

export function isPositiveAmount(value: string | undefined | null): boolean {
  if (value == null || value === '') return false;
  try {
    return new Decimal(value).gt(0);
  } catch {
    return false;
  }
}

/** 账号支持一档租期：rentType 包含编号且原价大于零。 */
export function supportsRent(pricing: RentPricing, kind: RentKind): boolean {
  return pricing.rentType.includes(RENT_META[kind].code) && isPositiveAmount(pricing.prices[kind]);
}

export function supportedRents(pricing: RentPricing): RentKind[] {
  return RENT_KINDS.filter((kind) => supportsRent(pricing, kind));
}

export interface DurationOptions {
  hourDuration: number[];
  dayDuration: number[];
  weekDuration: number[];
}

/** 合法数量：时长租取平台列表中的正整数（小时租不少于起租小时数），时段租固定 1 次。 */
export function quantityOptions(
  kind: RentKind,
  durations: DurationOptions | null,
  rentPeriod: number | null,
): number[] {
  if (RENT_META[kind].slot) return [1];
  if (!durations) return [];
  const list =
    kind === 'HOUR'
      ? durations.hourDuration
      : kind === 'DAY'
        ? durations.dayDuration
        : durations.weekDuration;
  const valid = list.filter((value) => Number.isInteger(value) && value > 0);
  const filtered =
    kind === 'HOUR' && rentPeriod != null && rentPeriod > 0
      ? valid.filter((value) => value >= rentPeriod)
      : valid;
  return [...new Set(filtered)].sort((a, b) => a - b);
}

/** 版本化的包时段规则；分钟为北京时间当天分钟数，左闭右开。 */
export const SLOT_RULES_VERSION = '2026-11-07';
export const SLOT_WINDOWS: Record<
  'EARLY' | 'NOON' | 'NIGHT',
  { order: [number, number]; use: string }
> = {
  EARLY: { order: [7 * 60, 9 * 60], use: '当天 07:00–12:00，实际从下单成功起' },
  NOON: { order: [9 * 60, 10 * 60 + 30], use: '当天 09:00–14:00，实际从下单成功起' },
  NIGHT: { order: [0, 2 * 60], use: '当天 00:00–07:00，实际从下单成功起' },
};

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 北京时间（固定 UTC+8，无夏令时）的分钟数与星期（1=周一…7=周日）。 */
export function shanghaiClock(utcMs: number): { minute: number; weekday: number } {
  const shifted = new Date(utcMs + SHANGHAI_OFFSET_MS);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const day = shifted.getUTCDay();
  return { minute, weekday: day === 0 ? 7 : day };
}

export function slotOrderable(
  kind: RentKind,
  utcMs: number,
  weekRange: RentPricing['weekRange'],
): boolean {
  if (kind !== 'EARLY' && kind !== 'NOON' && kind !== 'NIGHT') return true;
  const window = SLOT_WINDOWS[kind].order;
  const { minute, weekday } = shanghaiClock(utcMs);
  return weekRange[kind].includes(weekday) && minute >= window[0] && minute < window[1];
}

export function formatSlotWindow(kind: 'EARLY' | 'NOON' | 'NIGHT'): string {
  const [start, end] = SLOT_WINDOWS[kind].order;
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `北京时间 ${fmt(start)}–${fmt(end)} 可下单`;
}

export const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function formatWeekdays(days: number[]): string {
  const sorted = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (sorted.length === 7) return '每天';
  if (sorted.length === 0) return '无可用星期';
  return sorted.map((d) => WEEKDAY_LABELS[d]).join('、');
}
