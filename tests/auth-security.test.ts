// 登录态与身份、IPC 输入校验、日志脱敏、诊断导出、通知 XML 转义、图片来源白名单、CSP。
import { describe, expect, it } from 'vitest';
import { jwtExpiryMs, parseOutcome } from '../src/main/auth/reader-process';
import { productionCsp } from '../src/main/electron/protocols';
import { sanitizeFields, scrubText } from '../src/main/logger';
import { imageProxyUrl, isAllowedImageUrl } from '../src/main/services/image-cache';
import { buildToastXml } from '../src/main/services/notification-service';
import { ipcInputs } from '../src/shared/ipc';
import { createHarness, fakeJwt, waitFor } from './helpers';

describe('登录态引导状态', () => {
  it('无客户端 / 未登录 / 读取失败 / 本地已过期', async () => {
    const h = await createHarness({ start: false });
    for (const [outcome, phase] of [
      [{ state: 'NO_CLIENT' }, 'NO_CLIENT'],
      [{ state: 'NO_LOGIN' }, 'NO_LOGIN'],
      [{ state: 'READ_FAILED', reason: 'CONCURRENT_CHANGE' }, 'READ_FAILED'],
      [{ state: 'READ', credential: fakeJwt(1000) }, 'EXPIRED'],
    ] as const) {
      h.reader.outcome = outcome;
      await h.controller.reloadAuth();
      expect(h.controller.auth.view().phase).toBe(phase);
    }
    expect(h.fake.requests).toHaveLength(0); // 本地即可判定，不调用平台
  });

  it('官方接口业务 401 使登录态失效', async () => {
    const h = await createHarness({ start: false });
    h.reader.outcome = { state: 'READ', credential: 'not-the-valid-token' };
    await h.controller.reloadAuth();
    expect(h.controller.auth.view().phase).toBe('EXPIRED');
  });

  it('剩余天数按 JWT 到期时间计算，身份以官方接口确认', async () => {
    const h = await createHarness({ start: false });
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3 * 86400 - 60);
    h.fake.validToken = token;
    h.reader.outcome = { state: 'READ', credential: token };
    await h.controller.reloadAuth();
    expect(h.controller.auth.view()).toMatchObject({ phase: 'OK', daysLeft: 3 });
    expect(h.controller.auth.profileId()).toBe('fake-user-1');
  });

  it('运行中失效：暂停平台请求、停止监测并显示横幅；同用户重新读取后恢复', async () => {
    const h = await createHarness();
    h.controller.monitor.start();
    h.fake.validToken = 'rotated';
    await h.controller.handle('favorites.syncNow', undefined).catch(() => undefined);
    await waitFor(() => h.controller.auth.view().phase === 'EXPIRED');
    const status = h.controller.status();
    expect(status.banners.some((b) => b.action === 'RELOAD_AUTH')).toBe(true);
    expect(status.requests.pausedReason).not.toBeNull();
    expect(status.monitor.paused).toBe(true);
    h.fake.validToken = 'fake-credential';
    h.reader.outcome = { state: 'READ', credential: 'fake-credential' };
    await h.controller.reloadAuth();
    expect(h.controller.auth.view().phase).toBe('OK');
    expect(h.controller.status().requests.pausedReason).toBeNull();
    expect(h.controller.status().banners).toHaveLength(0);
    h.controller.monitor.halt();
  });

  it('身份变化：切换数据作用域，旧身份收藏不可见、订单记录保留', async () => {
    const h = await createHarness();
    await h.controller.handle('favorites.add', {
      accountNo: h.fake.accounts[0]?.accountNo as string,
    });
    expect((await h.controller.favorites.view()).items).toHaveLength(1);
    h.fake.user.uuid = 'fake-user-2';
    h.fake.favorites = [];
    await h.controller.reloadAuth();
    expect(h.controller.auth.profileId()).toBe('fake-user-2');
    expect((await h.controller.favorites.view()).items).toHaveLength(0);
    h.fake.user.uuid = 'fake-user-1';
    await h.controller.reloadAuth();
    expect((await h.controller.favorites.view()).items).toHaveLength(1);
  });

  it('解析器协议：不接受空凭证；未知状态为读取失败', () => {
    expect(parseOutcome({ state: 'READ', credential: '' })).toEqual({ state: 'NO_LOGIN' });
    expect(parseOutcome({ state: 'WHAT' })).toMatchObject({ state: 'READ_FAILED' });
    expect(jwtExpiryMs(`Bearer ${fakeJwt(100)}`)).toBe(100_000);
    expect(jwtExpiryMs('opaque')).toBeNull();
  });
});

describe('凭证边界', () => {
  it('凭证只发送到官方网关，且不出现在任何界面 DTO 中', async () => {
    const h = await createHarness();
    await h.controller.handle('scan.start', {
      conditions: {
        items: [],
        rentKind: 'HOUR',
        priceMin: null,
        priceMax: null,
        couponOnly: false,
      },
      presetId: null,
    });
    await waitFor(() => h.controller.scan.state().phase === 'COMPLETE');
    const dto = JSON.stringify([
      h.controller.status(),
      h.controller.scan.state(),
      await h.controller.favorites.view(),
      await h.controller.settingsView(),
    ]);
    expect(dto).not.toContain(h.fake.validToken);
    expect(h.fake.requests.every((r) => r.authorization === h.fake.validToken)).toBe(true);
  });

  it('诊断导出不含凭证、账号编号与付款码', async () => {
    const h = await createHarness();
    let saved = '';
    (
      h.controller as unknown as {
        deps: { shell: { saveDiagnostics: (n: string, c: string) => Promise<string> } };
      }
    ).deps.shell.saveDiagnostics = async (_n, c) => {
      saved = c;
      return 'x';
    };
    (h.controller as unknown as { deps: { readLogs: () => Promise<string> } }).deps.readLogs =
      async () =>
        `{"event":"x eyJhbGciOiJub25lIn0.eyJleHAiOjF9.sig CS1234567890 https://pay.example/qr?id=1"}`;
    await h.controller.handle('diagnostics.export', undefined);
    expect(saved).not.toContain('eyJ');
    expect(saved).not.toContain('CS1234567890');
    expect(saved).not.toContain('pay.example');
    expect(saved).not.toContain(h.fake.validToken);
  });
});

describe('日志脱敏', () => {
  it('只保留白名单字段，去除 JWT、URL、长数字串', () => {
    expect(sanitizeFields({ op: '/x', authorization: 'secret', body: '{}', ms: 3 })).toEqual({
      op: '/x',
      ms: 3,
    });
    const s = scrubText('token eyJa.eyJb.c url https://x.y/z?q=1 order 900000000000000001');
    expect(s).not.toMatch(/eyJ|https|9000000/);
  });
});

describe('IPC 输入校验', () => {
  it('拒绝非法账号号、越界价格区间、未知字段类型', () => {
    expect(
      ipcInputs['account.detail'].safeParse({ accountNo: '../../etc', refresh: false }).success,
    ).toBe(false);
    expect(
      ipcInputs['account.detail'].safeParse({ accountNo: 'CS0000000001', refresh: false }).success,
    ).toBe(true);
    const c = { items: [], rentKind: 'HOUR', priceMin: '10', priceMax: '2', couponOnly: false };
    expect(ipcInputs['scan.start'].safeParse({ conditions: c, presetId: null }).success).toBe(
      false,
    );
    expect(
      ipcInputs['scan.start'].safeParse({ conditions: { ...c, rentKind: 'YEAR' }, presetId: null })
        .success,
    ).toBe(false);
    expect(
      ipcInputs['checkout.start'].safeParse({
        accountNo: 'CS1',
        params: { rentKind: 'HOUR', quantity: 1.5, payChannel: 1, autoCoupon: true },
        source: 'DETAIL',
        expectedAmountYuan: null,
      }).success,
    ).toBe(false);
    expect(ipcInputs['settings.update'].safeParse({ monitorIntervalSeconds: 10 }).success).toBe(
      false,
    );
    expect(
      ipcInputs['checkout.start'].safeParse({
        accountNo: 'CS1',
        params: null,
        source: 'NOTIFICATION',
        expectedAmountYuan: null,
      }).success,
    ).toBe(false);
  });
});

describe('通知 XML、图片来源与 CSP', () => {
  it('外部文本被转义，不能注入 XML 结构', () => {
    const xml = buildToastXml({
      title: '收藏账号可租了',
      lines: ['<action content="x"/>&"\''],
      launch: `jewelry-helper://notification?v=1&a=view&n=${'a'.repeat(32)}`,
      image: null,
      actions: [],
      silent: true,
    });
    expect(xml).toContain('&lt;action content=&quot;x&quot;/&gt;&amp;&quot;&apos;');
    expect(xml.match(/<action /g)).toBeNull();
  });
  it('只允许 HTTPS 的官方 OSS 与 Steam 图像来源', () => {
    expect(isAllowedImageUrl('https://oss.5eplay.com/a.png')).toBe(true);
    expect(isAllowedImageUrl('https://steamcommunity-a.akamaihd.net/economy/image/x')).toBe(true);
    expect(isAllowedImageUrl('http://oss.5eplay.com/a.png')).toBe(false);
    expect(isAllowedImageUrl('https://evil.example/a.png')).toBe(false);
    expect(isAllowedImageUrl('https://oss.5eplay.com.evil.example/a.png')).toBe(false);
    expect(imageProxyUrl('https://evil.example/a.png')).toBeNull();
  });
  it('生产 CSP 禁止远程脚本、内联脚本与 eval', () => {
    const csp = productionCsp();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|script-src[^;]*https?:/);
    expect(csp).toContain("object-src 'none'");
  });
});
