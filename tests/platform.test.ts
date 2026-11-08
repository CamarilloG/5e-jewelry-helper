// 平台客户端契约：业务成功判定、401 映射、429、5xx、契约变更、重定向拦截、请求头、三种订单标识隔离。
import { describe, expect, it } from 'vitest';
import { nullLogger } from '../src/main/logger';
import { PlatformApi } from '../src/main/platform/api';
import { type HttpTransport, PlatformClient } from '../src/main/platform/client';
import { PlatformError } from '../src/main/platform/errors';
import { Priority, RequestQueue } from '../src/main/platform/queue';
import { normalizeAccount, rawAccountSchema } from '../src/main/platform/schemas';
import { FakePlatform } from '../src/main/preview/fake-platform';

const creds = (value: string | null) => ({ credential: () => value });

function scripted(
  responses: { status: number; body: unknown; retryAfter?: string }[] | (() => never),
): HttpTransport & {
  calls: { url: string; headers: Record<string, string>; body: string }[];
} {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  return {
    calls,
    async post(url, body, headers) {
      calls.push({ url, headers, body });
      if (typeof responses === 'function') return responses();
      const next = responses.shift();
      if (!next) throw new Error('no response');
      return {
        status: next.status,
        header: (n) => (n.toLowerCase() === 'retry-after' ? (next.retryAfter ?? null) : null),
        text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
      };
    },
  };
}

const okEnv = (data: unknown) => ({
  status: true,
  code: 0,
  message: '',
  data,
  timestamp: 1_800_000_000,
  success: true,
});

describe('PlatformClient', () => {
  it('只附加 Content-Type 与原样 Authorization（不增删 Bearer）', async () => {
    const t = scripted([{ status: 200, body: okEnv({ frontPageStatus: 1, orderPageStatus: 1 }) }]);
    const client = new PlatformClient(t, creds('raw-token-without-bearer'), nullLogger);
    const api = new PlatformApi(client, new RequestQueue(1000));
    await api.authInfo({ priority: Priority.USER });
    expect(t.calls[0]?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'raw-token-without-bearer',
    });
    expect(t.calls[0]?.url).toBe(
      'https://gate.5eplay.com/rentinterface/http/v1/rent/user/auth_info',
    );
  });

  it('没有凭证时不发送请求', async () => {
    const t = scripted([]);
    const client = new PlatformClient(t, creds(null), nullLogger);
    await expect(client.post('/x', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'NO_CREDENTIAL',
    });
    expect(t.calls).toHaveLength(0);
  });

  it('HTTP 200 内 status=false 仍为失败；不使用顶层 success 判定', async () => {
    const t = scripted([
      {
        status: 200,
        body: { status: false, code: 400, message: '订单不存在', data: null, success: true },
      },
    ]);
    const client = new PlatformClient(t, creds('x'), nullLogger);
    const err = await client.post('/x', {}, rawAccountSchema, 1000).catch((e) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.code).toBe('BUSINESS');
    expect(err.details.platformMessage).toBe('订单不存在');
  });

  it('业务 code=401 与 HTTP 401 均映射 AUTH_EXPIRED 并触发回调', async () => {
    const t = scripted([
      { status: 200, body: { status: false, code: 401, message: '未登录', data: null } },
      { status: 401, body: '' },
    ]);
    const client = new PlatformClient(t, creds('x'), nullLogger);
    let hits = 0;
    client.onAuthExpired = () => hits++;
    await expect(client.post('/a', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
    await expect(client.post('/b', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
    expect(hits).toBe(2);
  });

  it('429 带 Retry-After；5xx 为 SERVER；非 JSON / 关键字段缺失为 CONTRACT_CHANGED', async () => {
    const t = scripted([
      { status: 429, body: '', retryAfter: '12' },
      { status: 503, body: '' },
      { status: 200, body: '<html>' },
      { status: 200, body: okEnv({ notAnAccount: true }) },
    ]);
    const client = new PlatformClient(t, creds('x'), nullLogger);
    let contract = 0;
    client.onContractChanged = () => contract++;
    await expect(client.post('/a', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterMs: 12_000 },
    });
    await expect(client.post('/a', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'SERVER',
    });
    await expect(client.post('/a', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED',
    });
    await expect(client.post('/a', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'CONTRACT_CHANGED',
    });
    expect(contract).toBe(1);
  });

  it('重定向一律拦截，不把 Authorization 带到其他源', async () => {
    const t = scripted([{ status: 302, body: '' }]);
    const client = new PlatformClient(t, creds('x'), nullLogger);
    await expect(client.post('/a', {}, rawAccountSchema, 1000)).rejects.toMatchObject({
      code: 'REDIRECT_BLOCKED',
    });
    const t2 = scripted(() => {
      throw new TypeError('fetch failed: redirect mode is set to error');
    });
    await expect(
      new PlatformClient(t2, creds('x'), nullLogger).post('/a', {}, rawAccountSchema, 1000),
    ).rejects.toMatchObject({
      code: 'REDIRECT_BLOCKED',
    });
  });

  it('超时映射 TIMEOUT', async () => {
    const t: HttpTransport = {
      post: (_u, _b, _h, signal) =>
        new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    };
    await expect(
      new PlatformClient(t, creds('x'), nullLogger).post('/a', {}, rawAccountSchema, 20),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});

describe('字段归一化', () => {
  it('搜索列表缺少状态字段 → 未知；字符串大整数保持字符串', () => {
    const rec = normalizeAccount(
      rawAccountSchema.parse({ accountNo: 'CS0000000001', rentType: [1], hourPrice: '3' }),
    );
    expect(rec.status).toBe('UNKNOWN');
    expect(rec.statusKnown).toBe(false);
    expect(rec.accountNo).toBe('CS0000000001');
  });
  it('陌生 rentStatus 不推断可租；expireTime 秒→毫秒', () => {
    const rec = normalizeAccount(
      rawAccountSchema.parse({
        accountNo: 'A',
        shelfStatus: 1,
        rentStatus: 9,
        expireTime: '1800000000',
      }),
    );
    expect(rec.status).toBe('UNKNOWN');
    expect(rec.expireTimeMs).toBe(1_800_000_000_000);
  });
  it('StatTrak 以名称识别，不以 hasStattrak=-1 否定', () => {
    const rec = normalizeAccount(
      rawAccountSchema.parse({
        accountNo: 'A',
        displayInventory: [
          { marketName: 'FN57（StatTrak™） | 暴怒野兽 (破损不堪)', hasStattrak: -1, assetid: '1' },
        ],
      }),
    );
    expect(rec.displayItems[0]?.statTrak).toBe(true);
  });
  it('total 非负整数校验', async () => {
    const fake = new FakePlatform();
    const api = new PlatformApi(
      new PlatformClient(fake, creds(fake.validToken), nullLogger),
      new RequestQueue(1000),
    );
    const r = await api.search(
      { keyword: '', page: 1, rentKind: 'HOUR', couponOnly: false },
      { priority: Priority.USER },
    );
    expect(Number.isInteger(r.total)).toBe(true);
  });
});

describe('三种订单标识按用途隔离', () => {
  it('get_status 只使用创建响应的 orderId', async () => {
    const fake = new FakePlatform();
    const api = new PlatformApi(
      new PlatformClient(fake, creds(fake.validToken), nullLogger),
      new RequestQueue(1000),
    );
    const acc = fake.accounts.find((a) => a.rentStatus === 0 && a.shelfStatus === 1);
    if (!acc) throw new Error('no account');
    const created = await api.createOrder({
      accountNo: acc.accountNo,
      buyCount: 1,
      buyTimeType: 1,
      payChannel: 1,
      realAmount: '350',
      propId: 0,
      payChannelId: 4,
    });
    await api.payStatus(created.orderId);
    const statusCall = fake.requests.find((r) => r.path === '/rent/order/get_status');
    expect(statusCall?.body).toEqual({ orderId: created.orderId });
    // 用租赁订单号查询支付状态会得到业务错误
    await expect(api.payStatus('rental-order-no')).rejects.toMatchObject({ code: 'BUSINESS' });
  });
});
