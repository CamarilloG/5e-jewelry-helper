// 统一请求调度（假时钟）：R=1/30/60、平滑间隔、滚动窗口、降速、429、重试、优先级、取消与阻塞。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelledError, PlatformError } from '../src/main/platform/errors';
import { Priority, RequestQueue } from '../src/main/platform/queue';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

const clock = { now: () => Date.now() };

function maxInWindow(starts: number[]) {
  let max = 0;
  for (const s of starts)
    max = Math.max(max, starts.filter((t) => t >= s && t < s + 60_000).length);
  return max;
}

async function drive(queue: RequestQueue, count: number, ms: number) {
  const starts: number[] = [];
  const tasks = Array.from({ length: count }, () =>
    queue.run({ priority: Priority.SCAN, label: 't' }, async () => {
      starts.push(Date.now());
    }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  await Promise.all(tasks);
  return starts;
}

describe('请求预算', () => {
  for (const R of [1, 30, 60]) {
    it(`R=${R}：相邻起点 ≥ 60000/R 且任意 60 秒不超过 R`, async () => {
      const q = new RequestQueue(R, clock);
      const n = Math.min(R * 2 + 1, 130);
      const starts = await drive(q, n, (n + 1) * Math.ceil(60_000 / R) + 60_000);
      expect(starts).toHaveLength(n);
      for (let i = 1; i < starts.length; i++) {
        expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(
          Math.ceil(60_000 / R),
        );
      }
      expect(maxInWindow(starts)).toBeLessThanOrEqual(R);
    });
  }

  it('同时最多 1 个请求在执行', async () => {
    const q = new RequestQueue(600, clock);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 5 }, () =>
      q.run({ priority: Priority.SCAN, label: 't' }, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 500));
        active--;
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(tasks);
    expect(peak).toBe(1);
  });

  it('降低速率后立即按新预算执行，既往请求仍计入窗口', async () => {
    const q = new RequestQueue(60, clock);
    const starts: number[] = [];
    const run = () =>
      q.run({ priority: Priority.SCAN, label: 't' }, async () => void starts.push(Date.now()));
    const first = [run(), run(), run()];
    await vi.advanceTimersByTimeAsync(2500);
    await Promise.all(first);
    q.setLimit(3);
    const second = [run(), run()];
    await vi.advanceTimersByTimeAsync(130_000);
    await Promise.all(second);
    expect(maxInWindow(starts)).toBeLessThanOrEqual(3);
    // 第 4 个请求必须等到第 1 个起点满 60 秒后
    expect(starts[3]).toBeGreaterThanOrEqual((starts[0] as number) + 60_000);
  });
});

describe('优先级、取消与阻塞', () => {
  it('订单核对 > 出码 > 用户 > 监测 > 扫描', async () => {
    const q = new RequestQueue(60, clock);
    const order: string[] = [];
    const add = (p: Priority, name: string) =>
      q.run({ priority: p, label: name }, async () => void order.push(name));
    const blocker = add(Priority.SCAN, 'first');
    const rest = [
      add(Priority.SCAN, 'scan'),
      add(Priority.MONITOR, 'monitor'),
      add(Priority.USER, 'user'),
      add(Priority.CHECKOUT, 'checkout'),
      add(Priority.ORDER_RECOVERY, 'recovery'),
    ];
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all([blocker, ...rest]);
    expect(order).toEqual(['first', 'recovery', 'checkout', 'user', 'monitor', 'scan']);
  });

  it('取消分组只取消未发送的请求', async () => {
    const q = new RequestQueue(60, clock);
    const sent: number[] = [];
    const tasks = [1, 2, 3].map((i) =>
      q
        .run(
          { priority: Priority.SCAN, group: 'scan:1', label: 's' },
          async () => void sent.push(i),
        )
        .catch((e) => e),
    );
    await vi.advanceTimersByTimeAsync(10);
    q.cancelGroup('scan:1');
    await vi.advanceTimersByTimeAsync(10_000);
    const results = await Promise.all(tasks);
    expect(sent).toEqual([1]);
    expect(results.filter((r) => r instanceof CancelledError)).toHaveLength(2);
  });

  it('阻塞的优先级保留在队列中，解除后继续', async () => {
    const q = new RequestQueue(600, clock);
    q.setBlocked(Priority.SCAN, true);
    let ran = false;
    const t = q.run({ priority: Priority.SCAN, label: 's' }, async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toBe(false);
    q.setBlocked(Priority.SCAN, false);
    await vi.advanceTimersByTimeAsync(10);
    await t;
    expect(ran).toBe(true);
  });

  it('暂停期间不发送，恢复后发送', async () => {
    const q = new RequestQueue(600, clock);
    q.pause('登录失效');
    let ran = false;
    const t = q.run({ priority: Priority.USER, label: 'u' }, async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toBe(false);
    q.resume();
    await vi.advanceTimersByTimeAsync(10);
    await t;
    expect(ran).toBe(true);
  });
});

describe('重试与限流', () => {
  it('只读：网络错误重试 2 次（2s、5s），重试计入预算', async () => {
    const q = new RequestQueue(600, clock);
    const attempts: number[] = [];
    const p = q
      .runRead({ priority: Priority.USER, label: 'r' }, async () => {
        attempts.push(Date.now());
        throw new PlatformError('NETWORK', 'NETWORK');
      })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await p;
    expect(err).toBeInstanceOf(PlatformError);
    expect(attempts).toHaveLength(3);
    expect((attempts[1] as number) - (attempts[0] as number)).toBeGreaterThanOrEqual(2000);
    expect((attempts[2] as number) - (attempts[1] as number)).toBeGreaterThanOrEqual(5000);
    expect(q.stats().lastMinute).toBe(3);
  });

  it('业务错误不重试；写入（run）不自动重发', async () => {
    const q = new RequestQueue(600, clock);
    let reads = 0;
    let writes = 0;
    const r = q
      .runRead({ priority: Priority.USER, label: 'r' }, async () => {
        reads++;
        throw new PlatformError('BUSINESS', 'B');
      })
      .catch(() => null);
    const w = q
      .run({ priority: Priority.CHECKOUT, label: 'create' }, async () => {
        writes++;
        throw new PlatformError('TIMEOUT', 'T');
      })
      .catch(() => null);
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([r, w]);
    expect(reads).toBe(1);
    expect(writes).toBe(1);
  });

  it('429 遵守 Retry-After，无该值时暂停 60 秒', async () => {
    const q = new RequestQueue(600, clock);
    const attempts: number[] = [];
    let n = 0;
    const p = q.runRead({ priority: Priority.USER, label: 'r' }, async () => {
      attempts.push(Date.now());
      n++;
      if (n === 1) throw new PlatformError('RATE_LIMITED', 'R', { retryAfterMs: 7000 });
      if (n === 2) throw new PlatformError('RATE_LIMITED', 'R', { retryAfterMs: 60_000 });
      return 'ok';
    });
    await vi.advanceTimersByTimeAsync(80_000);
    await expect(p).resolves.toBe('ok');
    expect((attempts[1] as number) - (attempts[0] as number)).toBeGreaterThanOrEqual(7000);
    expect((attempts[2] as number) - (attempts[1] as number)).toBeGreaterThanOrEqual(60_000);
  });

  it('排队等待期间不启动网络计时：fn 只在发送时调用', async () => {
    const q = new RequestQueue(1, clock);
    const calledAt: number[] = [];
    const a = q.run(
      { priority: Priority.USER, label: 'a' },
      async () => void calledAt.push(Date.now()),
    );
    const b = q.run(
      { priority: Priority.USER, label: 'b' },
      async () => void calledAt.push(Date.now()),
    );
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.all([a, b]);
    expect(calledAt[1]).toBeGreaterThanOrEqual(60_000);
  });
});
