// 领域规则：状态、租期、包时段、金额元/分、优惠券、同件匹配、可租周期、支付状态映射。
import { describe, expect, it } from 'vitest';
import {
  type CouponInput,
  CouponListIncompleteError,
  chooseCoupon,
} from '../src/main/domain/coupon';
import {
  conditionFingerprint,
  conditionKeywords,
  matchInventory,
  planConditionRows,
  weaponPrefix,
} from '../src/main/domain/matching';
import { initialMonitorState, type MonitorState, observe } from '../src/main/domain/monitor';
import { payVerdict } from '../src/main/domain/order-reasons';
import {
  applyInventoryToSummary,
  mergeAccountSummary,
  selectGridItems,
  summarize,
  upgradeAccountSummary,
} from '../src/main/services/views';
import { BUILTIN_FILTER_PRESETS } from '../src/shared/builtin-presets';
import {
  CATEGORIES,
  CATEGORY_BY_ID,
  categorySupportsFastPath,
  downgradeCategoryEvidence,
  getCategoryEvidence,
  resetDowngradedEvidence,
} from '../src/shared/catalog';
import { cleanCondition, upgradeConditions, upgradeItemCondition } from '../src/shared/conditions';
import { partitionResultsForFilter, type ScanResultView, sortResultList } from '../src/shared/dto';
import { fenToDisplayYuan, originalFen } from '../src/shared/money';
import {
  quantityOptions,
  type RentPricing,
  shanghaiClock,
  slotOrderable,
  supportsRent,
} from '../src/shared/rent';
import { migrateDeviceSettings, SETTINGS_SCHEMA_VERSION } from '../src/shared/settings';
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
    expect(matchInventory(inv, [{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]).matched).toBe(
      true,
    );
    expect(matchInventory(inv, [{ categoryIds: ['w:爪子刀'], names: ['多普勒'] }]).matched).toBe(
      false,
    );
  });
  it('多行取交集，命中件数去重', () => {
    const r = matchInventory(inv, [
      { categoryIds: [], names: ['多普勒'] },
      { categoryIds: ['f:匕首'], names: [] },
    ]);
    expect(r.matched).toBe(true);
    expect(r.score).toBe(3); // 多普勒×2 与 匕首×3 的并集去重为 3 件
    expect(
      matchInventory(inv, [
        { categoryIds: ['w:蝴蝶刀'], names: [] },
        { categoryIds: ['w:裹手'], names: [] },
      ]).matched,
    ).toBe(false);
  });
  it('刺刀与 M9 刺刀精确区分；忽略空格全半角', () => {
    expect(matchInventory(inv, [{ categoryIds: ['w:刺刀'], names: [] }]).matched).toBe(false);
    expect(matchInventory(inv, [{ categoryIds: ['w:M9 刺刀'], names: ['多 普 勒'] }]).matched).toBe(
      true,
    );
    const wide = [item('9', 'Ｍ９　刺刀（★） | 多普勒 (崭新出厂)', '匕首')];
    expect(matchInventory(wide, [{ categoryIds: ['w:M9 刺刀'], names: [] }]).matched).toBe(true);
    expect(weaponPrefix('FN57（StatTrak™） | 暴怒野兽 (破损不堪)')).toBe('FN57');
  });
  it('关键词：有皮肤优先皮肤；多选为并集；含大类时无可靠关键词', () => {
    expect(conditionKeywords({ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] })).toEqual(['多普勒']);
    expect(conditionKeywords({ categoryIds: ['w:蝴蝶刀'], names: [] })).toEqual(['蝴蝶刀']);
    expect(conditionKeywords({ categoryIds: ['w:蝴蝶刀', 'w:M9 刺刀'], names: [] })).toEqual([
      '蝴蝶刀',
      'M9',
    ]);
    expect(conditionKeywords({ categoryIds: ['f:手套'], names: [] })).toBeNull();
    expect(conditionKeywords({ categoryIds: ['w:蝴蝶刀', 'f:手套'], names: [] })).toBeNull();
    expect(conditionKeywords({ categoryIds: ['f:手套'], names: ['潘多拉之盒'] })).toEqual([
      '潘多拉之盒',
    ]);
  });

  it('行内多选：任一类别、任一皮肤，且须同一件满足', () => {
    const row = { categoryIds: ['w:爪子刀', 'w:M9 刺刀'], names: ['多普勒', '虎牙'] };
    const r = matchInventory(inv, [row]);
    expect(r.matched).toBe(true);
    expect(r.hitKeys.sort()).toEqual(['2', '4']); // 爪子刀虎牙、M9 多普勒；蝴蝶刀多普勒不算
    expect(
      matchInventory(inv, [{ categoryIds: ['w:爪子刀', 'w:蝴蝶刀'], names: ['潘多拉之盒'] }])
        .matched,
    ).toBe(false);
  });

  it('大类按 firstType；大类与子类可混选', () => {
    expect(matchInventory(inv, [{ categoryIds: ['f:手套'], names: [] }]).hitKeys).toEqual(['3']);
    expect(
      matchInventory(inv, [{ categoryIds: ['f:手套', 'w:蝴蝶刀'], names: [] }]).hitKeys.sort(),
    ).toEqual(['1', '3']);
  });

  it('子类别名：M4A1 消音版/消音型、格洛克有无空格、USP 有无空格', () => {
    const guns = [
      item('a', 'M4A1消音版 | 印花集 (久经沙场)', '步枪'),
      item('b', 'M4A1 消音型 | 氮化处理 (略有磨损)', '步枪'),
      item('c', '格洛克18型（StatTrak™） | 水灵 (崭新出厂)', '手枪'),
      item('d', 'USP消音版 | 枪响人亡 (久经沙场)', '手枪'),
      item('e', 'M4A4 | 喧嚣杀戮 (久经沙场)', '步枪'),
    ];
    expect(
      matchInventory(guns, [{ categoryIds: ['w:M4A1 消音版'], names: [] }]).hitKeys.sort(),
    ).toEqual(['a', 'b']);
    expect(matchInventory(guns, [{ categoryIds: ['w:格洛克 18 型'], names: [] }]).matched).toBe(
      true,
    );
    expect(matchInventory(guns, [{ categoryIds: ['w:USP 消音版'], names: [] }]).matched).toBe(true);
  });
});

describe('条件升级与内置方案', () => {
  it('v1 方案（单分类+单名称）升级为 v2；旧 id 换算；无效 id 丢弃', () => {
    expect(upgradeItemCondition({ categoryId: 'w:蝴蝶刀', name: '多普勒' })).toEqual({
      categoryIds: ['w:蝴蝶刀'],
      names: ['多普勒'],
    });
    expect(upgradeItemCondition({ categoryId: 'w:M4A1 消音型', name: null })).toEqual({
      categoryIds: ['w:M4A1 消音版'],
      names: [],
    });
    expect(upgradeItemCondition({ categoryId: 'w:不存在', name: null })).toEqual({
      categoryIds: [],
      names: [],
    });
    const c = upgradeConditions({
      items: [
        { categoryId: null, name: '多普勒' },
        { categoryId: null, name: null },
      ],
      rentKind: 'DAY',
      priceMin: '',
      priceMax: '10',
      couponOnly: true,
    });
    expect(c).toEqual({
      items: [{ categoryIds: [], names: ['多普勒'] }],
      rentKind: 'DAY',
      priceMin: null,
      priceMax: '10',
      couponOnly: true,
    });
    expect(upgradeConditions({ items: [], rentKind: 'BAD' })).toBeNull();
  });

  it('选了整个大类时去掉同大类下的子类', () => {
    expect(
      cleanCondition({ categoryIds: ['w:运动手套', 'f:手套', 'w:蝴蝶刀'], names: [] }),
    ).toEqual({ categoryIds: ['f:手套', 'w:蝴蝶刀'], names: [] });
  });

  it('内置方案的每个分类都在词典中，关键词不含空格', () => {
    for (const p of BUILTIN_FILTER_PRESETS) {
      for (const row of p.conditions.items) {
        expect(cleanCondition(row)).toEqual(row);
      }
    }
    for (const c of CATEGORIES) {
      if (c.keyword) expect(c.keyword).not.toMatch(/\s/);
      // 关键词必须是该子类所有写法的子串（可更宽，不能更窄）
      for (const n of c.names) {
        if (c.keyword) expect(n.replace(/\s+/g, '')).toContain(c.keyword);
      }
    }
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

describe('1.0.2 关键词证据、条件指纹、TTL 迁移、收藏宫格与状态待确认分区', () => {
  it('A1 (R02)：三类独立证据、格洛克18型/加利尔AR 修正、宽词与未认证词不进入快速路径、支持降级', () => {
    const glock = CATEGORY_BY_ID.get('w:格洛克 18 型');
    expect(glock?.keyword).toBe('格洛克18型');
    // 实测：精确性已认证，但带空格命名漏召回（15 个持有账号仅召回 4 个），覆盖不完整
    expect(getCategoryEvidence('w:格洛克 18 型')?.precision).toBe('verified');
    expect(getCategoryEvidence('w:格洛克 18 型')?.coverage).toBe('partial');
    expect(categorySupportsFastPath('w:格洛克 18 型')).toBe(false);
    const plannedGlock = planConditionRows([{ categoryIds: ['w:格洛克 18 型'], names: [] }]);
    expect(plannedGlock[0]?.coverageVerified).toBe(false);

    const galil = CATEGORY_BY_ID.get('w:加利尔 AR');
    expect(galil?.keyword).toBe('加利尔AR');
    expect(getCategoryEvidence('w:加利尔 AR')?.coverage).toBe('partial');
    expect(categorySupportsFastPath('w:加利尔 AR')).toBe(false);

    // 刺刀在平台会同时命中 M9 刺刀（precision = wide_match），严禁进入快速路径
    expect(getCategoryEvidence('w:刺刀')?.precision).toBe('wide_match');
    expect(categorySupportsFastPath('w:刺刀')).toBe(false);

    // 任意手套展开为「手套」∪「裹手」
    const plannedGlove = planConditionRows([{ categoryIds: ['f:手套'], names: [] }]);
    expect(plannedGlove[0]?.keywords.sort()).toEqual(['手套', '裹手'].sort());
    expect(plannedGlove[0]?.fastPathEligible).toBe(true);

    // 降级后不再进入快速路径，重置后恢复
    downgradeCategoryEvidence('w:蝴蝶刀');
    expect(categorySupportsFastPath('w:蝴蝶刀')).toBe(false);
    resetDowngradedEvidence();
    expect(categorySupportsFastPath('w:蝴蝶刀')).toBe(true);
  });

  it('B4 (R11)：规范化饰品条件指纹对行顺序不敏感、重复行去重、保留同件约束', () => {
    const fp1 = conditionFingerprint([
      { categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] },
      { categoryIds: ['w:AK-47'], names: [] },
    ]);
    const fp2 = conditionFingerprint([
      { categoryIds: ['w:AK-47'], names: [] },
      { categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] },
      { categoryIds: ['w:AK-47'], names: [] },
    ]);
    expect(fp1).toBe(fp2);

    // 同件约束不同：同一行 [蝴蝶刀+多普勒] 与 拆成两行 [蝴蝶刀] + [多普勒] 指纹不同
    const fpSplit = conditionFingerprint([
      { categoryIds: ['w:蝴蝶刀'], names: [] },
      { categoryIds: [], names: ['多普勒'] },
    ]);
    expect(fp1).not.toBe(fpSplit);
  });

  it('B5 (R12)：库存缓存 TTL 默认值迁移（新装 6H、升级保留显式有效值、缺字段或非法回退 1H）', () => {
    // 1. 新装（stored 为 null/undefined）→ 6H
    const fresh = migrateDeviceSettings(null);
    expect(fresh.settings.inventoryCacheTtl).toBe('6H');
    expect(fresh.settings.version).toBe(SETTINGS_SCHEMA_VERSION);

    // 2. 升级（v1 显式 1H）→ 保留 1H，不以“等于旧默认”误判为未选过
    expect(migrateDeviceSettings({ inventoryCacheTtl: '1H' }).settings.inventoryCacheTtl).toBe(
      '1H',
    );

    // 3. 升级（v1 显式 SESSION / 6H / 1D）→ 保留原值
    expect(migrateDeviceSettings({ inventoryCacheTtl: 'SESSION' }).settings.inventoryCacheTtl).toBe(
      'SESSION',
    );
    expect(migrateDeviceSettings({ inventoryCacheTtl: '6H' }).settings.inventoryCacheTtl).toBe(
      '6H',
    );
    expect(migrateDeviceSettings({ inventoryCacheTtl: '1D' }).settings.inventoryCacheTtl).toBe(
      '1D',
    );

    // 4. 旧设置缺少该字段 → 保留旧的 1H 行为
    expect(migrateDeviceSettings({ rateLimitPerMinute: 30 }).settings.inventoryCacheTtl).toBe('1H');

    // 5. 配置非法 → 回退 1H
    expect(
      migrateDeviceSettings({ inventoryCacheTtl: 'INVALID_TTL' }).settings.inventoryCacheTtl,
    ).toBe('1H');
    expect(migrateDeviceSettings('broken').settings.inventoryCacheTtl).toBe('1H');
  });

  it('C2 & C3 (R13)：收藏 3×3 宫格选图规则、旧摘要升级、空库存不复活旧图、普通同步不覆盖完整宫格', () => {
    const mk = (key: string, marketName: string, firstType: string, price: string | null) => ({
      id: key,
      assetid: key,
      rarity: 6,
      key,
      name: marketName,
      marketName,
      firstType,
      secondType: '',
      rarityName: '隐秘',
      nameColor: 'eb4b4b',
      rarityColor: 'eb4b4b',
      exteriorName: '崭新出厂',
      exterior: '崭新出厂',
      wear: '0.01',
      price,
      imageUrl: `https://img/${key}.png`,
      ossImgUrl: `https://img/${key}.png`,
      steamImgUrl: `https://img/${key}.png`,
      image: `https://img/${key}.png`,
      fallbackImage: null,
      stattrak: false,
      statTrak: false,
      style: '',
      stickers: [],
    });

    const pool = [
      mk('k1', '蝴蝶刀 | 多普勒', '匕首', '12000'),
      mk('k1', '蝴蝶刀 | 多普勒', '匕首', '12000'), // 重复 key 去重
      mk('k2', '爪子刀 | 虎牙', '匕首', '9000'),
      mk('k3', '弯刀 | 蓝钢', '匕首', '800'),
      mk('g1', '运动手套 | 潘多拉', '手套', '25000'),
      mk('g2', '专业手套 | 渐变', '手套', '6000'),
      mk('g3', '裹手 | 森林', '手套', '700'),
      mk('m1', 'AK-47 | 火神', '步枪', '2100'),
      mk('m2', 'AWP | 二西莫夫', '狙击步枪', '1500'),
      mk('m3', 'M4A1消音版 | 印花集', '步枪', '1200'),
      mk('p1', '沙漠之鹰 | 印花集', '手枪', '500'),
      mk('p2', 'USP消音版 | 脑洞大开', '手枪', '500'), // 同价按 key 升序
      mk('z_null', 'P90 | 无价饰品', '微型冲锋枪', null),
    ];

    const selected = selectGridItems(pool);
    expect(selected).toHaveLength(9);
    // 前 6 件为刀×2、手套×2、主战（步枪+狙击步枪）×2，其余 3 件按估价从高到低补齐（m3=1200, k3=800, g3=700）
    expect(selected.map((x) => x.key)).toEqual([
      'k1',
      'k2',
      'g1',
      'g2',
      'm1',
      'm2',
      'm3',
      'k3',
      'g3',
    ]);

    // 同价按唯一键稳定排序，估价缺失排在最后
    const tie = selectGridItems([
      mk('b_key', 'P250 | B', '手枪', '100'),
      mk('a_key', 'P250 | A', '手枪', '100'),
      mk('no_price', 'P250 | 无价', '手枪', null),
    ]);
    expect(tie.map((x) => x.key)).toEqual(['a_key', 'b_key', 'no_price']);

    // 旧 v1 单图摘要升级后可读
    const v1Upgraded = upgradeAccountSummary({
      tags: ['旧摘要'],
      pricing: pricing(),
      thumbnail: 'https://img/old.png',
      thumbnailSource: 'https://img/old.png',
    });
    expect(v1Upgraded?.summaryVersion).toBe(2);
    expect(v1Upgraded?.thumbnail).toBe('https://img/old.png');
    expect(v1Upgraded?.summarySource).toBe('display');

    // 确认完整库存为空后不再回退到旧展示位缩略图
    if (!v1Upgraded) throw new Error('expected upgraded summary');
    const emptyInv = applyInventoryToSummary(v1Upgraded, [], 2000);
    expect(emptyInv.summarySource).toBe('empty_inventory');
    expect(emptyInv.gridItems).toEqual([]);
    expect(emptyInv.thumbnail).toBeNull();

    // C4：完整库存生成的宫格摘要，不会被下一轮只有展示位的普通同步覆盖
    const fakeRec = {
      accountNo: 'CS1',
      tags: ['新标签'],
      value: '2000',
      status: 'AVAILABLE' as const,
      statusKnown: true,
      expireTimeMs: null,
      useCoupon: true,
      couponAllowed: true,
      isFirst: false,
      platformFavorited: false,
      pricing: pricing(),
      displayItems: [mk('p1', '沙漠之鹰 | 印花集', '手枪', '500')],
    };
    const fullSummary = summarize(fakeRec, pool, { source: 'inventory', updatedAt: 1000 });
    const displayOnlySummary = summarize(fakeRec, undefined, {
      source: 'display',
      updatedAt: 2000,
    });
    const merged = mergeAccountSummary(displayOnlySummary, fullSummary);
    expect(merged?.summarySource).toBe('inventory');
    expect(merged?.gridItems).toHaveLength(9);
    expect(merged?.tags).toEqual(['新标签']);
  });

  it('A3 & A5 (R04/R05)：默认仅可租视图分离「状态待确认」与「当前可租」，匹配度排序只比较已确认库存项', () => {
    const mkRes = (
      accountNo: string,
      status: 'AVAILABLE' | 'UNKNOWN' | 'RENTED' | 'OFF_SHELF',
      price: string,
      score: number | null,
      evidence: 'inventory' | 'search',
    ): ScanResultView => ({
      account: {
        accountNo,
        tags: [],
        value: '1000',
        status,
        expireTimeMs: null,
        prices: [
          {
            kind: 'HOUR' as const,
            supported: true,
            price,
            firstPrice: null,
            actPrice: null,
          },
        ],
        supported: ['HOUR'],
        rentPeriod: 1,
        weekRange: { EARLY: [], NOON: [], NIGHT: [] },
        couponAllowed: true,
        isFirst: false,
        displayItems: [],
        platformFavorited: null,
        fetchedAt: 1000,
      },
      score,
      hitItems: [],
      hitCount: score,
      favorite: false,
      origin: 'platform' as const,
      evidence,
    });

    const all = [
      mkRes('CS_UNKNOWN', 'UNKNOWN', '3.00', null, 'search'),
      mkRes('CS_AVAIL_1', 'AVAILABLE', '6.00', null, 'search'),
      mkRes('CS_AVAIL_2', 'AVAILABLE', '4.00', 5, 'inventory'),
      mkRes('CS_RENTED', 'RENTED', '2.00', 4, 'inventory'),
    ];

    const part = partitionResultsForFilter(all, 'PRICE_ASC', 'AVAILABLE', 'HOUR');
    expect(part.availableCount).toBe(2);
    expect(part.pendingResults.map((r) => r.account.accountNo)).toEqual(['CS_UNKNOWN']);
    expect(part.mainResults.map((r) => r.account.accountNo)).toEqual(['CS_AVAIL_2', 'CS_AVAIL_1']);
    expect(part.hiddenNonAvailableCount).toBe(1);

    // 按匹配度排序：仅已确认库存（evidence='inventory'）参与匹配度比较，search 证据排在后面
    const scoreSorted = sortResultList(part.mainResults, 'SCORE', 'HOUR');
    expect(scoreSorted.map((r) => r.account.accountNo)).toEqual(['CS_AVAIL_2', 'CS_AVAIL_1']);
  });
});
