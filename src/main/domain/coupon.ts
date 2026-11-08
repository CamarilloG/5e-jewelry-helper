// 优惠券适用判定、券后金额与最优券选择（接口与数据规范 §5）。
// 平台券接口的 discountValue / thresholdAmount 为分，先按平台前端规则换算为元（向下两位）再套用公式。
import Decimal from 'decimal.js';
import { fenFieldToYuan, originalFen, originalYuan } from '../../shared/money';
import { RENT_META, type RentKind } from '../../shared/rent';

export interface CouponInput {
  id: string;
  couponType: number;
  discountType: number;
  /** 平台原值（分）。 */
  discountValue: string;
  /** 平台原值（分）。 */
  thresholdAmount: string;
  status: number;
  validStartAtMs: number | null;
  validEndAtMs: number | null;
}

export const COUPON_RENT_CODES: Record<number, number[]> = {
  1: [1, 2, 3, 4, 5, 6],
  2: [4, 5, 6],
  3: [4],
  4: [5],
  5: [6],
  6: [1, 2, 3],
  7: [1],
  8: [2],
  9: [3],
};

export class CouponListIncompleteError extends Error {
  constructor() {
    super('COUPON_LIST_INCOMPLETE');
    this.name = 'CouponListIncompleteError';
  }
}

/** 单张券的券后金额（分）；不适用时返回 null。 */
export function couponAmountFen(
  coupon: CouponInput,
  unitYuan: string,
  count: number,
  kind: RentKind,
  nowMs: number,
): Decimal | null {
  if (coupon.status !== 1) return null;
  if (coupon.validStartAtMs == null || coupon.validEndAtMs == null) return null;
  if (nowMs < coupon.validStartAtMs || nowMs > coupon.validEndAtMs) return null;
  if (!COUPON_RENT_CODES[coupon.couponType]?.includes(RENT_META[kind].code)) return null;
  const yuan = originalYuan(unitYuan, count);
  const fen = originalFen(unitYuan, count);
  let value: Decimal;
  let threshold: Decimal;
  try {
    value = fenFieldToYuan(coupon.discountValue);
    threshold = fenFieldToYuan(coupon.thresholdAmount || '0');
  } catch {
    return null;
  }
  let amount: Decimal;
  switch (coupon.discountType) {
    case 1:
      amount = fen.mul(value);
      break;
    case 2:
      if (value.gt(yuan)) return null;
      amount = fen.sub(value.mul(100));
      break;
    case 3:
      if (yuan.lt(threshold)) return null;
      amount = fen.sub(value.mul(100));
      break;
    case 4:
      amount = new Decimal(0);
      break;
    default:
      return null;
  }
  return Decimal.max(amount, 0);
}

export interface CouponChoiceInput {
  unitYuan: string;
  count: number;
  kind: RentKind;
  nowMs: number;
  autoCoupon: boolean;
  /** platformCouponConfig !== 0 && useCoupon !== 0 */
  accountAllows: boolean;
  /** nextPageToken 为空且 totalSize 不大于已取得条数 */
  complete: boolean;
  coupons: CouponInput[];
}

export interface CouponChoice {
  propId: string;
  couponId: string | null;
  originalFen: string;
  amountFen: string;
  discountFen: string;
}

export function chooseCoupon(input: CouponChoiceInput): CouponChoice {
  const base = originalFen(input.unitYuan, input.count);
  const none: CouponChoice = {
    propId: '0',
    couponId: null,
    originalFen: base.toString(),
    amountFen: base.toString(),
    discountFen: '0',
  };
  if (!input.autoCoupon || !input.accountAllows) return none;
  if (!input.complete) throw new CouponListIncompleteError();
  const candidates = input.coupons
    .map((coupon) => ({
      coupon,
      amount: couponAmountFen(coupon, input.unitYuan, input.count, input.kind, input.nowMs),
      threshold: safeDecimal(coupon.thresholdAmount),
    }))
    .filter(
      (c): c is { coupon: CouponInput; amount: Decimal; threshold: Decimal } => c.amount != null,
    );
  if (candidates.length === 0) return none;
  candidates.sort(
    (a, b) =>
      a.amount.cmp(b.amount) ||
      b.threshold.cmp(a.threshold) ||
      (a.coupon.validEndAtMs ?? 0) - (b.coupon.validEndAtMs ?? 0) ||
      (a.coupon.id < b.coupon.id ? -1 : a.coupon.id > b.coupon.id ? 1 : 0),
  );
  const best = candidates[0];
  if (!best) return none;
  return {
    propId: best.coupon.id,
    couponId: best.coupon.id,
    originalFen: base.toString(),
    amountFen: best.amount.toString(),
    discountFen: base.sub(best.amount).toString(),
  };
}

function safeDecimal(value: string): Decimal {
  try {
    return new Decimal(value || '0');
  } catch {
    return new Decimal(0);
  }
}
