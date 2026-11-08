// 出码状态机：手动意图、全局互斥、单次创建、元/分、券与渠道、价格变化、轮询与支付、取消与释放、异常码、重启恢复、退出。
import { describe, expect, it } from 'vitest';
import type { FakeAccount } from '../src/main/preview/fake-platform';
import type { CheckoutView } from '../src/shared/dto';
import { createHarness, type Harness, waitFor } from './helpers';

const AGREEMENT = '2026-11-07';

async function ready(opts: { accept?: boolean } = {}) {
  const h = await createHarness({ accounts: 8 });
  const acc = h.fake.accounts[0] as FakeAccount;
  Object.assign(acc, {
    shelfStatus: 1,
    rentStatus: 0,
    prices: {
      hour: '0.10',
      day: '1.00',
      week: '0',
      morning: '0.30',
      noon: '0.30',
      evening: '0.50',
    },
    rentType: [1, 2],
    rentPeriod: 1,
    durations: { hour: [1, 2, 3], day: [1], week: [] },
    useCoupon: 1,
    platformCouponConfig: 1,
  });
  if (opts.accept !== false) await h.controller.handle('agreement.accept', { version: AGREEMENT });
  return { h, acc };
}

const params = {
  rentKind: 'HOUR' as const,
  quantity: 2,
  payChannel: 1 as 1 | 2,
  autoCoupon: false,
};

async function start(
  h: Harness,
  accountNo: string,
  over: Partial<typeof params> = {},
  expected: string | null = null,
) {
  return h.controller.handle('checkout.start', {
    accountNo,
    params: { ...params, ...over },
    source: 'DETAIL',
    expectedAmountYuan: expected,
  });
}

const view = (h: Harness) => h.controller.checkout.view() as CheckoutView;
const waitState = (h: Harness, states: string[], timeout = 6000) =>
  waitFor(() => states.includes(h.controller.checkout.view()?.state ?? ''), timeout);

describe('手动入口与互斥', () => {
  it('首次未确认协议时不进入出码', async () => {
    const { h, acc } = await ready({ accept: false });
    const r = await start(h, acc.accountNo);
    expect(r.kind).toBe('NEEDS_AGREEMENT');
    expect(h.fake.lockChecks + h.fake.createCount).toBe(0);
  });

  it('收藏入口没有预设时先要求编辑预设', async () => {
    const { h, acc } = await ready();
    const r = await h.controller.handle('checkout.start', {
      accountNo: acc.accountNo,
      params: null,
      source: 'FAVORITE',
      expectedAmountYuan: null,
    });
    expect(r.kind).toBe('NEEDS_PRESET');
    expect(h.fake.createCount).toBe(0);
  });

  it('双击 / 并发入口只产生一笔创建', async () => {
    const { h, acc } = await ready();
    const results = await Promise.all([
      start(h, acc.accountNo),
      start(h, acc.accountNo),
      start(h, acc.accountNo),
    ]);
    expect(results.filter((r) => r.kind === 'STARTED')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'EXISTING')).toHaveLength(2);
    await waitState(h, ['PENDING']);
    expect(h.fake.createCount).toBe(1);
    expect(h.fake.lockChecks).toBe(1);
  });

  it('创建请求：realAmount 为分的字符串，propId 0，渠道 ID 来自渠道接口', async () => {
    const { h, acc } = await ready();
    h.fake.channels = [{ payChannel: 1, payChannelId: 7 }];
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    const body = h.fake.requests.find((r) => r.path === '/rent/order/create')?.body;
    expect(body).toEqual({
      accountNo: acc.accountNo,
      buyCount: 2,
      buyTimeType: 1,
      payChannel: 1,
      realAmount: '20',
      propId: 0,
      payChannelId: 7,
    });
    const v = view(h);
    expect(v.quote?.amountYuan).toBe('0.20');
    expect(v.paymentImage).toMatch(/^data:image\/png/);
    expect(v.remainingMs).toBeGreaterThan(170_000);
    // 支付订单 ID 在展示付款码前已持久化
    const row = await h.db.call('attempts.open', { profileId: 'fake-user-1' });
    expect(row?.payment_order_id).toBeTruthy();
    expect(row?.state).toBe('PENDING');
  });
});

describe('预检拒绝', () => {
  it('账号非可租：停止且不发送锁校验与创建', async () => {
    const { h, acc } = await ready();
    acc.rentStatus = 1;
    await start(h, acc.accountNo);
    await waitState(h, ['REJECTED']);
    expect(view(h).reason?.code).toBe('TAKEN');
    expect(view(h).reason?.text).toContain('先到先得，工具不代抢');
    expect(view(h).finished).toBe(true);
    expect(h.fake.lockChecks + h.fake.createCount + h.fake.unlockCount).toBe(0);
  });

  it('用户封禁 / 平台协议未完成：停止出码', async () => {
    const { h, acc } = await ready();
    h.fake.agreement.orderPageStatus = 0;
    await start(h, acc.accountNo);
    await waitState(h, ['REJECTED']);
    expect(view(h).reason?.code).toBe('PLATFORM_AGREEMENT');
    await h.controller.handle('checkout.dismiss', undefined);
    h.fake.agreement.orderPageStatus = 1;
    h.fake.user.isBan = 1;
    await start(h, acc.accountNo);
    await waitState(h, ['REJECTED']);
    expect(view(h).reason?.code).toBe('BANNED');
    expect(h.fake.createCount).toBe(0);
  });

  it('渠道失效不静默替换支付方式', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo, { payChannel: 2 });
    await waitState(h, ['REJECTED']);
    expect(view(h).reason?.code).toBe('CHANNEL_UNAVAILABLE');
    expect(h.fake.createCount).toBe(0);
  });

  it('数量超出范围停止', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo, { quantity: 99 });
    await waitState(h, ['REJECTED']);
    expect(view(h).reason?.code).toBe('QUANTITY_INVALID');
  });

  it('券列表不完整时暂停自动用券出码', async () => {
    const { h, acc } = await ready();
    h.fake.couponsIncomplete = true;
    await start(h, acc.accountNo, { autoCoupon: true });
    await waitState(h, ['REJECTED']);
    expect(view(h).reason?.code).toBe('COUPON_INCOMPLETE');
    expect(h.fake.lockChecks).toBe(0);
  });

  it('报价变化：停止本次触发，不锁号、不创建，提示新金额', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo, {}, '0.18');
    await waitState(h, ['REJECTED']);
    expect(view(h).reason?.code).toBe('PRICE_CHANGED');
    expect(view(h).reason?.text).toContain('0.20');
    expect(h.fake.lockChecks + h.fake.createCount).toBe(0);
  });

  it('自动用券：选最优券并以券后分值创建', async () => {
    const { h, acc } = await ready();
    const now = Math.floor(Date.now() / 1000);
    h.fake.coupons = [
      {
        id: '9',
        couponType: 7,
        discountType: 2,
        discountValue: '5',
        thresholdAmount: 0,
        status: 1,
        validStartAt: String(now - 10),
        validEndAt: String(now + 1000),
      },
    ];
    await start(h, acc.accountNo, { autoCoupon: true });
    await waitState(h, ['PENDING']);
    const body = h.fake.requests.find((r) => r.path === '/rent/order/create')?.body as Record<
      string,
      unknown
    >;
    expect(body.realAmount).toBe('15');
    expect(body.propId).toBe('9');
  });

  it('锁校验被拒：清理可能的锁并结束', async () => {
    const { h, acc } = await ready();
    h.fake.failNext('/rent/order/check_account_lock', {
      kind: 'business',
      code: 400,
      message: '账号已被他人锁定',
    });
    await start(h, acc.accountNo);
    await waitState(h, ['REJECTED']);
    await waitFor(() => view(h).finished);
    expect(h.fake.unlockCount).toBe(1);
    expect(h.fake.createCount).toBe(0);
  });

  it('创建 code=533：终止、展示平台提示、不自动重试', async () => {
    const { h, acc } = await ready();
    h.fake.failNext('/rent/order/create', { kind: 'business', code: 533, message: '平台业务提示' });
    await start(h, acc.accountNo);
    await waitState(h, ['REJECTED']);
    await waitFor(() => view(h).finished);
    expect(view(h).reason).toMatchObject({
      code: 'CREATE_533',
      text: '平台业务提示',
      retryable: false,
    });
    expect(h.fake.count('/rent/order/create')).toBe(1);
  });
});

describe('创建结果不明', () => {
  it('创建超时：不重发创建，受控释放一次，保持互斥直到人工核对', async () => {
    const { h, acc } = await ready();
    h.fake.failNext('/rent/order/create', { kind: 'lost-after-apply' });
    await start(h, acc.accountNo);
    await waitState(h, ['CREATE_UNKNOWN']);
    await waitFor(() => view(h).releaseState === 'ACCEPTED');
    expect(h.fake.count('/rent/order/create')).toBe(1);
    expect(h.fake.unlockCount).toBe(1);
    expect(view(h).finished).toBe(false);
    const again = await start(h, acc.accountNo);
    expect(again.kind).toBe('EXISTING');
    expect(h.fake.count('/rent/order/create')).toBe(1);
    await h.controller.handle('checkout.manualResolve', { result: 'NO_PENDING' });
    expect(view(h).state).toBe('MANUALLY_RESOLVED');
    expect(view(h).finished).toBe(true);
    const row = await h.db.call('attempts.open', { profileId: 'fake-user-1' });
    expect(row).toBeNull();
  });
});

describe('支付、取消与释放', () => {
  it('平台确认已支付：停止轮询、不解锁、提示回客户端', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    h.fake.pay();
    await h.controller.checkout.resumeFromSleep();
    await waitState(h, ['PAID']);
    expect(view(h).statusText).toContain('回到 5E 客户端完成上号');
    expect(view(h).paymentImage).toBeNull();
    expect(h.fake.unlockCount).toBe(0);
    const polls = h.fake.count('/rent/order/get_status');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.count('/rent/order/get_status')).toBe(polls);
  });

  it('取消：先核对支付再释放一次；释放受理不等于已取消，继续核对', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    await h.controller.handle('checkout.cancel', undefined);
    await waitState(h, ['RELEASE_ACCEPTED']);
    expect(view(h).statusText).toContain('释放请求已受理');
    expect(view(h).statusText).not.toContain('已取消');
    expect(view(h).finished).toBe(false);
    expect(h.fake.unlockCount).toBe(1);
    // 平台确认超时后结束
    h.fake.expire();
    await h.controller.checkout.resumeFromSleep();
    await waitState(h, ['EXPIRED']);
    expect(view(h).finished).toBe(true);
    expect(h.fake.unlockCount).toBe(1);
  });

  it('取消时发现已支付：以已付为准，不解锁', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    h.fake.pay();
    await h.controller.handle('checkout.cancel', undefined);
    await waitState(h, ['PAID']);
    expect(h.fake.unlockCount).toBe(0);
  });

  it('已支付结果不被迟到的超时/释放回包覆盖', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    h.fake.pay();
    await h.controller.checkout.resumeFromSleep();
    await waitState(h, ['PAID']);
    const order = [...h.fake.orders.values()][0];
    if (order) {
      order.payStatus = 0;
      order.abnormalReason = 5;
    }
    await h.controller.checkout.resumeFromSleep();
    await new Promise((r) => setTimeout(r, 30));
    expect(view(h).state).toBe('PAID');
  });

  it('释放失败：保留恢复记录与互斥，提示客户端核对', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    h.fake.failNext('/rent/order/unlock_account', { kind: 'network' });
    await h.controller.handle('checkout.cancel', undefined);
    await waitState(h, ['RELEASE_UNKNOWN']);
    expect(view(h).needsManualCheck).toBe(true);
    expect((await start(h, acc.accountNo)).kind).toBe('EXISTING');
    expect(h.fake.unlockCount).toBe(0);
  });

  it('本地倒计时归零：先核对平台；平台确认超时才进入 EXPIRED 并释放', async () => {
    const { h, acc } = await ready();
    h.fake.orderRemainSeconds = 0;
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    expect(view(h).paymentImage).toBeNull(); // 归零后不再展示可扫码
    expect(view(h).state).toBe('PENDING'); // 未经平台确认不宣布超时
    h.fake.expire();
    await h.controller.checkout.resumeFromSleep();
    await waitState(h, ['EXPIRED']);
    await waitFor(() => view(h).finished);
    expect(h.fake.unlockCount).toBe(1);
    expect(view(h).canRetry).toBe(true);
  });

  it('陌生支付状态：保留互斥，阻止自动创建', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    const order = [...h.fake.orders.values()][0];
    if (order) order.abnormalReason = 42;
    await h.controller.checkout.resumeFromSleep();
    await waitState(h, ['STATUS_UNKNOWN']);
    expect(view(h).finished).toBe(false);
    expect((await start(h, acc.accountNo)).kind).toBe('EXISTING');
  });

  it('付款码加载失败：保留订单状态与释放入口，不重建订单', async () => {
    const { h, acc } = await ready();
    h.fake.payImage = 'http://insecure.example/code.png';
    const h2 = h;
    // loadPaymentImage 在测试夹具中透传；改为模拟失败
    (
      h2.controller.checkout as unknown as { deps: { loadPaymentImage: () => Promise<null> } }
    ).deps.loadPaymentImage = async () => null;
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    expect(view(h).imageError).toBe(true);
    expect(view(h).canCancel).toBe(true);
    expect(h.fake.createCount).toBe(1);
  });
});

describe('重启恢复与退出', () => {
  it('创建中被强制终止：重启后进入创建结果确认中，不重建订单', async () => {
    const { h, acc } = await ready();
    await h.db.call('attempts.create', {
      row: {
        attempt_id: 'crash-1',
        profile_id: 'fake-user-1',
        account_no: acc.accountNo,
        params_json: JSON.stringify({ params, quote: null }),
        state: 'CREATING',
        payment_order_id: null,
        deadline_ms: null,
        release_state: 'NONE',
        lock_requested: 1,
        create_sent: 1,
        cleanup_done: 0,
        finished: 0,
        reason_json: null,
        resolution: null,
        trace_id: 'x',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    });
    const h2 = await createHarness({ db: h.db, fake: h.fake });
    await waitState(h2, ['CREATE_UNKNOWN']);
    expect(h.fake.createCount).toBe(0);
    expect((h2.controller.checkout.view() as CheckoutView).needsManualCheck).toBe(true);
  });

  it('待支付时被强制终止：重启后不展示付款码、继续核对支付 ID', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    h.controller.checkout.detach();
    const h2 = await createHarness({ db: h.db, fake: h.fake });
    await waitState(h2, ['PENDING']);
    expect((h2.controller.checkout.view() as CheckoutView).paymentImage).toBeNull();
    h.fake.pay();
    h2.controller.checkout.resumeFromSleep();
    await waitState(h2, ['PAID']);
    expect(h.fake.createCount).toBe(1);
  });

  it('预检已发锁校验时崩溃：重启后释放一次并结束预检', async () => {
    const { h, acc } = await ready();
    await h.db.call('attempts.create', {
      row: {
        attempt_id: 'crash-2',
        profile_id: 'fake-user-1',
        account_no: acc.accountNo,
        params_json: JSON.stringify({ params, quote: null }),
        state: 'CHECKING',
        payment_order_id: null,
        deadline_ms: null,
        release_state: 'NONE',
        lock_requested: 1,
        create_sent: 0,
        cleanup_done: 0,
        finished: 0,
        reason_json: null,
        resolution: null,
        trace_id: 'y',
        created_at: Date.now(),
        updated_at: Date.now(),
      },
    });
    const h2 = await createHarness({ db: h.db, fake: h.fake });
    await waitState(h2, ['PREFLIGHT_CANCELLED']);
    expect(h.fake.unlockCount).toBe(1);
    expect((h2.controller.checkout.view() as CheckoutView).finished).toBe(true);
  });

  it('显式退出：对待支付尝试申请清理，未确认结果保存供下次恢复', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    await h.controller.shutdown();
    expect(h.fake.unlockCount).toBe(1);
    const row = await h.db.call('attempts.open', { profileId: 'fake-user-1' });
    expect(row?.state).toBe('RELEASE_ACCEPTED');
  });

  it('支付期间暂停库存扫描', async () => {
    const { h, acc } = await ready();
    await start(h, acc.accountNo);
    await waitState(h, ['PENDING']);
    expect(h.controller.queue.isBlocked(4)).toBe(true);
    h.fake.pay();
    h.controller.checkout.resumeFromSleep();
    await waitState(h, ['PAID']);
    expect(h.controller.queue.isBlocked(4)).toBe(false);
  });
});
