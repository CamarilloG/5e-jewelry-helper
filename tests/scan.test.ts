// 筛选扫描：完整库存确认、同件约束、交集、空交集提前结束、分页去重、缺页不完整、缓存、停止/继续、迟到响应。
import { describe, expect, it } from 'vitest';
import { type FakeAccount, FakePlatform } from '../src/main/preview/fake-platform';
import type { FilterConditions } from '../src/shared/dto';
import { createHarness, waitFor } from './helpers';

function acc(no: string, items: [string, string][], over: Partial<FakeAccount> = {}): FakeAccount {
  return {
    accountNo: no,
    tags: ['虚拟'],
    value: '1000.00',
    prices: { hour: '5.00', day: '50.00', week: '0', morning: '0', noon: '0', evening: '0' },
    rentType: [1, 2],
    rentPeriod: 1,
    weekRange: { morning: [], noon: [], evening: [] },
    shelfStatus: 1,
    rentStatus: 0,
    expireTime: '0',
    useCoupon: 1,
    platformCouponConfig: 1,
    durations: { hour: [1, 2, 3], day: [1], week: [] },
    inventory: items.map(([marketName, firstType]) => ({
      marketName,
      firstType,
      price: '100.00',
      rarity: 6,
      rarityName: '隐秘',
      nameColor: 'eb4b4b',
      exteriorName: '崭新出厂',
      wear: '0.01',
    })),
    ...over,
  };
}

const BFLY_DOPPLER: [string, string] = ['蝴蝶刀（★） | 多普勒 (崭新出厂)', '匕首'];
const KARAMBIT_DOPPLER: [string, string] = ['爪子刀（★） | 多普勒 (崭新出厂)', '匕首'];
const BFLY_FADE: [string, string] = ['蝴蝶刀（★） | 渐变之色 (崭新出厂)', '匕首'];
const GLOVE: [string, string] = ['运动手套（★） | 潘多拉之盒 (略有磨损)', '手套'];

const cond = (
  items: FilterConditions['items'],
  over: Partial<FilterConditions> = {},
): FilterConditions => ({
  items,
  rentKind: 'HOUR',
  priceMin: null,
  priceMax: null,
  couponOnly: false,
  ...over,
});

async function run(fake: FakePlatform, c: FilterConditions) {
  const h = await createHarness({ fake });
  h.controller.scan.start(c);
  await waitFor(() => ['COMPLETE', 'FAILED', 'STOPPED'].includes(h.controller.scan.state().phase));
  return h;
}

describe('同件约束与交集', () => {
  const fake = () =>
    new FakePlatform([
      acc('CS0000000001', [BFLY_DOPPLER]),
      acc('CS0000000002', [KARAMBIT_DOPPLER, BFLY_FADE]), // 有蝴蝶刀也有多普勒，但不是同一件
      acc('CS0000000003', [BFLY_DOPPLER, GLOVE]),
      acc('CS0000000004', [GLOVE]),
    ]);

  it('同一行的大类和名称必须由同一件饰品满足', async () => {
    const h = await run(fake(), cond([{ categoryId: 'w:蝴蝶刀', name: '多普勒' }]));
    const nos = h.controller.scan
      .state()
      .results.map((r) => r.account.accountNo)
      .sort();
    expect(nos).toEqual(['CS0000000001', 'CS0000000003']);
    expect(h.controller.scan.state().incomplete).toBe(false);
  });

  it('多行取交集；匹配度为命中的不同饰品件数', async () => {
    const h = await run(
      fake(),
      cond([
        { categoryId: 'w:蝴蝶刀', name: '多普勒' },
        { categoryId: 'w:运动手套', name: null },
      ]),
    );
    const results = h.controller.scan.state().results;
    expect(results.map((r) => r.account.accountNo)).toEqual(['CS0000000003']);
    expect(results[0]?.score).toBe(2);
  });

  it('关键词交集为空立即结束，不扫库存', async () => {
    const f = fake();
    const h = await run(
      f,
      cond([
        { categoryId: null, name: '多普勒' },
        { categoryId: null, name: '不存在的皮肤' },
      ]),
    );
    expect(h.controller.scan.state().results).toHaveLength(0);
    expect(f.count('/rent/account/inventory/display/info')).toBe(0);
  });

  it('含饰品条件的每个候选都确认完整库存；展示位不作为命中证据', async () => {
    const f = new FakePlatform([
      acc('CS0000000010', [
        ['P90 | 异星世界', '微型冲锋枪'],
        ['P90 | 异星世界', '微型冲锋枪'],
        ['P90 | 异星世界', '微型冲锋枪'],
        ['P90 | 异星世界', '微型冲锋枪'],
        ['P90 | 异星世界', '微型冲锋枪'],
        BFLY_DOPPLER, // 第 6 件，不在展示位
      ]),
    ]);
    const h = await run(f, cond([{ categoryId: 'w:蝴蝶刀', name: null }]));
    expect(h.controller.scan.state().results).toHaveLength(1);
    expect(f.count('/rent/account/inventory/display/info')).toBe(1);
  });

  it('价格上下界与租期支持过滤', async () => {
    const f = new FakePlatform([
      acc('CS0000000021', [BFLY_DOPPLER], {
        prices: { hour: '3.00', day: '0', week: '0', morning: '0', noon: '0', evening: '0' },
      }),
      acc('CS0000000022', [BFLY_DOPPLER], {
        prices: { hour: '12.00', day: '0', week: '0', morning: '0', noon: '0', evening: '0' },
      }),
    ]);
    const h = await run(
      f,
      cond([{ categoryId: null, name: '多普勒' }], { priceMin: '2', priceMax: '10' }),
    );
    expect(h.controller.scan.state().results.map((r) => r.account.accountNo)).toEqual([
      'CS0000000021',
    ]);
  });
});

describe('分页、缺页与缓存', () => {
  it('分页去重并收齐 total', async () => {
    const accounts = Array.from({ length: 230 }, (_, i) =>
      acc(`CS${String(i).padStart(10, '0')}`, [BFLY_DOPPLER]),
    );
    const f = new FakePlatform(accounts);
    const h = await run(f, cond([], {}));
    expect(h.controller.scan.state().candidates).toBe(230);
    expect(f.count('/rent/account/search')).toBe(3);
  });

  it('任一页失败：保留已有结果并标注不完整', async () => {
    const accounts = Array.from({ length: 150 }, (_, i) =>
      acc(`CS${String(i).padStart(10, '0')}`, [BFLY_DOPPLER]),
    );
    const f = new FakePlatform(accounts);
    const h = await createHarness({ fake: f });
    // 第 2 页连续失败（含 2 次只读重试）
    let calls = 0;
    const orig = f.post.bind(f);
    f.post = async (url, body, headers, signal) => {
      if (url.endsWith('/rent/account/search') && [2, 3, 4].includes(++calls))
        throw new Error('net::ERR');
      return orig(url, body, headers, signal);
    };
    h.controller.scan.start(cond([{ categoryId: null, name: '多普勒' }]));
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE', 15_000);
    expect(h.controller.scan.state().incomplete).toBe(true);
    expect(h.controller.scan.state().results.length).toBe(100);
  }, 20_000);

  it('库存确认失败的账号单独标记并可重试', async () => {
    const f = new FakePlatform([
      acc('CS0000000031', [BFLY_DOPPLER]),
      acc('CS0000000032', [BFLY_DOPPLER]),
    ]);
    f.failNext('/rent/account/inventory/display/info', {
      kind: 'business',
      code: 500,
      message: 'x',
    });
    const h = await run(f, cond([{ categoryId: null, name: '多普勒' }]));
    const s = h.controller.scan.state();
    expect(s.failedAccounts).toHaveLength(1);
    expect(s.incomplete).toBe(true);
    h.controller.scan.retryFailed();
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    expect(h.controller.scan.state().results).toHaveLength(2);
    expect(h.controller.scan.state().failedAccounts).toHaveLength(0);
  });

  it('库存缓存命中不再请求；缓存过期后刷新', async () => {
    const f = new FakePlatform([acc('CS0000000041', [BFLY_DOPPLER])]);
    const h = await run(f, cond([{ categoryId: null, name: '多普勒' }]));
    expect(f.count('/rent/account/inventory/display/info')).toBe(1);
    h.controller.scan.start(cond([{ categoryId: 'w:蝴蝶刀', name: null }]));
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    expect(f.count('/rent/account/inventory/display/info')).toBe(1);
    await h.db.call('cache.clear', undefined);
    h.controller.scan.start(cond([{ categoryId: 'w:蝴蝶刀', name: null }]));
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    expect(f.count('/rent/account/inventory/display/info')).toBe(2);
  });
});

describe('停止、继续与迟到响应', () => {
  it('停止保留结果与游标，继续沿用原条件快照', async () => {
    const accounts = Array.from({ length: 30 }, (_, i) =>
      acc(`CS${String(i).padStart(10, '0')}`, [BFLY_DOPPLER]),
    );
    const f = new FakePlatform(accounts);
    f.latencyMs = 5;
    const h = await createHarness({ fake: f });
    h.controller.scan.start(cond([{ categoryId: null, name: '多普勒' }]));
    await waitFor(() => h.controller.scan.state().confirmed >= 5);
    h.controller.scan.stop();
    const stopped = h.controller.scan.state();
    expect(stopped.phase).toBe('STOPPED');
    const kept = stopped.results.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(h.controller.scan.state().results.length).toBe(kept);
    h.controller.scan.continue();
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    expect(h.controller.scan.state().results).toHaveLength(30);
    expect(h.controller.scan.state().conditions).toEqual(stopped.conditions);
  });

  it('重新筛选先取消旧任务；旧 scanId 的迟到结果被丢弃', async () => {
    const accounts = [
      ...Array.from({ length: 20 }, (_, i) =>
        acc(`CS1${String(i).padStart(9, '0')}`, [BFLY_DOPPLER]),
      ),
      acc('CS2000000000', [GLOVE]),
    ];
    const f = new FakePlatform(accounts);
    f.latencyMs = 5;
    const h = await createHarness({ fake: f });
    h.controller.scan.start(cond([{ categoryId: null, name: '多普勒' }]));
    await waitFor(() => h.controller.scan.state().confirmed >= 3);
    h.controller.scan.start(cond([{ categoryId: 'w:运动手套', name: null }]));
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.controller.scan.state().results.map((r) => r.account.accountNo)).toEqual([
      'CS2000000000',
    ]);
  });
});

describe('纯租期/价格浏览', () => {
  it('不读取库存，逐个确认状态；状态来自详情接口', async () => {
    const f = new FakePlatform([
      acc('CS0000000051', [GLOVE]),
      acc('CS0000000052', [GLOVE], { rentStatus: 1 }),
    ]);
    const h = await run(f, cond([]));
    expect(f.count('/rent/account/inventory/display/info')).toBe(0);
    const statuses = Object.fromEntries(
      h.controller.scan.state().results.map((r) => [r.account.accountNo, r.account.status]),
    );
    expect(statuses).toEqual({ CS0000000051: 'AVAILABLE', CS0000000052: 'RENTED' });
  });
});
