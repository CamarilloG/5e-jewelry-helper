// 领域规则：状态、租期、包时段、金额元/分、优惠券、同件匹配、可租周期、支付状态映射。
import { describe, expect, it } from 'vitest';
import {
  type CouponInput,
  CouponListIncompleteError,
  chooseCoupon,
} from '../src/main/domain/coupon';
import { conditionKeyword, matchInventory, weaponPrefix } from '../src/main/domain/matching';
import { initialMonitorState, type MonitorState, observe } from '../src/main/domain/monitor';
import { payVerdict } from '../src/main/domain/order-reasons';
import { fenToDisplayYuan, originalFen } from '../src/shared/money';
import {
  quantityOptions,
  type RentPricing,
  shanghaiClock,
  slotOrderable,
  supportsRent,
} from '../src/shared/rent';
import { accountStatus } from '../src/shared/status';

const pricing = (over: Partial<RentPricing> = {}): RentPricing => ({
  rentType: [1, 2, 3, 4, 5, 6],
  prices: { HOUR: '3.50', DAY: '30', WEEK: '0', EARLY: '5', NOON: '5', NIGHT: '8' },
  firstPrices: {},
  actPrices: {},
  rentPeriod: 2,
  weekRange: { EARLY: [1, 2, 3, 4, 5], NOON: [1, 2, 3, 4, 5, 6, 7], NIGHT: [5, 6, 7] },
  ...over,
});

// 北京时间 2026-11-09（周一）hh:mm 对应的 UTC 毫秒
const bj = (day: number, hh: number, mm: number) => Date.UTC(2026, 10, day, hh - 8, mm);

describe('账号状态', () => {
  it('在架空闲为可租，租用为租赁中，非 1 上架为已下架', () => {
    expect(accountStatus(1, 0)).toBe('AVAILABLE');
    expect(accountStatus(1, 1)).toBe('RENTED');
    expect(accountStatus(2, 0)).toBe('OFF_SHELF');
    expect(accountStatus(0, 1)).toBe('OFF_SHELF');
  });
  it('缺失或陌生枚举为未知，绝不推断可租', () => {
    expect(accountStatus(undefined, 0)).toBe('UNKNOWN');
    expect(accountStatus(1, undefined)).toBe('UNKNOWN');
    expect(accountStatus(1, 7)).toBe('UNKNOWN');
    expect(accountStatus('x', 0)).toBe('UNKNOWN');
    expect(accountStatus(1.5, 0)).toBe('UNKNOWN');
  });
});

describe('租期与数量', () => {
  it('支持条件：rentType 包含编号且原价大于零', () => {
    const p = pricing();
    expect(supportsRent(p, 'HOUR')).toBe(true);
    expect(supportsRent(p, 'WEEK')).toBe(false); // 零价未开放
    expect(supportsRent(pricing({ rentType: [1, 2] }), 'NIGHT')).toBe(false); // 有价但未开放
  });
  it('小时租数量不少于起租小时数，时段租固定 1 次', () => {
    const d = { hourDuration: [1, 2, 3, 0, -1, 2], dayDuration: [1, 3], weekDuration: [] };
    expect(quantityOptions('HOUR', d, 2)).toEqual([2, 3]);
    expect(quantityOptions('DAY', d, 2)).toEqual([1, 3]);
    expect(quantityOptions('NIGHT', null, 2)).toEqual([1]);
    expect(quantityOptions('WEEK', d, 2)).toEqual([]);
  });
});

describe('包时段（北京时间左闭右开 + 星期）', () => {
  const p = pricing();
  it('包早 07:00–09:00', () => {
    expect(slotOrderable('EARLY', bj(9, 6, 59), p.weekRange)).toBe(false);
    expect(slotOrderable('EARLY', bj(9, 7, 0), p.weekRange)).toBe(true);
    expect(slotOrderable('EARLY', bj(9, 8, 59), p.weekRange)).toBe(true);
    expect(slotOrderable('EARLY', bj(9, 9, 0), p.weekRange)).toBe(false);
  });
  it('包午 09:00–10:30', () => {
    expect(slotOrderable('NOON', bj(9, 9, 0), p.weekRange)).toBe(true);
    expect(slotOrderable('NOON', bj(9, 10, 29), p.weekRange)).toBe(true);
    expect(slotOrderable('NOON', bj(9, 10, 30), p.weekRange)).toBe(false);
  });
  it('包夜 00:00–02:00 且受星期限制', () => {
    // 11-13 为周五
    expect(shanghaiClock(bj(13, 1, 0)).weekday).toBe(5);
    expect(slotOrderable('NIGHT', bj(13, 0, 0), p.weekRange)).toBe(true);
    expect(slotOrderable('NIGHT', bj(13, 2, 0), p.weekRange)).toBe(false);
    expect(slotOrderable('NIGHT', bj(9, 1, 0), p.weekRange)).toBe(false); // 周一不在可用星期
  });
  it('周日映射为 7', () => {
    expect(shanghaiClock(bj(15, 12, 0)).weekday).toBe(7);
  });
});

describe('金额：元 → 分', () => {
  it('2 小时 ¥0.10 → realAmount "20" 分', () => {
    expect(originalFen('0.10', 2).toString()).toBe('20');
  });
  it('先按 ROUND_HALF_UP 保留两位再乘 100', () => {
    expect(originalFen('3.335', 1).toString()).toBe('334');
    expect(originalFen('0.1', 3).toString()).toBe('30');
    expect(originalFen('19.99', 7).toString()).toBe('13993');
  });
  it('显示为 分/100 向下两位', () => {
    expect(fenToDisplayYuan('1024.22')).toBe('10.24');
    expect(fenToDisplayYuan('20')).toBe('0.20');
  });
});

const NOW = Date.UTC(2026, 10, 7, 4, 0);
const coupon = (over: Partial<CouponInput>): CouponInput => ({
  id: 'c1',
  couponType: 1,
  discountType: 2,
  discountValue: '100',
  thresholdAmount: '0',
  status: 1,
  validStartAtMs: NOW - 1000,
  validEndAtMs: NOW + 86_400_000,
  ...over,
});
const base = {
  unitYuan: '10',
  count: 2,
  kind: 'HOUR' as const,
  nowMs: NOW,
  autoCoupon: true,
  accountAllows: true,
  complete: true,
};

describe('优惠券', () => {
  it('立减（分值换算为元）并有下限 0', () => {
    expect(chooseCoupon({ ...base, coupons: [coupon({ discountValue: '500' })] }).amountFen).toBe(
      '1500',
    );
    expect(chooseCoupon({ ...base, coupons: [coupon({ discountValue: '2000' })] }).amountFen).toBe(
      '0',
    );
    // 优惠额不得超过原价元
    expect(chooseCoupon({ ...base, coupons: [coupon({ discountValue: '2001' })] }).propId).toBe(
      '0',
    );
  });
  it('折扣、满减门槛、零元', () => {
    expect(
      chooseCoupon({ ...base, coupons: [coupon({ discountType: 1, discountValue: '85' })] })
        .amountFen,
    ).toBe('1700');
    expect(
      chooseCoupon({
        ...base,
        coupons: [coupon({ discountType: 3, discountValue: '300', thresholdAmount: '2500' })],
      }).propId,
    ).toBe('0');
    expect(
      chooseCoupon({
        ...base,
        coupons: [coupon({ discountType: 3, discountValue: '300', thresholdAmount: '2000' })],
      }).amountFen,
    ).toBe('1700');
    expect(chooseCoupon({ ...base, coupons: [coupon({ discountType: 4 })] }).amountFen).toBe('0');
  });
  it('适用租期、有效期、状态、陌生类型不自动使用', () => {
    expect(chooseCoupon({ ...base, coupons: [coupon({ couponType: 2 })] }).propId).toBe('0');
    expect(chooseCoupon({ ...base, coupons: [coupon({ couponType: 7 })] }).propId).toBe('c1');
    expect(chooseCoupon({ ...base, coupons: [coupon({ couponType: 8 })] }).propId).toBe('0');
    expect(chooseCoupon({ ...base, coupons: [coupon({ validEndAtMs: NOW - 1 })] }).propId).toBe(
      '0',
    );
    expect(chooseCoupon({ ...base, coupons: [coupon({ validStartAtMs: NOW + 1 })] }).propId).toBe(
      '0',
    );
    expect(chooseCoupon({ ...base, coupons: [coupon({ status: 2 })] }).propId).toBe('0');
    expect(chooseCoupon({ ...base, coupons: [coupon({ couponType: 10 })] }).propId).toBe('0');
    expect(chooseCoupon({ ...base, coupons: [coupon({ discountType: 9 })] }).propId).toBe('0');
  });
  it('选实付最低；同价依次比门槛高、到期早、ID 小', () => {
    const a = coupon({ id: 'b', discountValue: '500', thresholdAmount: '0' });
    const b = coupon({ id: 'a', discountValue: '500', thresholdAmount: '100' });
    const c = coupon({
      id: 'c',
      discountValue: '500',
      thresholdAmount: '100',
      validEndAtMs: NOW + 1000,
    });
    expect(chooseCoupon({ ...base, coupons: [a, b] }).propId).toBe('a');
    expect(chooseCoupon({ ...base, coupons: [a, b, c] }).propId).toBe('c');
    const d = coupon({
      id: 'z',
      discountValue: '500',
      thresholdAmount: '100',
      validEndAtMs: NOW + 1000,
    });
    expect(chooseCoupon({ ...base, coupons: [d, c] }).propId).toBe('c');
    expect(
      chooseCoupon({ ...base, coupons: [a, coupon({ id: 'big', discountValue: '900' })] }).propId,
    ).toBe('big');
  });
  it('券列表不完整时阻止自动用券；关闭自动用券或账号不允许则原价且 propId 0', () => {
    expect(() => chooseCoupon({ ...base, complete: false, coupons: [] })).toThrow(
      CouponListIncompleteError,
    );
    expect(
      chooseCoupon({ ...base, complete: false, autoCoupon: false, coupons: [] }),
    ).toMatchObject({ propId: '0', amountFen: '2000' });
    expect(chooseCoupon({ ...base, accountAllows: false, coupons: [coupon({})] }).propId).toBe('0');
  });
});

const item = (key: string, marketName: string, firstType: string) => ({
  key,
  marketName,
  firstType,
});

describe('饰品匹配', () => {
  const inv = [
    item('1', '蝴蝶刀（★） | 多普勒 (崭新出厂)', '匕首'),
    item('2', '爪子刀（★） | 虎牙 (崭新出厂)', '匕首'),
    item('3', '运动手套（★） | 潘多拉之盒 (略有磨损)', '手套'),
    item('4', 'M9 刺刀（★） | 多普勒 (崭新出厂)', '匕首'),
  ];
  it('同一行必须由同一件饰品满足', () => {
    expect(matchInventory(inv, [{ categoryId: 'w:蝴蝶刀', name: '多普勒' }]).matched).toBe(true);
    expect(matchInventory(inv, [{ categoryId: 'w:爪子刀', name: '多普勒' }]).matched).toBe(false);
  });
  it('多行取交集，命中件数去重', () => {
    const r = matchInventory(inv, [
      { categoryId: null, name: '多普勒' },
      { categoryId: 'f:匕首', name: null },
    ]);
    expect(r.matched).toBe(true);
    expect(r.score).toBe(3); // 多普勒×2 与 匕首×3 的并集去重为 3 件
    expect(
      matchInventory(inv, [
        { categoryId: 'w:蝴蝶刀', name: null },
        { categoryId: 'w:裹手', name: null },
      ]).matched,
    ).toBe(false);
  });
  it('刺刀与 M9 刺刀精确区分；忽略空格全半角', () => {
    expect(matchInventory(inv, [{ categoryId: 'w:刺刀', name: null }]).matched).toBe(false);
    expect(matchInventory(inv, [{ categoryId: 'w:M9 刺刀', name: '多 普 勒' }]).matched).toBe(true);
    const wide = [item('9', 'Ｍ９　刺刀（★） | 多普勒 (崭新出厂)', '匕首')];
    expect(matchInventory(wide, [{ categoryId: 'w:M9 刺刀', name: null }]).matched).toBe(true);
    expect(weaponPrefix('FN57（StatTrak™） | 暴怒野兽 (破损不堪)')).toBe('FN57');
  });
  it('关键词：有名称优先名称；大类无可靠关键词', () => {
    expect(conditionKeyword({ categoryId: 'w:蝴蝶刀', name: '多普勒' })).toBe('多普勒');
    expect(conditionKeyword({ categoryId: 'w:蝴蝶刀', name: null })).toBe('蝴蝶刀');
    expect(conditionKeyword({ categoryId: 'f:手套', name: null })).toBeNull();
  });
});

describe('可租周期与通知', () => {
  const ok = (status: 'AVAILABLE' | 'RENTED' | 'OFF_SHELF') => ({
    ok: true as const,
    status,
    expireTimeMs: null,
  });
  const run = (states: MonitorState, seq: Parameters<typeof observe>[1][]) => {
    let s = states;
    const notifies: boolean[] = [];
    for (const o of seq) {
      const r = observe(s, o, 1);
      s = r.next;
      notifies.push(r.notify);
    }
    return { s, notifies };
  };
  it('首次基线不通知（即使已可租）', () => {
    expect(run(initialMonitorState(), [ok('AVAILABLE')]).notifies).toEqual([false]);
  });
  it('租赁中 → 可租通知一次；可租 → 失败 → 可租不重复', () => {
    const r = run(initialMonitorState(), [
      ok('RENTED'),
      ok('AVAILABLE'),
      { ok: false, error: 'x' },
      ok('AVAILABLE'),
    ]);
    expect(r.notifies).toEqual([false, true, false, false]);
    expect(r.s.trustedStatus).toBe('AVAILABLE');
  });
  it('可租 → 不可租 → 可租为新周期再次通知', () => {
    const r = run(initialMonitorState(), [
      ok('RENTED'),
      ok('AVAILABLE'),
      ok('RENTED'),
      ok('AVAILABLE'),
    ]);
    expect(r.notifies).toEqual([false, true, false, true]);
  });
  it('失败时显示未知但保留最后可信状态', () => {
    const r = run(initialMonitorState(), [ok('RENTED'), { ok: false, error: '网络' }]);
    expect(r.s.displayStatus).toBe('UNKNOWN');
    expect(r.s.trustedStatus).toBe('RENTED');
  });
  it('重启后保留周期：同一可租周期不重放', () => {
    const first = run(initialMonitorState(), [ok('RENTED'), ok('AVAILABLE')]).s;
    const restored = { ...first };
    expect(run(restored, [ok('AVAILABLE')]).notifies).toEqual([false]);
  });
});

describe('支付状态映射', () => {
  it('已支付、待支付、平台确认超时', () => {
    expect(payVerdict(1, 0).kind).toBe('PAID');
    expect(payVerdict(0, 0).kind).toBe('PENDING');
    expect(payVerdict(0, 5).kind).toBe('EXPIRED');
  });
  it('异常码与陌生状态', () => {
    expect(payVerdict(0, 2)).toMatchObject({ kind: 'REJECTED', code: 'TAKEN' });
    expect(payVerdict(0, 6)).toMatchObject({ kind: 'REJECTED', code: 'OFF_SHELF' });
    expect(payVerdict(0, 4).kind).toBe('PAYMENT_ABNORMAL');
    expect(payVerdict(3, 0).kind).toBe('UNKNOWN');
    expect(payVerdict(0, 99).kind).toBe('UNKNOWN');
    expect(payVerdict(1, 5).kind).toBe('UNKNOWN');
  });
});
