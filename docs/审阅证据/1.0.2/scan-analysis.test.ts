// 临时离线诊断：调用现有服务和虚拟平台，记录请求顺序，不连接真实平台。
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { type FakeAccount, FakePlatform } from '../../../src/main/preview/fake-platform';
import { BUILTIN_FILTER_PRESETS } from '../../../src/shared/builtin-presets';
import { createHarness, waitFor } from '../../../tests/helpers';

const evidence: Record<string, unknown> = {};
const conditions = BUILTIN_FILTER_PRESETS[0]!.conditions;
const searchPath = '/rent/account/search';
const inventoryPath = '/rent/account/inventory/display/info';
const detailPath = '/rent/account/get_info';

function fullKit(i: number): FakeAccount {
  const knife = ['蝴蝶刀', '爪子刀', '锯齿爪刀', 'M9 刺刀'][i % 4];
  const items = [
    [`${knife}（★） | 多普勒 (崭新出厂)`, '匕首'],
    ['运动手套（★） | 潘多拉之盒 (略有磨损)', '手套'],
    ['AK-47 | 红线 (久经沙场)', '步枪'],
    ['M4A1消音版 | 印花集 (久经沙场)', '步枪'],
    ['USP消音版 | 枪响人亡 (久经沙场)', '手枪'],
    ['格洛克18型 | 水灵 (崭新出厂)', '手枪'],
  ];
  return {
    accountNo: `CS${String(i).padStart(10, '0')}`,
    tags: ['离线诊断'], value: '1000',
    prices: { hour: '5', day: '50', week: '0', morning: '0', noon: '0', evening: '0' },
    rentType: [1, 2], rentPeriod: 1,
    weekRange: { morning: [], noon: [], evening: [] },
    shelfStatus: 1, rentStatus: 0, expireTime: '0',
    useCoupon: 1, platformCouponConfig: 1,
    durations: { hour: [1, 2, 3], day: [1], week: [] },
    inventory: items.map(([marketName, firstType]) => ({
      marketName: marketName!, firstType: firstType!, price: '100',
      rarity: 6, rarityName: '隐秘', nameColor: 'eb4b4b',
      exteriorName: '崭新出厂', wear: '0.01',
    })),
  };
}

afterAll(() => {
  mkdirSync('.validation', { recursive: true });
  writeFileSync('.validation/search-review-replay.json', JSON.stringify(evidence, null, 2));
});

describe('搜索专项离线取证', () => {
  it('记录 400 个高度重叠候选的冷启动、缓存复用和首次推送阶段', async () => {
    const fake = new FakePlatform(Array.from({ length: 400 }, (_, i) => fullKit(i)));
    const h = await createHarness({ fake });
    fake.latencyMs = 1;
    const run = async () => {
      fake.requests.length = 0;
      let firstNonemptyEvent: unknown = null;
      let candidatePhaseNonempty = false;
      const off = h.controller.subscribe((event) => {
        if (event.type !== 'scan') return;
        if (event.payload.phase === 'CANDIDATES' && event.payload.results.length > 0)
          candidatePhaseNonempty = true;
        if (firstNonemptyEvent == null && event.payload.results.length > 0)
          firstNonemptyEvent = {
            phase: event.payload.phase,
            results: event.payload.results.length,
            confirmed: event.payload.confirmed,
          };
      });
      h.controller.scan.start(conditions);
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE', 20_000);
      off();
      const firstInventoryIndex = fake.requests.findIndex((r) => r.path === inventoryPath);
      const firstDetailIndex = fake.requests.findIndex((r) => r.path === detailPath);
      return {
        results: h.controller.scan.state().results.length,
        searchRequests: fake.count(searchPath),
        inventoryRequests: fake.count(inventoryPath),
        detailRequests: fake.count(detailPath),
        searchesBeforeFirstInventory: firstInventoryIndex < 0 ? null :
          fake.requests.slice(0, firstInventoryIndex).filter((r) => r.path === searchPath).length,
        firstDetailIndex,
        candidatePhaseNonempty,
        firstNonemptyEvent,
      };
    };
    try {
      const cold = await run();
      const warm = await run();
      evidence.correlated400 = { cold, warm, syntheticRateLimit: 1_000_000 };
      expect(cold.searchRequests).toBe(20);
      expect(cold.inventoryRequests).toBe(400);
      expect(cold.detailRequests).toBe(400);
      expect(cold.searchesBeforeFirstInventory).toBe(20);
      expect(cold.firstNonemptyEvent).toMatchObject({ phase: 'VERIFYING' });
      expect(warm.searchRequests).toBe(20);
      expect(warm.inventoryRequests).toBe(0);
      expect(warm.detailRequests).toBe(0);
      expect(warm.candidatePhaseNonempty).toBe(false);
    } finally { await h.close(); }
  });

  it('重放“格洛克”返回零的契约差异，检查现有方案是否提前判空', async () => {
    const fake = new FakePlatform([fullKit(0)]);
    const original = fake.post.bind(fake);
    fake.post = async (url, body, headers, signal) => {
      const response = await original(url, body, headers, signal);
      if (url.endsWith(searchPath) && JSON.parse(body).searchContent === '格洛克') {
        const value = JSON.parse(await response.text());
        value.data.total = '0';
        value.data.list = [];
        return { ...response, text: async () => JSON.stringify(value) };
      }
      return response;
    };
    const h = await createHarness({ fake });
    try {
      fake.requests.length = 0;
      h.controller.scan.start(conditions);
      await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
      evidence.zeroKeywordReplay = {
        actualMatchingAccountsInFixture: 1,
        returnedResults: h.controller.scan.state().results.length,
        incomplete: h.controller.scan.state().incomplete,
        searchRequests: fake.count(searchPath),
        inventoryRequests: fake.count(inventoryPath),
      };
      expect(h.controller.scan.state().results).toHaveLength(0);
      expect(h.controller.scan.state().incomplete).toBe(false);
    } finally { await h.close(); }
  });

  it('候选阶段停止再继续时，检查第一页是否重取', async () => {
    const fake = new FakePlatform(Array.from({ length: 400 }, (_, i) => fullKit(i)));
    const h = await createHarness({ fake });
    try {
      fake.requests.length = 0;
      fake.latencyMs = 15;
      h.controller.scan.start(conditions);
      await waitFor(() => fake.count(searchPath) >= 3);
      h.controller.scan.stop();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const beforeResume = fake.count(searchPath);
      h.controller.scan.continue();
      await waitFor(() => fake.count(searchPath) >= beforeResume + 2);
      h.controller.scan.stop();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const searches = fake.requests.filter((r) => r.path === searchPath);
      evidence.candidateResume = {
        beforeResume,
        before: searches.slice(0, beforeResume).map((r) => r.body),
        after: searches.slice(beforeResume).map((r) => r.body),
      };
      expect(searches[beforeResume]?.body).toMatchObject({ searchContent: '蝴蝶刀', page: 1 });
    } finally { await h.close(); }
  });
});
