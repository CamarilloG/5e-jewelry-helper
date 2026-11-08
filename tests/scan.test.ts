// 筛选扫描：完整库存确认、同件约束、交集、空交集提前结束、分页去重、缺页不完整、缓存、停止/继续、迟到响应。
import { describe, expect, it } from 'vitest';
import { Priority } from '../src/main/platform/queue';
import { type FakeAccount, FakePlatform } from '../src/main/preview/fake-platform';
import { BUILTIN_FILTER_PRESETS } from '../src/shared/builtin-presets';
import { categorySupportsFastPath, resetDowngradedEvidence } from '../src/shared/catalog';
import { type FilterConditions, partitionResultsForFilter } from '../src/shared/dto';
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

  it('含皮肤或未认证类别时确认完整库存；已认证纯类别走搜索证据快速路径（A3 R04）', async () => {
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
    // 1. 已认证纯类别行：走搜索证据快速路径，0 次库存请求，score/hitCount 为 null
    const hFast = await run(f, cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
    expect(hFast.controller.scan.state().results).toHaveLength(1);
    expect(hFast.controller.scan.state().results[0]?.evidence).toBe('search');
    expect(hFast.controller.scan.state().results[0]?.hitCount).toBeNull();
    expect(f.count('/rent/account/inventory/display/info')).toBe(0);

    // 2. 含皮肤名称（同件约束）：必须读取完整库存确认；第 6 件不在展示位也能命中
    hFast.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]));
    await waitFor(() => hFast.controller.scan.state().phase === 'COMPLETE');
    expect(hFast.controller.scan.state().results).toHaveLength(1);
    expect(hFast.controller.scan.state().results[0]?.evidence).toBe('inventory');
    expect(hFast.controller.scan.state().results[0]?.hitCount).toBe(1);
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
    h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]));
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    expect(f.count('/rent/account/inventory/display/info')).toBe(1);
    await h.db.call('cache.clear', undefined);
    h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]));
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
    // 格洛克18型 覆盖不完整：不能用其搜索结果求交，也不走快速路径；候选来自其余 5 个覆盖已认证的行，
    // 逐个读完整库存确认（71/72/73 三个候选，73 缺格洛克被库存确认排除）
    const searched = f.requests
      .filter((r) => r.path === '/rent/account/search')
      .map((r) => (r.body as { searchContent?: string }).searchContent);
    expect(searched).not.toContain('格洛克18型');
    expect(f.count('/rent/account/inventory/display/info')).toBe(3);
    const r71 = h.controller.scan
      .state()
      .results.find((r) => r.account.accountNo === 'CS0000000071');
    expect(r71?.evidence).toBe('inventory');
    expect(r71?.score).toBe(6);
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

function fullKit(i: number): FakeAccount {
  const knife = ['蝴蝶刀', '爪子刀', '锯齿爪刀', 'M9 刺刀'][i % 4];
  const items: [string, string][] = [
    [`${knife}（★） | 多普勒 (崭新出厂)`, '匕首'],
    ['运动手套（★） | 潘多拉之盒 (略有磨损)', '手套'],
    ['AK-47 | 红线 (久经沙场)', '步枪'],
    ['M4A1消音版 | 印花集 (久经沙场)', '步枪'],
    ['USP消音版 | 枪响人亡 (久经沙场)', '手枪'],
    ['格洛克18型 | 水灵 (崭新出厂)', '手枪'],
  ];
  return acc(`CS${String(i).padStart(10, '0')}`, items, { tags: ['离线诊断'] });
}

describe('1.0.2 审阅证据回归夹具迁移 (scan-analysis)', () => {
  const searchPath = '/rent/account/search';
  const inventoryPath = '/rent/account/inventory/display/info';
  const detailPath = '/rent/account/get_info';
  const presetConditions = BUILTIN_FILTER_PRESETS[0]?.conditions ?? cond([]);
  // 全部为覆盖已认证类别的方案（默认方案去掉格洛克 18 型一行），用于验证搜索证据快速路径
  const certifiedConditions = cond(
    presetConditions.items.filter((row) => !row.categoryIds.includes('w:格洛克 18 型')),
  );

  it('400 个高度重叠候选（全认证类别）：冷启动走快速路径免全量库存、流式推送首条；热启动命中 5 分钟缓存', async () => {
    const fake = new FakePlatform(Array.from({ length: 400 }, (_, i) => fullKit(i)));
    const h = await createHarness({ fake });
    fake.latencyMs = 1;
    try {
      fake.requests.length = 0;
      let firstNonemptyEvent: { phase: string; results: number } | null = null;
      const off = h.controller.subscribe((event) => {
        if (event.type !== 'scan') return;
        if (firstNonemptyEvent == null && event.payload.results.length > 0) {
          firstNonemptyEvent = {
            phase: event.payload.phase,
            results: event.payload.results.length,
          };
        }
      });
      h.controller.scan.start(certifiedConditions);
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE', 20_000);
      off();
      // 快速路径：不读取全量库存
      expect(fake.count(inventoryPath)).toBe(0);
      expect(h.controller.scan.state().results).toHaveLength(400);
      expect(firstNonemptyEvent).not.toBeNull();
      // 首次结果在全部详情读完前已流式推送
      expect(fake.count(detailPath)).toBe(400);

      // 热启动：5 分钟分页缓存生效 + 本地快照先返回，0 次重新搜索
      fake.requests.length = 0;
      let immediateLocalResults = 0;
      const offWarm = h.controller.subscribe((event) => {
        if (
          event.type === 'scan' &&
          immediateLocalResults === 0 &&
          event.payload.results.length > 0
        ) {
          immediateLocalResults = event.payload.results.length;
        }
      });
      h.controller.scan.start(certifiedConditions);
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE', 20_000);
      offWarm();
      expect(immediateLocalResults).toBe(400);
      expect(fake.count(searchPath)).toBe(0);
      expect(fake.count(inventoryPath)).toBe(0);
      expect(h.controller.scan.state().snapshotAt).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it('重放真实平台关键词契约差异（格洛克/加利尔 返回 0，格洛克18型 漏召回带空格命名），内置方案不误判为空也不漏账号', async () => {
    // 第二个账号的格洛克按带空格命名，真实平台搜「格洛克18型」召回不到它（契约回放同样如此）
    const spacedGlock = fullKit(1);
    spacedGlock.inventory = spacedGlock.inventory.map((it) =>
      it.marketName.startsWith('格洛克18型')
        ? { ...it, marketName: '格洛克 18 型 | 水灵 (崭新出厂)' }
        : it,
    );
    const fake = new FakePlatform([fullKit(0), spacedGlock]);
    fake.contractReplayMode = true;
    const h = await createHarness({ fake });
    try {
      fake.requests.length = 0;
      h.controller.scan.start(presetConditions);
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(
        h.controller.scan
          .state()
          .results.map((r) => r.account.accountNo)
          .sort(),
      ).toEqual(['CS0000000000', 'CS0000000001']);
      expect(h.controller.scan.state().incomplete).toBe(false);
      // 格洛克 18 型覆盖不完整：既不发送返回 0 的「格洛克」，也不用「格洛克18型」的搜索集合排除账号
      const searchedKeywords = fake.requests
        .filter((r) => r.path === searchPath)
        .map((r) => (r.body as { searchContent?: string }).searchContent);
      expect(searchedKeywords).not.toContain('格洛克');
      expect(searchedKeywords).not.toContain('格洛克18型');
      expect(h.controller.scan.state().results.every((r) => r.evidence === 'inventory')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('候选阶段停止再继续时，已完成的第 1 页不重复请求', async () => {
    const fake = new FakePlatform(Array.from({ length: 400 }, (_, i) => fullKit(i)));
    const h = await createHarness({ fake });
    try {
      fake.requests.length = 0;
      fake.latencyMs = 15;
      h.controller.scan.start(presetConditions);
      await waitFor(() => fake.count(searchPath) >= 2);
      h.controller.scan.stop();
      await waitFor(() => h.controller.scan.state().phase === 'STOPPED');
      const beforeResume = fake.count(searchPath);
      const firstBatch = fake.requests
        .filter((r) => r.path === searchPath)
        .map(
          (r) =>
            `${(r.body as { searchContent?: string }).searchContent}:${(r.body as { page?: number }).page}`,
        );
      expect(firstBatch[0]).toBe('蝴蝶刀:1');

      h.controller.scan.continue();
      await waitFor(() => fake.count(searchPath) >= beforeResume + 1);
      h.controller.scan.stop();
      await waitFor(() => h.controller.scan.state().phase === 'STOPPED');
      const afterBatch = fake.requests
        .filter((r) => r.path === searchPath)
        .slice(beforeResume)
        .map(
          (r) =>
            `${(r.body as { searchContent?: string }).searchContent}:${(r.body as { page?: number }).page}`,
        );
      expect(afterBatch).not.toContain('蝴蝶刀:1');
    } finally {
      await h.close();
    }
  });
});

describe('A5/R05 流式输出与默认“仅可租”下的状态待确认分组', () => {
  it('后续页与详情接口挂住时，已命中的首条结果立即可见并归入默认筛选的“状态待确认”区域', async () => {
    const accounts = Array.from({ length: 65 }, (_, i) =>
      acc(`CS9${String(i).padStart(9, '0')}`, [BFLY_DOPPLER]),
    );
    const fake = new FakePlatform(accounts);
    const originalPost = fake.post.bind(fake);
    let releaseHung: () => void = () => {};
    const hungPromise = new Promise<void>((resolve) => {
      releaseHung = resolve;
    });
    fake.post = async (url, body, headers, signal) => {
      const parsed = JSON.parse(body || '{}') as { page?: number };
      if (
        url.endsWith('/rent/account/get_info') ||
        (url.endsWith('/rent/account/search') && (parsed.page ?? 1) >= 2)
      ) {
        await Promise.race([
          hungPromise,
          new Promise<void>((_, reject) =>
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          ),
        ]);
      }
      return originalPost(url, body, headers, signal);
    };
    const h = await createHarness({ fake });
    try {
      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
      await waitFor(() => h.controller.scan.state().results.length > 0, 5_000);
      const stateWhileHung = h.controller.scan.state();
      expect(stateWhileHung.results.length).toBeGreaterThanOrEqual(50);
      expect(stateWhileHung.results[0]?.account.status).toBe('UNKNOWN');

      // 界面层默认筛选“AVAILABLE”（仅可租）下，状态待确认分组可见
      const partitioned = partitionResultsForFilter(
        stateWhileHung.results,
        'PRICE_ASC',
        'AVAILABLE',
        'HOUR',
      );
      expect(partitioned.pendingResults.length).toBeGreaterThanOrEqual(50);
      expect(partitioned.mainResults).toHaveLength(0);

      releaseHung();
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE', 15_000);
      const afterComplete = partitionResultsForFilter(
        h.controller.scan.state().results,
        'PRICE_ASC',
        'AVAILABLE',
        'HOUR',
      );
      expect(afterComplete.pendingResults).toHaveLength(0);
      expect(afterComplete.mainResults).toHaveLength(65);
    } finally {
      releaseHung();
      await h.close();
    }
  });
});

describe('A2/R03 零结果回退与候选来源不可用', () => {
  it('未完成覆盖认证的大类返回 0 时，自动回退空关键词浏览+完整库存核验，不漏掉匹配账号', async () => {
    const galilItem: [string, string] = ['加利尔 AR | 彩绘 (崭新出厂)', '步枪'];
    const fake = new FakePlatform([acc('CS0000000088', [galilItem])]);
    // 启用真实契约回放（加利尔AR 不命中带空格的“加利尔 AR”），验证回退到空关键词浏览+库存核验
    fake.contractReplayMode = true;
    const h = await createHarness({ fake });
    try {
      h.controller.scan.start(cond([{ categoryIds: ['w:加利尔 AR'], names: [] }]));
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(h.controller.scan.state().results.map((r) => r.account.accountNo)).toEqual([
        'CS0000000088',
      ]);
      expect(h.controller.scan.state().results[0]?.evidence).toBe('inventory');
    } finally {
      await h.close();
    }
  });

  it('所有候选来源请求全部失败时，标记候选来源不可用与结果不完整，不伪装成正常空结果', async () => {
    const fake = new FakePlatform([acc('CS0000000089', [BFLY_DOPPLER])]);
    fake.failNext(
      '/rent/account/search',
      { kind: 'business', code: 500, message: '服务暂不可用' },
      999,
    );
    const h = await createHarness({ fake });
    try {
      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
      await waitFor(() => ['COMPLETE', 'FAILED'].includes(h.controller.scan.state().phase));
      const st = h.controller.scan.state();
      expect(st.incomplete).toBe(true);
      expect(st.coverageComplete).toBe(false);
      expect(st.emptyReason).toBe('SOURCE_UNAVAILABLE');
      expect(st.partialReasons).toContain('候选来源不可用');
    } finally {
      await h.close();
    }
  });

  it('平台货架返回 0 时，本地已收藏的匹配账号仍通过库存核验返回', async () => {
    const fake = new FakePlatform([acc('CS0000000090', [BFLY_DOPPLER], { shelfStatus: 0 })]);
    const h = await createHarness({ fake });
    try {
      await h.controller.handle('favorites.add', { accountNo: 'CS0000000090' });
      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(h.controller.scan.state().results.map((r) => r.account.accountNo)).toEqual([
        'CS0000000090',
      ]);
    } finally {
      await h.close();
    }
  });
});

describe('A3/R04 快速路径反例降级', () => {
  it('按需读取完整库存发现反例时，立即撤销该账号匹配并将对应关键词降级为未认证', async () => {
    // 构造一个假阳性账号：实际只有格洛克，但让搜索接口对“USP消音版”错返该账号
    const glockOnly: [string, string] = ['格洛克18型 | 水灵 (崭新出厂)', '手枪'];
    const fake = new FakePlatform([acc('CS0000000091', [glockOnly])]);
    const orig = fake.post.bind(fake);
    fake.post = async (url, body, headers, signal) => {
      if (url.endsWith('/rent/account/search')) {
        const parsed = JSON.parse(body) as { searchContent?: string };
        if (parsed.searchContent === 'USP消音版') {
          return orig(url, JSON.stringify({ ...parsed, searchContent: '' }), headers, signal);
        }
      }
      return orig(url, body, headers, signal);
    };
    const h = await createHarness({ fake });
    try {
      expect(categorySupportsFastPath('w:USP 消音版')).toBe(true);
      h.controller.scan.start(cond([{ categoryIds: ['w:USP 消音版'], names: [] }]));
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(h.controller.scan.state().results).toHaveLength(1);
      expect(h.controller.scan.state().results[0]?.evidence).toBe('search');

      // 用户点开详情读取完整库存：发现反例，撤销匹配并降级关键词
      await h.controller.handle('account.inventory', { accountNo: 'CS0000000091', refresh: false });
      expect(h.controller.scan.state().results).toHaveLength(0);
      expect(categorySupportsFastPath('w:USP 消音版')).toBe(false);
    } finally {
      resetDowngradedEvidence();
      await h.close();
    }
  });
});

describe('A6/R07 五分钟分页缓存、刷新最新与规则版本', () => {
  it('第 1 页命中缓存、第 2 页缺失时只补拉第 2 页；forceRefresh 强制重拉并更新快照时间', async () => {
    const accounts = Array.from({ length: 120 }, (_, i) =>
      acc(`CS8${String(i).padStart(9, '0')}`, [BFLY_DOPPLER]),
    );
    const fake = new FakePlatform(accounts);
    const h = await createHarness({ fake });
    try {
      // 让第 1 页正常返回并写入缓存，在请求第 2 页时挂起并停止扫描
      let holdPage2 = true;
      let releasePage2: () => void = () => {};
      const page2Gate = new Promise<void>((resolve) => {
        releasePage2 = resolve;
      });
      const orig = fake.post.bind(fake);
      fake.post = async (url, body, headers, signal) => {
        if (url.endsWith('/rent/account/search')) {
          const parsed = JSON.parse(body) as { page?: number };
          if (parsed.page === 2 && holdPage2) {
            await page2Gate;
          }
        }
        return orig(url, body, headers, signal);
      };

      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
      await waitFor(() => h.controller.scan.state().results.length >= 100);
      h.controller.scan.stop();
      await waitFor(() => h.controller.scan.state().phase === 'STOPPED');
      holdPage2 = false;
      releasePage2();
      await waitFor(() => !h.controller.queue.stats().active);

      // 再次启动相同条件：第 1 页命中缓存，只补拉第 2 页
      fake.requests.length = 0;
      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      const pagesFetched = fake.requests
        .filter((r) => r.path === '/rent/account/search')
        .map((r) => (r.body as { page?: number }).page);
      expect(pagesFetched).toEqual([2]);

      // 点击“刷新最新”(forceRefresh: true)：忽略缓存重拉全部页
      fake.requests.length = 0;
      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]), {
        forceRefresh: true,
      });
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(fake.count('/rent/account/search')).toBe(2);

      // 规则版本升级后旧缓存自动失效
      fake.requests.length = 0;
      h.controller.scan.setRuleVersionForTest('v-next-test');
      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(fake.count('/rent/account/search')).toBe(2);
    } finally {
      await h.close();
    }
  });
});

describe('B1/B2/B3/B4 本地缓存优先、离线匹配、小条件变化与在途请求合并', () => {
  it('B1: 增量合并在复核确认不匹配时移除旧账号；复核请求失败时保留并标记 reverifyFailed', async () => {
    const fake = new FakePlatform([
      acc('CS0000000071', [BFLY_DOPPLER]),
      acc('CS0000000072', [BFLY_DOPPLER]),
    ]);
    const h = await createHarness({ fake });
    try {
      const c = cond([{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]);
      h.controller.scan.start(c);
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(h.controller.scan.state().results).toHaveLength(2);

      // 修改 CS0000000071 库存使其不再匹配，同时让 CS0000000072 详情请求返回业务失败
      const target71 = fake.accounts.find((a) => a.accountNo === 'CS0000000071');
      if (target71) target71.inventory = [];
      const orig = fake.post.bind(fake);
      fake.post = async (url, body, headers, signal) => {
        if (url.endsWith('/rent/account/get_info') && body.includes('CS0000000072')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                status: false,
                code: 500,
                message: '详情暂不可用',
                data: null,
                timestamp: 1,
                traceId: '0'.repeat(32),
                success: false,
                errcode: 500,
              }),
            header: () => null,
          };
        }
        return orig(url, body, headers, signal);
      };

      h.controller.scan.start(c, { forceRefresh: true });
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      const results = h.controller.scan.state().results;
      expect(results.find((r) => r.account.accountNo === 'CS0000000071')).toBeUndefined();
      const kept72 = results.find((r) => r.account.accountNo === 'CS0000000072');
      expect(kept72).toBeDefined();
      expect(kept72?.reverifyFailed).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('B2: 离线状态下本地匹配可用，状态标记为历史/待确认；无本地缓存时提示 NO_LOCAL_RECORDS', async () => {
    const fake = new FakePlatform([acc('CS0000000075', [BFLY_DOPPLER])]);
    const h = await createHarness({ fake });
    try {
      // 首次空库本地匹配 -> NO_LOCAL_RECORDS
      await h.controller.handle('scan.startLocal', {
        conditions: cond([{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]),
        presetId: null,
      });
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(h.controller.scan.state().emptyReason).toBe('NO_LOCAL_RECORDS');

      // 产生一条详情快照、库存缓存与收藏摘要后进入离线
      await h.controller.handle('account.detail', { accountNo: 'CS0000000075', refresh: false });
      await h.controller.handle('favorites.add', { accountNo: 'CS0000000075' });
      await h.controller.handle('account.inventory', { accountNo: 'CS0000000075', refresh: false });
      h.controller.auth.markExpired();

      fake.requests.length = 0;
      await h.controller.handle('scan.startLocal', {
        conditions: cond([{ categoryIds: ['w:蝴蝶刀'], names: ['多普勒'] }]),
        presetId: null,
      });
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      const localState = h.controller.scan.state();
      expect(fake.requests).toHaveLength(0);
      expect(localState.localOnly).toBe(true);
      expect(localState.results).toHaveLength(1);
      expect(localState.results[0]?.account.accountNo).toBe('CS0000000075');
      expect(localState.results[0]?.stale).toBe(true);
      expect(localState.results[0]?.account.status).toBe('UNKNOWN');
    } finally {
      await h.close();
    }
  });

  it('B3: 在完整快照上收紧价格区间直接同步过滤子集，不重发搜索请求', async () => {
    const fake = new FakePlatform([
      acc('CS0000000076', [BFLY_DOPPLER], {
        prices: { hour: '4.00', day: '40.00', week: '0', morning: '0', noon: '0', evening: '0' },
      }),
      acc('CS0000000077', [BFLY_DOPPLER], {
        prices: { hour: '8.00', day: '80.00', week: '0', morning: '0', noon: '0', evening: '0' },
      }),
    ]);
    const h = await createHarness({ fake });
    try {
      h.controller.scan.start(
        cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }], { priceMax: '10.00' }),
      );
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(h.controller.scan.state().results).toHaveLength(2);

      // 收紧 priceMax 到 5.00：复用完整快照过滤，0 次搜索请求
      fake.requests.length = 0;
      h.controller.scan.start(
        cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }], { priceMax: '5.00' }),
      );
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      expect(fake.count('/rent/account/search')).toBe(0);
      expect(h.controller.scan.state().results.map((r) => r.account.accountNo)).toEqual([
        'CS0000000076',
      ]);
    } finally {
      await h.close();
    }
  });

  it('B4: 同账号同接口在途请求合并，单侧取消不影响另一侧消费者', async () => {
    const fake = new FakePlatform([acc('CS0000000078', [BFLY_DOPPLER])]);
    fake.latencyMs = 40;
    const h = await createHarness({ fake });
    try {
      fake.requests.length = 0;
      const p1 = h.controller.accounts.inventory('CS0000000078', {
        priority: Priority.SCAN,
        group: 'scan:c1',
      });
      const p2 = h.controller.accounts.inventory('CS0000000078', {
        priority: Priority.USER,
        group: 'user:c2',
      });
      h.controller.queue.cancelGroup('scan:c1');
      await expect(p1).rejects.toThrow();
      const res2 = await p2;
      expect(res2.items).toHaveLength(1);
      expect(fake.count('/rent/account/inventory/display/info')).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('A7/R14 覆盖完整性原因与失败页重试', () => {
  it('提前遇到空页、重复页分别标记对应 partialReasons；失败页可通过 retryFailed 单独重试补齐', async () => {
    const accounts = Array.from({ length: 120 }, (_, i) =>
      acc(`CS7${String(i).padStart(9, '0')}`, [BFLY_DOPPLER]),
    );
    const fake = new FakePlatform(accounts);
    // 第 2 页首次失败
    let failPage2Once = true;
    const orig = fake.post.bind(fake);
    fake.post = async (url, body, headers, signal) => {
      if (url.endsWith('/rent/account/search')) {
        const parsed = JSON.parse(body) as { page?: number };
        if (parsed.page === 2 && failPage2Once) {
          failPage2Once = false;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                status: false,
                code: 500,
                message: '分页暂不可用',
                data: null,
                timestamp: 1,
                traceId: '0'.repeat(32),
                success: false,
                errcode: 500,
              }),
            header: () => null,
          };
        }
      }
      return orig(url, body, headers, signal);
    };
    const h = await createHarness({ fake });
    try {
      h.controller.scan.start(cond([{ categoryIds: ['w:蝴蝶刀'], names: [] }]));
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      const st1 = h.controller.scan.state();
      expect(st1.coverageComplete).toBe(false);
      expect(st1.partialReasons).toContain('缺页');
      expect(st1.failedPages).toHaveLength(1);
      expect(st1.results).toHaveLength(100);

      // 重试失败页后补齐全部 120 个账号，覆盖变为完整
      h.controller.scan.retryFailed();
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      const st2 = h.controller.scan.state();
      expect(st2.failedPages).toHaveLength(0);
      expect(st2.coverageComplete).toBe(true);
      expect(st2.results).toHaveLength(120);
    } finally {
      await h.close();
    }
  });
});

describe('1.0.2 端到端实测修复：覆盖证据约束求交、按成本翻页与候选阶段提前确认', () => {
  const searchPath = '/rent/account/search';
  const inventoryPath = '/rent/account/inventory/display/info';
  const AK_ITEM: [string, string] = ['AK-47 | 红线 (久经沙场)', '步枪'];
  const searchedPages = (f: FakePlatform) =>
    f.requests
      .filter((r) => r.path === searchPath)
      .map((r) => {
        const b = r.body as { searchContent?: string; page?: number };
        return `${b.searchContent}:${b.page}`;
      });

  it('剩余分页多于预计可排除的候选时不翻页：按全量账号数估算排除比例', async () => {
    // 1000 个账号，其中 950 个有 AK（10 页）；40 个有多普勒蝴蝶刀且都有 AK
    const accounts = Array.from({ length: 1000 }, (_, i) => {
      const items: [string, string][] = [];
      if (i < 40) items.push(BFLY_DOPPLER);
      if (i < 950) items.push(AK_ITEM);
      else items.push(GLOVE);
      return acc(`CS${String(i).padStart(10, '0')}`, items);
    });
    const f = new FakePlatform(accounts);
    const h = await run(
      f,
      cond([
        { categoryIds: [], names: ['多普勒'] },
        { categoryIds: ['w:AK-47'], names: [] },
      ]),
    );
    const pages = searchedPages(f);
    // AK 行只取第 1 页探测规模：翻完需 9 页，预计只能排除 40 × (1 − 950/1000) = 2 个候选
    expect(pages.filter((p) => p.startsWith('AK:'))).toEqual(['AK:1']);
    expect(pages).toContain(':1'); // 空关键词第 1 页取全量账号数
    expect(f.count(inventoryPath)).toBe(40);
    expect(h.controller.scan.state().results).toHaveLength(40);
    await h.close();
  });

  it('能排除大量候选的行仍然翻页求交', async () => {
    // 1000 个账号，300 个有手套（3 页）；40 个多普勒账号里只有 10 个有手套
    const accounts = Array.from({ length: 1000 }, (_, i) => {
      const items: [string, string][] = [];
      if (i < 40) items.push(BFLY_DOPPLER);
      if ((i >= 30 && i < 330) || i >= 2000) items.push(GLOVE);
      else items.push(AK_ITEM);
      return acc(`CS${String(i).padStart(10, '0')}`, items);
    });
    const f = new FakePlatform(accounts);
    const h = await run(
      f,
      cond([
        { categoryIds: [], names: ['多普勒'] },
        { categoryIds: ['f:手套'], names: [] },
      ]),
    );
    expect(searchedPages(f).filter((p) => p.startsWith('手套:'))).toEqual([
      '手套:1',
      '手套:2',
      '手套:3',
    ]);
    expect(f.count(inventoryPath)).toBe(10);
    expect(h.controller.scan.state().results).toHaveLength(10);
    await h.close();
  });

  it('覆盖不完整的行不参与求交：格洛克带空格命名的账号不会被搜索集合排除', async () => {
    const SPACED: [string, string] = ['格洛克 18 型 | 水灵 (崭新出厂)', '手枪'];
    const COMPACT: [string, string] = ['格洛克18型 | 水灵 (崭新出厂)', '手枪'];
    const f = new FakePlatform([
      acc('CS0000000801', [AK_ITEM, COMPACT]),
      acc('CS0000000802', [AK_ITEM, SPACED]),
      acc('CS0000000803', [AK_ITEM]),
    ]);
    f.contractReplayMode = true;
    const h = await run(
      f,
      cond([
        { categoryIds: ['w:AK-47'], names: [] },
        { categoryIds: ['w:格洛克 18 型'], names: [] },
      ]),
    );
    expect(
      h.controller.scan
        .state()
        .results.map((r) => r.account.accountNo)
        .sort(),
    ).toEqual(['CS0000000801', 'CS0000000802']);
    expect(searchedPages(f).some((p) => p.startsWith('格洛克'))).toBe(false);
    expect(f.count(inventoryPath)).toBe(3);
    await h.close();
  });

  it('只有覆盖不完整的行时回退为浏览全部账号并逐个确认，提示覆盖不完整', async () => {
    const f = new FakePlatform([
      acc('CS0000000811', [['格洛克 18 型 | 水灵 (崭新出厂)', '手枪']]),
      acc('CS0000000812', [AK_ITEM]),
    ]);
    f.contractReplayMode = true;
    const h = await run(f, cond([{ categoryIds: ['w:格洛克 18 型'], names: [] }]));
    expect(h.controller.scan.state().results.map((r) => r.account.accountNo)).toEqual([
      'CS0000000811',
    ]);
    expect(h.controller.scan.state().warnings.join('')).toContain('覆盖不完整');
    await h.close();
  });

  it('后续搜索页挂住时，各来源行第 1 页都命中的账号已完成库存确认并可见', async () => {
    // 150 个账号同时有多普勒蝴蝶刀与手套（两行各 2 页）
    const accounts = Array.from({ length: 150 }, (_, i) =>
      acc(`CS7${String(i).padStart(9, '0')}`, [BFLY_DOPPLER, GLOVE]),
    );
    const f = new FakePlatform(accounts);
    const originalPost = f.post.bind(f);
    let release: () => void = () => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.post = async (url, body, headers, signal) => {
      const parsed = JSON.parse(body || '{}') as { page?: number };
      if (url.endsWith(searchPath) && (parsed.page ?? 1) >= 2) await hung;
      return originalPost(url, body, headers, signal);
    };
    const h = await createHarness({ fake: f });
    try {
      h.controller.scan.start(
        cond([
          { categoryIds: [], names: ['多普勒'] },
          { categoryIds: ['f:手套'], names: [] },
        ]),
      );
      await waitFor(() => h.controller.scan.state().results.length > 0);
      const s = h.controller.scan.state();
      expect(s.phase).toBe('CANDIDATES');
      expect(s.results[0]?.evidence).toBe('inventory');
      release();
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE', 15_000);
      expect(h.controller.scan.state().results).toHaveLength(150);
      // 提前确认过的账号不重复读库存
      expect(f.count(inventoryPath)).toBe(150);
    } finally {
      release();
      await h.close();
    }
  }, 20_000);
});
