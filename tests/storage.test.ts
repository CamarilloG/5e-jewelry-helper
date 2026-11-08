// 本地数据库：迁移、重启保留、迁移失败恢复并阻止写入、用户作用域隔离、收藏合并、通知意图一次性消费、缓存清理边界。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { InlineDbClient, WorkerDbClient } from '../src/main/storage/client';
import { MIGRATIONS, MigrationFailedError, openDatabase } from '../src/main/storage/sqlite';

const dirs: string[] = [];
function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-db-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const P1 = 'profile-1';
const P2 = 'profile-2';

describe('迁移与持久化', () => {
  it('首次打开应用全部迁移并启用外键与 WAL', async () => {
    const dir = tmpdir();
    const { db, applied } = await openDatabase(path.join(dir, 'app.db'), {
      backupDir: path.join(dir, 'b'),
    });
    expect(applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    );
    db.close();
  });

  it('收藏、预设和订单记录在重启后保留', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'app.db');
    let client = await InlineDbClient.open(file);
    await client.call('favorites.addManual', {
      profileId: P1,
      accountNo: 'CS1',
      now: 1,
      summaryJson: null,
    });
    await client.call('presets.save', {
      profileId: P1,
      accountNo: 'CS1',
      rentKind: 'DAY',
      quantity: 2,
      payChannel: 1,
      autoCoupon: true,
      now: 1,
    });
    await client.call('attempts.create', {
      row: {
        attempt_id: 'a1',
        profile_id: P1,
        account_no: 'CS1',
        params_json: '{}',
        state: 'PENDING',
        payment_order_id: '900',
        deadline_ms: 10,
        release_state: 'NONE',
        lock_requested: 1,
        create_sent: 1,
        cleanup_done: 0,
        finished: 0,
        reason_json: null,
        resolution: null,
        trace_id: 't',
        created_at: 1,
        updated_at: 1,
      },
    });
    await client.close();
    client = await InlineDbClient.open(file);
    const list = await client.call('favorites.list', { profileId: P1 });
    expect(list.favorites.map((f) => f.account_no)).toEqual(['CS1']);
    expect(list.presets[0]?.rent_kind).toBe('DAY');
    expect((await client.call('attempts.open', { profileId: P1 }))?.payment_order_id).toBe('900');
    await client.close();
  });

  it('迁移失败：恢复备份、抛出错误，不静默新建空库', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'app.db');
    const first = await openDatabase(file, { backupDir: path.join(dir, 'b') });
    first.db.prepare('INSERT INTO profiles VALUES (?, ?, ?)').run(P1, 1, 1);
    first.db.close();
    const broken = [
      ...MIGRATIONS,
      { version: 99, name: '099_broken', sql: 'CREATE TABLE x (; broken' },
    ];
    await expect(
      openDatabase(file, { backupDir: path.join(dir, 'b'), migrations: broken }),
    ).rejects.toBeInstanceOf(MigrationFailedError);
    const db = new DatabaseSync(file);
    expect((db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v,
    ).toBe(1);
    db.close();
    expect(
      fs.readdirSync(path.join(dir, 'b')).some((n) => n.startsWith('app-pre-migration-v1')),
    ).toBe(true);
  });

  it('只保留最近 3 个迁移备份', async () => {
    const dir = tmpdir();
    const file = path.join(dir, 'app.db');
    (await openDatabase(file)).db.close();
    let migrations = [...MIGRATIONS];
    for (let v = 2; v <= 6; v++) {
      migrations = [
        ...migrations,
        { version: v, name: `00${v}`, sql: `CREATE TABLE t${v} (id INTEGER)` },
      ];
      (
        await openDatabase(file, {
          backupDir: path.join(dir, 'b'),
          migrations,
          now: () => v * 1000,
        })
      ).db.close();
    }
    expect(fs.readdirSync(path.join(dir, 'b')).length).toBe(3);
  });

  it('Worker 无法启动时打开失败而不是挂起', async () => {
    const dir = tmpdir();
    // 用源码 worker 需经过构建；这里只验证 Worker 不可用时的错误类型
    const client = new WorkerDbClient(
      path.join(dir, 'missing-worker.js'),
      path.join(dir, 'app.db'),
      dir,
    );
    await expect(client.ready).rejects.toBeTruthy();
  });
});

describe('用户作用域', () => {
  it('不同用户的收藏、预设、方案和订单互不可见', async () => {
    const db = await InlineDbClient.open();
    await db.call('favorites.addManual', {
      profileId: P1,
      accountNo: 'CS1',
      now: 1,
      summaryJson: null,
    });
    await db.call('favorites.addManual', {
      profileId: P2,
      accountNo: 'CS2',
      now: 1,
      summaryJson: null,
    });
    await db.call('filters.save', {
      profileId: P1,
      id: 'f1',
      name: '方案',
      conditionsJson: '{}',
      schemaVersion: 1,
      overwriteId: null,
      now: 1,
    });
    expect(
      (await db.call('favorites.list', { profileId: P1 })).favorites.map((f) => f.account_no),
    ).toEqual(['CS1']);
    expect(
      (await db.call('favorites.list', { profileId: P2 })).favorites.map((f) => f.account_no),
    ).toEqual(['CS2']);
    expect(await db.call('filters.list', { profileId: P2 })).toHaveLength(0);
    await db.close();
  });
});

describe('收藏合并与写回意图', () => {
  it('只增不删；移除记录不被导入；不完整快照不标记平台取消', async () => {
    const db = await InlineDbClient.open();
    await db.call('favorites.addManual', {
      profileId: P1,
      accountNo: 'L1',
      now: 1,
      summaryJson: null,
    });
    await db.call('syncOps.succeeded', { profileId: P1, accountNo: 'L1', revision: 1 });
    await db.call('favorites.removeManual', {
      profileId: P1,
      accountNo: 'T1',
      alsoPlatform: false,
      now: 1,
    });
    const incomplete = await db.call('favorites.mergePlatform', {
      profileId: P1,
      accounts: [{ accountNo: 'P1', summaryJson: null }],
      complete: false,
      now: 2,
    });
    expect(incomplete.added).toEqual([]);
    const merged = await db.call('favorites.mergePlatform', {
      profileId: P1,
      accounts: [
        { accountNo: 'P1', summaryJson: null },
        { accountNo: 'T1', summaryJson: null },
      ],
      complete: true,
      now: 3,
    });
    expect(merged.added).toEqual(['P1']);
    expect(merged.removedOnPlatform).toEqual(['L1']);
    const list = await db.call('favorites.list', { profileId: P1 });
    const byNo = new Map(list.favorites.map((f) => [f.account_no, f]));
    expect(byNo.has('T1')).toBe(false);
    expect(byNo.get('L1')?.platform_state).toBe('removed'); // 本地保留
    expect(byNo.get('P1')?.source).toBe('platform');
    expect(byNo.get('P1')?.monitor_enabled).toBe(1);
    await db.close();
  });

  it('同账号只有一条最新意图；旧 revision 的回包不能覆盖新操作', async () => {
    const db = await InlineDbClient.open();
    const add = await db.call('favorites.addManual', {
      profileId: P1,
      accountNo: 'A',
      now: 1,
      summaryJson: null,
    });
    const remove = await db.call('favorites.removeManual', {
      profileId: P1,
      accountNo: 'A',
      alsoPlatform: true,
      now: 2,
    });
    expect(remove.revision).toBeGreaterThan(add.revision);
    // 迟到的“收藏成功”回包
    expect(
      (
        await db.call('syncOps.succeeded', {
          profileId: P1,
          accountNo: 'A',
          revision: add.revision,
        })
      ).current,
    ).toBe(false);
    const ops = await db.call('syncOps.due', { profileId: P1, now: 10 });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.target_status).toBe(0);
    // 同步时平台快照仍含 A：不重新导入（有移除记录）
    const merged = await db.call('favorites.mergePlatform', {
      profileId: P1,
      accounts: [{ accountNo: 'A', summaryJson: null }],
      complete: true,
      now: 3,
    });
    expect(merged.added).toEqual([]);
    // revision 删除意图后仍单调递增
    expect(
      (
        await db.call('syncOps.succeeded', {
          profileId: P1,
          accountNo: 'A',
          revision: remove.revision as number,
        })
      ).current,
    ).toBe(true);
    const again = await db.call('favorites.addManual', {
      profileId: P1,
      accountNo: 'A',
      now: 4,
      summaryJson: null,
    });
    expect(again.revision).toBeGreaterThan(remove.revision as number);
    await db.close();
  });

  it('恢复已移除的收藏只恢复本地，不产生写回意图', async () => {
    const db = await InlineDbClient.open();
    await db.call('favorites.removeManual', {
      profileId: P1,
      accountNo: 'R',
      alsoPlatform: false,
      now: 1,
    });
    expect(await db.call('favorites.restore', { profileId: P1, accountNo: 'R', now: 2 })).toBe(
      true,
    );
    expect(await db.call('syncOps.due', { profileId: P1, now: 10 })).toHaveLength(0);
    await db.close();
  });
});

describe('通知意图', () => {
  const row = (nonce: string, expires: number, profile = P1) => ({
    nonce,
    profile_id: profile,
    account_no: 'CS1',
    action: 'checkout',
    preset_digest: null,
    created_at: 0,
    expires_at: expires,
    consumed_at: null,
  });
  it('只能消费一次；过期、跨用户、未知均失效', async () => {
    const db = await InlineDbClient.open();
    await db.call('intents.create', { row: row('a'.repeat(32), 1000) });
    await db.call('intents.create', { row: row('b'.repeat(32), 1000) });
    await db.call('intents.create', { row: row('c'.repeat(32), 1000) });
    expect(
      (await db.call('intents.consume', { nonce: 'a'.repeat(32), profileId: P1, now: 10 })).ok,
    ).toBe(true);
    expect(
      await db.call('intents.consume', { nonce: 'a'.repeat(32), profileId: P1, now: 11 }),
    ).toMatchObject({ ok: false, reason: 'REPLAYED' });
    expect(
      await db.call('intents.consume', { nonce: 'b'.repeat(32), profileId: P1, now: 1000 }),
    ).toMatchObject({ ok: false, reason: 'EXPIRED' });
    expect(
      await db.call('intents.consume', { nonce: 'c'.repeat(32), profileId: P2, now: 10 }),
    ).toMatchObject({
      ok: false,
      reason: 'CROSS_PROFILE',
    });
    // 跨用户尝试后同一 nonce 也不能再被消费
    expect(
      (await db.call('intents.consume', { nonce: 'c'.repeat(32), profileId: P1, now: 10 })).ok,
    ).toBe(false);
    expect(
      await db.call('intents.consume', { nonce: 'd'.repeat(32), profileId: P1, now: 10 }),
    ).toMatchObject({ ok: false, reason: 'UNKNOWN' });
    await db.close();
  });
});

describe('缓存', () => {
  it('库存缓存过期失效；清除缓存不影响收藏、预设和订单恢复记录', async () => {
    const db = await InlineDbClient.open();
    await db.call('favorites.addManual', {
      profileId: P1,
      accountNo: 'CS1',
      now: 1,
      summaryJson: null,
    });
    await db.call('inventory.put', {
      accountNo: 'CS1',
      itemsJson: '[]',
      now: 0,
      expiresAt: 100,
      schemaVersion: 1,
      maxBytes: 1e6,
    });
    expect(
      await db.call('inventory.get', { accountNo: 'CS1', now: 50, schemaVersion: 1 }),
    ).not.toBeNull();
    expect(
      await db.call('inventory.get', { accountNo: 'CS1', now: 100, schemaVersion: 1 }),
    ).toBeNull();
    await db.call('cache.clear', undefined);
    expect((await db.call('favorites.list', { profileId: P1 })).favorites).toHaveLength(1);
    await db.close();
  });
  it('超过磁盘上限时按最近使用时间清理', async () => {
    const db = await InlineDbClient.open();
    const big = JSON.stringify('x'.repeat(400));
    for (let i = 0; i < 5; i++) {
      await db.call('inventory.put', {
        accountNo: `A${i}`,
        itemsJson: big,
        now: i,
        expiresAt: 1e9,
        schemaVersion: 1,
        maxBytes: 1300,
      });
    }
    const usage = await db.call('inventory.usage', undefined);
    expect(usage.bytes).toBeLessThanOrEqual(1300);
    expect(
      await db.call('inventory.get', { accountNo: 'A4', now: 10, schemaVersion: 1 }),
    ).not.toBeNull();
    expect(
      await db.call('inventory.get', { accountNo: 'A0', now: 10, schemaVersion: 1 }),
    ).toBeNull();
    await db.close();
  });

  it('1.0.2 C4/B2: 完整库存宫格摘要不被展示摘要覆盖；profile.lastUsed 返回最近活跃用户', async () => {
    const db = await InlineDbClient.open();
    await db.call('profile.touch', { profileId: P1, now: 100 });
    await db.call('profile.touch', { profileId: P2, now: 200 });
    expect(await db.call('profile.lastUsed', undefined)).toBe(P2);

    const invSummary = JSON.stringify({
      accountNo: 'CS999',
      tags: ['高看点'],
      totalValue: '5000.00',
      prices: { hour: '8.00', day: '80.00', week: null, morning: null, noon: null, evening: null },
      supportedRentKinds: ['HOUR', 'DAY'],
      rentPeriod: 'ANYTIME',
      weekRange: { morning: [], noon: [], evening: [] },
      status: 'AVAILABLE',
      leaseExpireTime: null,
      couponAllowed: true,
      platformCouponConfig: 1,
      durations: { hour: [1, 2], day: [1], week: [] },
      thumbnailUrl: 'https://cdn.fake.local/1.png',
      summaryVersion: 2,
      summarySource: 'inventory',
      summaryUpdatedAt: 100,
      gridItems: Array.from({ length: 9 }, (_, i) => ({
        key: `匕首|蝴蝶刀|p${i}`,
        name: `蝴蝶刀 ${i}`,
        imageUrl: `https://cdn.fake.local/${i}.png`,
        price: `${1000 - i}`,
        exteriorName: '崭新出厂',
        wear: '0.01',
      })),
    });
    const displaySummary = JSON.stringify({
      ...JSON.parse(invSummary),
      prices: { hour: '9.00', day: '90.00', week: null, morning: null, noon: null, evening: null },
      summarySource: 'display',
      summaryUpdatedAt: 200,
      gridItems: [
        {
          key: '匕首|蝴蝶刀|p0',
          name: '蝴蝶刀 0',
          imageUrl: 'https://cdn.fake.local/0.png',
          price: '1000',
          exteriorName: '崭新出厂',
          wear: '0.01',
        },
      ],
    });
    await db.call('favorites.addManual', {
      profileId: P1,
      accountNo: 'CS999',
      now: 100,
      summaryJson: invSummary,
    });
    await db.call('favorites.mergePlatform', {
      profileId: P1,
      accounts: [{ accountNo: 'CS999', summaryJson: displaySummary }],
      complete: true,
      now: 200,
    });
    const list = await db.call('favorites.list', { profileId: P1 });
    const parsed = JSON.parse(list.favorites[0]?.summary_json ?? '{}');
    expect(parsed.summarySource).toBe('inventory');
    expect(parsed.gridItems).toHaveLength(9);
    // 动态价格字段正常更新
    expect(parsed.prices.hour).toBe('9.00');
    await db.close();
  });
});
