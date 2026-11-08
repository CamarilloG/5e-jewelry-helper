// 收藏同步与监测通知：只增不删、移除恢复、写回失败待同步、快速正反操作、首次基线、可租周期、多账号合并、通知意图。
import { describe, expect, it } from 'vitest';
import { parseActivation } from '../src/main/domain/activation';
import { createHarness, waitFor } from './helpers';

async function setup(favorites: number[] = [0, 1, 2]) {
  const h = await createHarness({ accounts: 12 });
  h.fake.favorites = favorites.map((i) => h.fake.accounts[i]?.accountNo as string);
  for (const a of h.fake.accounts) {
    a.rentStatus = 1;
    a.shelfStatus = 1;
  }
  return h;
}

const nonceOf = (xml: string, action: string) => {
  const m = xml.match(new RegExp(`a=${action}&amp;n=([0-9a-f]{32})`));
  return m?.[1] ?? null;
};

describe('收藏同步', () => {
  it('首次同步导入平台收藏，监测默认开启，平台取消后本地保留并标记', async () => {
    const h = await setup();
    await h.controller.favorites.sync();
    let view = await h.controller.favorites.view();
    expect(view.items).toHaveLength(3);
    expect(view.items.every((f) => f.monitorEnabled && f.source === 'platform')).toBe(true);
    const removed = h.fake.favorites.shift() as string;
    await h.controller.favorites.sync();
    view = await h.controller.favorites.view();
    expect(view.items).toHaveLength(3);
    expect(view.items.find((f) => f.accountNo === removed)?.platformState).toBe('removed');
    // 无人触发时不会把它写回平台
    expect(h.fake.favoriteWrites).toHaveLength(0);
  });

  it('取消收藏默认只移除本地，之后同步不再加回；可恢复且恢复不写回平台', async () => {
    const h = await setup();
    await h.controller.favorites.sync();
    const no = h.fake.favorites[0] as string;
    await h.controller.handle('favorites.remove', { accountNo: no, alsoPlatform: false });
    await h.controller.favorites.sync();
    let view = await h.controller.favorites.view();
    expect(view.items.some((f) => f.accountNo === no)).toBe(false);
    expect(view.tombstones.map((t) => t.accountNo)).toEqual([no]);
    expect(h.fake.favorites).toContain(no);
    await h.controller.handle('favorites.restore', { accountNo: no });
    view = await h.controller.favorites.view();
    expect(view.items.some((f) => f.accountNo === no)).toBe(true);
    expect(h.fake.favoriteWrites).toHaveLength(0);
  });

  it('勾选同时在平台取消时写回目标状态 0', async () => {
    const h = await setup();
    await h.controller.favorites.sync();
    const no = h.fake.favorites[0] as string;
    await h.controller.handle('favorites.remove', { accountNo: no, alsoPlatform: true });
    expect(h.fake.favoriteWrites).toEqual([{ accountNo: no, status: 0 }]);
    expect(h.fake.favorites).not.toContain(no);
  });

  it('写回失败：本地立即生效、标记待同步，下轮同步重试最新意图', async () => {
    const h = await setup([]);
    const no = h.fake.accounts[5]?.accountNo as string;
    h.fake.failNext('/rent/account/favorites/update', {
      kind: 'business',
      code: 500,
      message: '失败',
    });
    const res = await h.controller.handle('favorites.add', { accountNo: no });
    expect(res.pendingSync).toBe(true);
    let view = await h.controller.favorites.view();
    expect(view.items.find((f) => f.accountNo === no)?.pendingSync).toBe(true);
    await h.controller.favorites.sync();
    view = await h.controller.favorites.view();
    expect(view.items.find((f) => f.accountNo === no)?.pendingSync).toBe(false);
    expect(h.fake.favorites).toContain(no);
  });

  it('快速正反操作：最终平台状态与最后一次用户意图一致', async () => {
    const h = await setup([]);
    const no = h.fake.accounts[6]?.accountNo as string;
    h.fake.latencyMs = 20;
    const a = h.controller.handle('favorites.add', { accountNo: no });
    await new Promise((r) => setTimeout(r, 2));
    const b = h.controller.handle('favorites.remove', { accountNo: no, alsoPlatform: true });
    await Promise.all([a, b]);
    expect(h.fake.favorites).not.toContain(no);
    expect((await h.controller.favorites.view()).items.some((f) => f.accountNo === no)).toBe(false);
    await h.controller.favorites.sync();
    expect((await h.controller.favorites.view()).items.some((f) => f.accountNo === no)).toBe(false);
  });

  it('收藏分页失败：不据不完整快照判断平台取消', async () => {
    const h = await setup();
    await h.controller.favorites.sync();
    h.fake.failNext('/rent/account/favorites/list', { kind: 'business', code: 500, message: 'x' });
    const snap = await h.controller.favorites.sync();
    expect(snap?.complete).toBe(false);
    const view = await h.controller.favorites.view();
    expect(view.items.every((f) => f.platformState === 'favorited')).toBe(true);
    expect(view.sync.ok).toBe(false);
  });
});

describe('监测与通知', () => {
  it('首轮只建立基线；租赁中 → 可租通知一次；失败恢复不重复；新周期再通知', async () => {
    const h = await setup([0]);
    const acc = h.fake.accounts[0];
    if (!acc) throw new Error('no acc');
    acc.rentStatus = 0;
    h.controller.monitor.start();
    await h.controller.monitor.runRound();
    expect(h.toasts).toHaveLength(0); // 基线时已可租也不通知
    acc.rentStatus = 1;
    await h.controller.monitor.runRound();
    acc.rentStatus = 0;
    await h.controller.monitor.runRound();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toContain('收藏账号可租了');
    expect(h.toasts[0]).toContain('先到先得，工具不代抢');
    // 读取失败 → 恢复可租：不重复
    h.fake.failNext('/rent/account/favorites/list', { kind: 'business', code: 500, message: 'x' });
    h.fake.failNext('/rent/account/get_info', { kind: 'business', code: 500, message: 'x' });
    await h.controller.monitor.runRound();
    const fav = (await h.controller.favorites.view()).items[0];
    expect(fav?.status).toBe('UNKNOWN');
    expect(fav?.trustedStatus).toBe('AVAILABLE');
    await h.controller.monitor.runRound();
    expect(h.toasts).toHaveLength(1);
    // 新周期
    acc.rentStatus = 1;
    await h.controller.monitor.runRound();
    acc.rentStatus = 0;
    await h.controller.monitor.runRound();
    expect(h.toasts).toHaveLength(2);
    h.controller.monitor.halt();
  });

  it('同一用户重启保留可信状态与已通知周期，不重放', async () => {
    const h = await setup([0]);
    const acc = h.fake.accounts[0];
    if (!acc) throw new Error('no acc');
    h.controller.monitor.start();
    await h.controller.monitor.runRound();
    acc.rentStatus = 0;
    await h.controller.monitor.runRound();
    expect(h.toasts).toHaveLength(1);
    h.controller.monitor.halt();
    // 用同一个数据库模拟重启
    const h2 = await createHarness({ db: h.db, fake: h.fake });
    h2.controller.monitor.start();
    await h2.controller.monitor.runRound();
    expect(h2.toasts).toHaveLength(0);
    h2.controller.monitor.halt();
  });

  it('同轮多个账号变可租合并为一条，只有“查看”；角标与 A/B 口径', async () => {
    const h = await setup([0, 1, 2]);
    h.controller.monitor.start();
    await h.controller.monitor.runRound();
    await h.controller.handle('favorites.setMonitor', {
      accountNo: h.fake.favorites[2] as string,
      enabled: false,
    });
    for (const a of h.fake.accounts) a.rentStatus = 0;
    await h.controller.monitor.runRound();
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]).toContain('2 个收藏账号可租了');
    expect(h.toasts[0]).not.toContain('一键出码');
    const m = h.controller.monitor.view();
    expect(m.monitored).toBe(2);
    expect(m.available).toBe(2);
    expect(m.badge).toBe(2); // 关闭监测的账号保留旧显示状态（租赁中）
    h.controller.monitor.halt();
  });

  it('通知被关闭时不提交系统通知，仍保留“新”标记', async () => {
    const h = await setup([0]);
    await h.controller.handle('settings.update', { notifications: false });
    h.controller.monitor.start();
    await h.controller.monitor.runRound();
    (h.fake.accounts[0] as { rentStatus: number }).rentStatus = 0;
    await h.controller.monitor.runRound();
    expect(h.toasts).toHaveLength(0);
    expect((await h.controller.favorites.view()).items[0]?.unseen).toBe(true);
    h.controller.monitor.halt();
  });

  it('立即检查 30 秒冷却；进行中的轮次被复用', async () => {
    const h = await setup([0]);
    h.controller.monitor.start();
    h.fake.latencyMs = 30;
    const first = h.controller.monitor.checkNow();
    expect(first.started).toBe(true);
    const second = h.controller.monitor.checkNow();
    expect(second.started).toBe(true); // 复用当前轮次
    await waitFor(() => !h.controller.monitor.view().running);
    const third = h.controller.monitor.checkNow();
    expect(third.started).toBe(false);
    expect(third.cooldownUntil).not.toBeNull();
    h.controller.monitor.halt();
  });
});

describe('通知动作与 nonce', () => {
  async function availableToast() {
    const h = await setup([0]);
    h.controller.monitor.start();
    await h.controller.monitor.runRound();
    (h.fake.accounts[0] as { rentStatus: number }).rentStatus = 0;
    await h.controller.monitor.runRound();
    h.controller.monitor.halt();
    const xml = h.toasts[0] as string;
    return { h, xml };
  }

  it('“查看”定位账号；同一 nonce 重放只能打开收藏页', async () => {
    const { h, xml } = await availableToast();
    const nav: unknown[] = [];
    h.controller.subscribe((e) => e.type === 'navigate' && nav.push(e.payload));
    const nonce = nonceOf(xml, 'view');
    expect(nonce).not.toBeNull();
    const url = `jewelry-helper://notification?v=1&a=view&n=${nonce}`;
    await h.controller.handleActivation(url);
    await h.controller.handleActivation(url);
    expect(nav[0]).toMatchObject({ page: 'FAVORITES', accountNo: h.fake.favorites[0] });
    expect(nav[1]).toEqual({ page: 'FAVORITES' });
  });

  it('“一键出码”走同一入口；无预设时要求先编辑预设，不创建订单', async () => {
    const { h, xml } = await availableToast();
    const events: unknown[] = [];
    h.controller.subscribe((e) => e.type === 'checkoutRequest' && events.push(e.payload));
    await h.controller.handle('agreement.accept', { version: '2026-11-07' });
    await h.controller.handleActivation(
      `jewelry-helper://notification?v=1&a=checkout&n=${nonceOf(xml, 'checkout')}`,
    );
    expect(events).toEqual([{ accountNo: h.fake.favorites[0], reason: 'NEEDS_PRESET' }]);
    expect(h.fake.createCount).toBe(0);
  });

  it('跨用户、伪造或格式错误的参数不能触发出码', async () => {
    const { h, xml } = await availableToast();
    h.fake.user.uuid = 'another-user';
    await h.controller.reloadAuth();
    const nav: unknown[] = [];
    h.controller.subscribe((e) => e.type === 'navigate' && nav.push(e.payload));
    await h.controller.handleActivation(
      `jewelry-helper://notification?v=1&a=checkout&n=${nonceOf(xml, 'checkout')}`,
    );
    await h.controller.handleActivation('jewelry-helper://notification?v=1&a=checkout&n=zzzz');
    await h.controller.handleActivation(
      'jewelry-helper://notification?v=1&a=checkout&n=0123456789abcdef0123456789abcdef&x=1',
    );
    expect(nav).toEqual([{ page: 'FAVORITES' }, { page: 'FAVORITES' }, { page: 'FAVORITES' }]);
    expect(h.fake.createCount).toBe(0);
    expect(h.fake.lockChecks).toBe(0);
  });

  it('激活参数解析严格校验', () => {
    expect(parseActivation(`jewelry-helper://notification?v=1&a=view&n=${'a'.repeat(32)}`)).toEqual(
      { action: 'view', nonce: 'a'.repeat(32) },
    );
    expect(parseActivation(`jewelry-helper://notification?v=2&a=view&n=${'a'.repeat(32)}`)).toBe(
      'INVALID',
    );
    expect(parseActivation(`jewelry-helper://other?v=1&a=view&n=${'a'.repeat(32)}`)).toBe(
      'INVALID',
    );
    expect(parseActivation('https://example.com')).toBeNull();
    expect(parseActivation(null)).toBeNull();
  });
});

describe('1.0.2 收藏 3×3 宫格与后台补读（R13）', () => {
  it('C4 & C5：后台补读一次完整库存生成 9 图宫格；重复读取不重取；下一轮普通同步不覆盖宫格', async () => {
    const h = await setup([0]);
    const accNo = h.fake.favorites[0] as string;
    const acc = h.fake.account(accNo);
    if (!acc) throw new Error('missing account');
    // 确保该账号有 9 件以上不同饰品
    while (acc.inventory.length < 10) {
      acc.inventory.push({
        marketName: `AK-47 | 测试皮肤${acc.inventory.length} (崭新出厂)`,
        firstType: '步枪',
        price: String(100 + acc.inventory.length),
        rarity: 5,
        rarityName: '隐秘',
        nameColor: 'eb4b4b',
        exteriorName: '崭新出厂',
        wear: '0.01',
      });
    }

    await h.controller.favorites.sync();
    // 刚同步完、尚未触发后台补读时，最多只有 5 件展示位
    const before = (await h.controller.favorites.view({ triggerBackfill: false })).items[0];
    expect(before?.summarySource).toBe('display');
    expect((before?.gridItems?.length ?? 0) <= 5).toBe(true);

    // 打开收藏页（triggerBackfill = true）触发后台补读
    await h.controller.handle('favorites.state', undefined);
    await waitFor(
      async () =>
        (await h.controller.favorites.view({ triggerBackfill: false })).items[0]?.summarySource ===
        'inventory',
    );
    const after = (await h.controller.favorites.view({ triggerBackfill: false })).items[0];
    expect(after?.gridItems).toHaveLength(9);
    expect(h.fake.count('/rent/account/inventory/display/info')).toBe(1);

    // 重复打开收藏页不会重复发送后台库存请求
    await h.controller.handle('favorites.state', undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.fake.count('/rent/account/inventory/display/info')).toBe(1);

    // C4：下一轮普通收藏同步或监测轮次不会用 5 件展示位覆盖已生成的 9 图完整宫格
    await h.controller.favorites.sync();
    await h.controller.monitor.runRound();
    const afterSync = (await h.controller.favorites.view({ triggerBackfill: false })).items[0];
    expect(afterSync?.summarySource).toBe('inventory');
    expect(afterSync?.gridItems).toHaveLength(9);
    await h.close();
  });

  it('C5：支付出码进行中暂停后台补读（Priority.BACKGROUND 与 Priority.SCAN 一并阻塞）', async () => {
    const h = await setup([0, 1]);
    const payAccNo = h.fake.accounts[2]?.accountNo as string;
    const payAcc = h.fake.account(payAccNo);
    if (payAcc) {
      payAcc.shelfStatus = 1;
      payAcc.rentStatus = 0;
      payAcc.rentPeriod = 1;
    }

    await h.controller.favorites.sync();
    await h.controller.handle('agreement.accept', { version: '2026-11-07' });

    // 启动一笔出码，使 checkout 进入 PENDING（blocksScan = true）
    const co = await h.controller.handle('checkout.start', {
      accountNo: payAccNo,
      params: { rentKind: 'HOUR', quantity: 2, payChannel: 1, autoCoupon: false },
      source: 'DETAIL',
      expectedAmountYuan: null,
    });
    expect(co.kind).toBe('STARTED');
    await waitFor(() => h.controller.checkout.view()?.state === 'PENDING');

    const invBefore = h.fake.count('/rent/account/inventory/display/info');
    // 出码进行中打开收藏页：后台补读被阻塞，不发送库存请求
    await h.controller.handle('favorites.state', undefined);
    await new Promise((r) => setTimeout(r, 40));
    expect(h.fake.count('/rent/account/inventory/display/info')).toBe(invBefore);

    // 出码结束后（如完成支付或结束），自动恢复后台补读
    h.fake.pay();
    await waitFor(() => h.controller.checkout.view()?.state === 'PAID');
    await waitFor(() => h.fake.count('/rent/account/inventory/display/info') > invBefore);
    await h.close();
  });
});
