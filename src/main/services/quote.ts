// 报价计算：原价 × 数量（元，两位）→ 分 → 优惠券；创建请求 realAmount 为分的十进制字符串（接口与数据规范 §5）。
import Decimal from 'decimal.js';
import type { QuoteView } from '../../shared/dto';
import { fenToDisplayYuan } from '../../shared/money';
import { quantityOptions, type RentKind, supportsRent } from '../../shared/rent';
import { type CouponChoice, CouponListIncompleteError, chooseCoupon } from '../domain/coupon';
import type { CouponRaw } from '../platform/api';
import type { AccountRecord } from '../platform/schemas';

export interface QuoteInput {
  record: AccountRecord;
  durations: { hourDuration: number[]; dayDuration: number[]; weekDuration: number[] } | null;
  rentKind: RentKind;
  quantity: number;
  autoCoupon: boolean;
  coupons: { items: CouponRaw[]; complete: boolean } | null;
  nowMs: number;
}

export type QuoteResult =
  | { ok: true; unitYuan: string; choice: CouponChoice; options: number[] }
  | {
      ok: false;
      code: 'RENT_UNSUPPORTED' | 'QUANTITY_INVALID' | 'COUPON_INCOMPLETE';
      options: number[];
    };

export function computeQuote(input: QuoteInput): QuoteResult {
  const options = quantityOptions(input.rentKind, input.durations, input.record.pricing.rentPeriod);
  if (!supportsRent(input.record.pricing, input.rentKind))
    return { ok: false, code: 'RENT_UNSUPPORTED', options };
  if (!options.includes(input.quantity)) return { ok: false, code: 'QUANTITY_INVALID', options };
  const unitYuan = input.record.pricing.prices[input.rentKind] as string;
  try {
    const choice = chooseCoupon({
      unitYuan,
      count: input.quantity,
      kind: input.rentKind,
      nowMs: input.nowMs,
      autoCoupon: input.autoCoupon,
      accountAllows: input.record.couponAllowed,
      complete: input.coupons?.complete ?? false,
      coupons: input.coupons?.items ?? [],
    });
    return { ok: true, unitYuan, choice, options };
  } catch (error) {
    if (error instanceof CouponListIncompleteError)
      return { ok: false, code: 'COUPON_INCOMPLETE', options };
    throw error;
  }
}

export const QUOTE_ERROR_TEXT: Record<
  'RENT_UNSUPPORTED' | 'QUANTITY_INVALID' | 'COUPON_INCOMPLETE',
  string
> = {
  RENT_UNSUPPORTED: '该账号当前不支持所选租期',
  QUANTITY_INVALID: '超出可下单范围，请调整时长',
  COUPON_INCOMPLETE: '优惠券列表不完整，已暂停自动用券出码；请关闭自动用券后重试',
};

export function quoteView(input: QuoteInput, result: QuoteResult): QuoteView {
  if (!result.ok) {
    return {
      rentKind: input.rentKind,
      quantity: input.quantity,
      unitYuan: input.record.pricing.prices[input.rentKind] ?? '0',
      originalYuan: '0.00',
      amountYuan: '0.00',
      discountYuan: '0.00',
      couponApplied: false,
      quantityOptions: result.options,
      error: QUOTE_ERROR_TEXT[result.code],
    };
  }
  return {
    rentKind: input.rentKind,
    quantity: input.quantity,
    unitYuan: result.unitYuan,
    originalYuan: fenToDisplayYuan(result.choice.originalFen),
    amountYuan: fenToDisplayYuan(result.choice.amountFen),
    discountYuan: fenToDisplayYuan(new Decimal(result.choice.discountFen).toString()),
    couponApplied: result.choice.couponId != null,
    quantityOptions: result.options,
    error: null,
  };
}
