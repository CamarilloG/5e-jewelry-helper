// 筛选扫描：完整库存确认、同件约束、交集、空交集提前结束、分页去重、缺页不完整、缓存、停止/继续、迟到响应。
import { describe, expect, it } from 'vitest';
import { type FakeAccount, FakePlatform } from '../src/main/preview/fake-platform';
import { BUILTIN_FILTER_PRESETS } from '../src/shared/builtin-presets';
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
    const h = await run(fake(), cond([{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]));
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
        { categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] },
        { categoryIds: ['w:运动手套'], names: [] },
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
        { categoryIds: [], names: ['多普勒'] },
        { categoryIds: [], names: ['不存在的皮肤'] },
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
    const h = await run(f, cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
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
      cond([{ categoryIds: [], names: ['多普勒'] }], { priceMin: '2', priceMax: '10' }),
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
    h.controller.scan.start(cond([{ categoryIds: [], names: ['多普勒'] }]));
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
    const h = await run(f, cond([{ categoryIds: [], names: ['多普勒'] }]));
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
    const h = await run(f, cond([{ categoryIds: [], names: ['多普勒'] }]));
    expect(f.count('/rent/account/inventory/display/info')).toBe(1);
    h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    expect(f.count('/rent/account/inventory/display/info')).toBe(1);
    await h.db.call('cache.clear', undefined);
    h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
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
    h.controller.scan.start(cond([{ categoryIds: [], names: ['多普勒'] }]));
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
    h.controller.scan.start(cond([{ categoryIds: [], names: ['多普勒'] }]));
    await waitFor(() => h.controller.scan.state().confirmed >= 3);
    h.controller.scan.start(cond([{ categoryIds: ['w:运动手套'], names: [] }]));
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.controller.scan.state().results.map((r) => r.account.accountNo)).toEqual([
      'CS2000000000',
    ]);
  });
});

describe('行内多选与内置方案', () => {
  const AK: [string, string] = ['AK-47 | 红线 (久经沙场)', '步枪'];
  const M4A1: [string, string] = ['M4A1消音版 | 印花集 (久经沙场)', '步枪'];
  const M4A1_OLD: [string, string] = ['M4A1 消音型 | 氮化处理 (略有磨损)', '步枪'];
  const USP: [string, string] = ['USP消音版 | 枪响人亡 (久经沙场)', '手枪'];
  const GLOCK: [string, string] = ['格洛克18型 | 水灵 (崭新出厂)', '手枪'];
  const M9: [string, string] = ['M9 刺刀（★） | 多普勒 (崭新出厂)', '匕首'];
  const GUNS = [AK, M4A1, USP, GLOCK];

  it('同一行多选子类取并集，行间取交集', async () => {
    const f = new FakePlatform([
      acc('CS0000000061', [BFLY_DOPPLER, GLOVE]),
      acc('CS0000000062', [M9, GLOVE]),
      acc('CS0000000063', [KARAMBIT_DOPPLER]), // 无手套
      acc('CS0000000064', [GLOVE]),
    ]);
    const h = await run(
      f,
      cond([
        { categoryIds: ['w:蝴蝶刀', 'w:M9 刺刀', 'w:爪子刀'], names: [] },
        { categoryIds: ['f:手套'], names: [] },
      ]),
    );
    expect(
      h.controller.scan
        .state()
        .results.map((r) => r.account.accountNo)
        .sort(),
    ).toEqual(['CS0000000061', 'CS0000000062']);
    expect(h.controller.scan.state().warnings).toHaveLength(0);
  });

  it('内置方案：四刀之一 + 任意手套 + 四把枪都要有；M4A1 两种写法都认', async () => {
    const preset = BUILTIN_FILTER_PRESETS[0];
    if (!preset) throw new Error('missing preset');
    const f = new FakePlatform([
      acc('CS0000000071', [BFLY_DOPPLER, GLOVE, ...GUNS]),
      acc('CS0000000072', [M9, GLOVE, AK, M4A1_OLD, USP, GLOCK]),
      acc('CS0000000073', [BFLY_FADE, GLOVE, AK, M4A1, USP]), // 缺格洛克
      acc('CS0000000074', [['弯刀（★） | 多普勒 (崭新出厂)', '匕首'], GLOVE, ...GUNS]), // 刀不对
      acc('CS0000000075', [BFLY_DOPPLER, ...GUNS]), // 无手套
    ]);
    const h = await run(f, preset.conditions);
    expect(
      h.controller.scan
        .state()
        .results.map((r) => r.account.accountNo)
        .sort(),
    ).toEqual(['CS0000000071', 'CS0000000072']);
    expect(h.controller.scan.state().results[0]?.score).toBe(6);
  });

  it('剩余分页多于当前候选的行不再翻页，由库存确认把关', async () => {
    // 5 个账号有蝴蝶刀；250 个账号有 AK（3 页）
    const accounts = [
      ...Array.from({ length: 5 }, (_, i) =>
        acc(`CS1${String(i).padStart(9, '0')}`, [BFLY_DOPPLER, AK]),
      ),
      ...Array.from({ length: 245 }, (_, i) => acc(`CS2${String(i).padStart(9, '0')}`, [AK])),
    ];
    const f = new FakePlatform(accounts);
    const h = await run(
      f,
      cond([
        { categoryIds: ['w:蝴蝶刀'], names: [] },
        { categoryIds: ['w:AK-47'], names: [] },
      ]),
    );
    expect(h.controller.scan.state().results).toHaveLength(5);
    // 蝴蝶刀 1 页 + AK 第 1 页；AK 剩余 2 页 < 候选 5，继续翻页取交集
    expect(f.count('/rent/account/search')).toBe(4);

    const f2 = new FakePlatform(accounts.slice(0, 1).concat(accounts.slice(5)));
    const h2 = await run(
      f2,
      cond([
        { categoryIds: ['w:蝴蝶刀'], names: [] },
        { categoryIds: ['w:AK-47'], names: [] },
      ]),
    );
    expect(h2.controller.scan.state().results).toHaveLength(1);
    // 候选只有 1 个，AK 剩余 2 页不再翻
    expect(f2.count('/rent/account/search')).toBe(2);
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

describe('内置常用方案写入', () => {
  it('首次列出时写入一次；删除后不再补回；v1 旧方案读取时升级', async () => {
    const h = await createHarness({ accounts: 2 });
    const first = await h.controller.handle('filters.list', undefined);
    const builtin = first.find((p) => p.name === BUILTIN_FILTER_PRESETS[0]?.name);
    expect(builtin?.conditions.items).toHaveLength(6);
    expect(builtin?.summary).toContain('蝴蝶刀/爪子刀/锯齿爪刀/M9 刺刀 + 任意手套 + AK-47');
    // 再次列出不重复写入
    expect(await h.controller.handle('filters.list', undefined)).toHaveLength(first.length);
    await h.controller.handle('filters.delete', { id: builtin?.id ?? '' });
    expect(
      (await h.controller.handle('filters.list', undefined)).some((p) => p.id === builtin?.id),
    ).toBe(false);
    expect(await h.controller.handle('filters.list', undefined)).toHaveLength(first.length - 1);

    // 直接写入一条 v1 格式方案
    const profileId = h.controller.auth.profileId() ?? '';
    await h.db.call('filters.save', {
      profileId,
      id: 'legacy',
      name: '旧方案',
      conditionsJson: JSON.stringify({
        items: [{ categoryId: 'w:M4A1 消音型', name: '印花集' }],
        rentKind: 'HOUR',
        priceMin: null,
        priceMax: null,
        couponOnly: false,
      }),
      schemaVersion: 1,
      overwriteId: null,
      now: 1,
    });
    const legacy = (await h.controller.handle('filters.list', undefined)).find(
      (p) => p.id === 'legacy',
    );
    expect(legacy?.conditions.items).toEqual([
      { categoryIds: ['w:M4A1 消音版'], names: ['印花集'] },
    ]);
    await h.close();
  });
});
