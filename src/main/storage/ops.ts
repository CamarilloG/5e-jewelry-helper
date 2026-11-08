// 数据库操作注册表：每个操作在 Worker 中以单个事务执行（技术选型 §3、§5）。
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { transaction } from './sqlite';

function all<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}
function get<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
function run(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}

// ---------- 行类型 ----------

export interface FavoriteRow {
  profile_id: string;
  account_no: string;
  monitor_enabled: number;
  source: 'local' | 'platform';
  platform_state: 'favorited' | 'removed' | 'unknown';
  trusted_status: string | null;
  trusted_at: number | null;
  display_status: string;
  display_error: string | null;
  checked_at: number | null;
  expire_time_ms: number | null;
  last_change_at: number | null;
  last_change_from: string | null;
  last_change_to: string | null;
  cycle_id: number;
  notified_cycle: number;
  baseline_pending: number;
  unseen: number;
  summary_json: string | null;
  created_at: number;
}

export interface SyncOpRow {
  profile_id: string;
  account_no: string;
  target_status: 0 | 1;
  revision: number;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

export interface PresetRow {
  profile_id: string;
  account_no: string;
  rent_kind: string;
  quantity: number;
  pay_channel: number;
  auto_coupon: number;
  updated_at: number;
}

export interface TombstoneRow {
  profile_id: string;
  account_no: string;
  removed_at: number;
  reason: string;
}

export interface FilterPresetRow {
  id: string;
  profile_id: string;
  name: string;
  conditions_json: string;
  schema_version: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export interface AttemptRow {
  attempt_id: string;
  profile_id: string;
  account_no: string;
  params_json: string;
  state: string;
  payment_order_id: string | null;
  deadline_ms: number | null;
  release_state: string;
  lock_requested: number;
  create_sent: number;
  cleanup_done: number;
  finished: number;
  reason_json: string | null;
  resolution: string | null;
  trace_id: string;
  created_at: number;
  updated_at: number;
}

export interface IntentRow {
  nonce: string;
  profile_id: string;
  account_no: string | null;
  action: string;
  preset_digest: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

// ---------- 操作 ----------

function ensureProfile(db: DatabaseSync, profileId: string, now: number): void {
  run(
    db,
    `INSERT INTO profiles (profile_id, created_at, last_used_at) VALUES (?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET last_used_at = excluded.last_used_at`,
    profileId,
    now,
    now,
  );
}

function nextRevision(db: DatabaseSync, profileId: string, accountNo: string): number {
  const row = get<{ revision: number }>(
    db,
    'SELECT revision FROM favorite_sync_ops WHERE profile_id = ? AND account_no = ?',
    profileId,
    accountNo,
  );
  const meta = get<{ value_json: string }>(
    db,
    'SELECT value_json FROM settings WHERE profile_id = ? AND key = ?',
    profileId,
    `revision:${accountNo}`,
  );
  const last = Math.max(row?.revision ?? 0, meta ? Number(JSON.parse(meta.value_json)) : 0);
  const next = last + 1;
  run(
    db,
    `INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    profileId,
    `revision:${accountNo}`,
    JSON.stringify(next),
    Date.now(),
  );
  return next;
}

function upsertSyncOp(
  db: DatabaseSync,
  profileId: string,
  accountNo: string,
  target: 0 | 1,
): number {
  const revision = nextRevision(db, profileId, accountNo);
  run(
    db,
    `INSERT INTO favorite_sync_ops (profile_id, account_no, target_status, revision, attempts, next_attempt_at, last_error)
     VALUES (?, ?, ?, ?, 0, 0, NULL)
     ON CONFLICT(profile_id, account_no) DO UPDATE SET target_status = excluded.target_status,
       revision = excluded.revision, attempts = 0, next_attempt_at = 0, last_error = NULL`,
    profileId,
    accountNo,
    target,
    revision,
  );
  return revision;
}

function insertFavorite(
  db: DatabaseSync,
  profileId: string,
  accountNo: string,
  source: 'local' | 'platform',
  platformState: FavoriteRow['platform_state'],
  now: number,
  summaryJson: string | null,
): void {
  run(
    db,
    `INSERT INTO favorites (profile_id, account_no, monitor_enabled, source, platform_state, baseline_pending, created_at, summary_json)
     VALUES (?, ?, 1, ?, ?, 1, ?, ?)
     ON CONFLICT(profile_id, account_no) DO NOTHING`,
    profileId,
    accountNo,
    source,
    platformState,
    now,
    summaryJson,
  );
}

export const ops = {
  'profile.touch'(db: DatabaseSync, a: { profileId: string; now: number }) {
    ensureProfile(db, a.profileId, a.now);
    return true;
  },

  'settings.get'(db: DatabaseSync, a: { scope: string; key: string }) {
    const row = get<{ value_json: string }>(
      db,
      'SELECT value_json FROM settings WHERE profile_id = ? AND key = ?',
      a.scope,
      a.key,
    );
    return row ? (JSON.parse(row.value_json) as unknown) : null;
  },

  'settings.set'(db: DatabaseSync, a: { scope: string; key: string; value: unknown; now: number }) {
    run(
      db,
      `INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      a.scope,
      a.key,
      JSON.stringify(a.value),
      a.now,
    );
    return true;
  },

  // ----- 收藏 -----
  'favorites.list'(db: DatabaseSync, a: { profileId: string }) {
    const favorites = all<FavoriteRow>(
      db,
      'SELECT * FROM favorites WHERE profile_id = ? ORDER BY created_at DESC',
      a.profileId,
    );
    const syncOps = all<SyncOpRow>(
      db,
      'SELECT * FROM favorite_sync_ops WHERE profile_id = ?',
      a.profileId,
    );
    const presets = all<PresetRow>(
      db,
      'SELECT * FROM order_presets WHERE profile_id = ?',
      a.profileId,
    );
    const tombstones = all<TombstoneRow>(
      db,
      'SELECT * FROM favorite_tombstones WHERE profile_id = ? ORDER BY removed_at DESC',
      a.profileId,
    );
    return { favorites, syncOps, presets, tombstones };
  },

  'favorites.get'(db: DatabaseSync, a: { profileId: string; accountNo: string }) {
    return (
      get<FavoriteRow>(
        db,
        'SELECT * FROM favorites WHERE profile_id = ? AND account_no = ?',
        a.profileId,
        a.accountNo,
      ) ?? null
    );
  },

  /** 工具内手动收藏：写本地、清移除记录、目标状态 1 的同步意图。 */
  'favorites.addManual'(
    db: DatabaseSync,
    a: { profileId: string; accountNo: string; now: number; summaryJson: string | null },
  ) {
    ensureProfile(db, a.profileId, a.now);
    insertFavorite(db, a.profileId, a.accountNo, 'local', 'unknown', a.now, a.summaryJson);
    run(
      db,
      'DELETE FROM favorite_tombstones WHERE profile_id = ? AND account_no = ?',
      a.profileId,
      a.accountNo,
    );
    return { revision: upsertSyncOp(db, a.profileId, a.accountNo, 1) };
  },

  /** 工具内取消收藏：本地移除记录；勾选同步平台时追加目标状态 0。 */
  'favorites.removeManual'(
    db: DatabaseSync,
    a: { profileId: string; accountNo: string; alsoPlatform: boolean; now: number },
  ) {
    ensureProfile(db, a.profileId, a.now);
    run(
      db,
      'DELETE FROM favorites WHERE profile_id = ? AND account_no = ?',
      a.profileId,
      a.accountNo,
    );
    run(
      db,
      `INSERT INTO favorite_tombstones (profile_id, account_no, removed_at, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, account_no) DO UPDATE SET removed_at = excluded.removed_at, reason = excluded.reason`,
      a.profileId,
      a.accountNo,
      a.now,
      a.alsoPlatform ? 'LOCAL_AND_PLATFORM' : 'LOCAL_ONLY',
    );
    const revision = a.alsoPlatform ? upsertSyncOp(db, a.profileId, a.accountNo, 0) : null;
    return { revision };
  },

  /** 恢复已移除的收藏：只恢复本地，不写回平台。 */
  'favorites.restore'(db: DatabaseSync, a: { profileId: string; accountNo: string; now: number }) {
    ensureProfile(db, a.profileId, a.now);
    const removed = run(
      db,
      'DELETE FROM favorite_tombstones WHERE profile_id = ? AND account_no = ?',
      a.profileId,
      a.accountNo,
    );
    if (removed.changes === 0) return false;
    insertFavorite(db, a.profileId, a.accountNo, 'local', 'unknown', a.now, null);
    return true;
  },

  /** 平台收藏完整快照合并：只增不删；只有完整快照才能标记平台已取消。 */
  'favorites.mergePlatform'(
    db: DatabaseSync,
    a: {
      profileId: string;
      accounts: { accountNo: string; summaryJson: string | null }[];
      complete: boolean;
      now: number;
    },
  ) {
    ensureProfile(db, a.profileId, a.now);
    if (!a.complete) return { added: [] as string[], removedOnPlatform: [] as string[] };
    const present = new Set(a.accounts.map((x) => x.accountNo));
    const tomb = new Set(
      all<{ account_no: string }>(
        db,
        'SELECT account_no FROM favorite_tombstones WHERE profile_id = ?',
        a.profileId,
      ).map((r) => r.account_no),
    );
    const local = new Map(
      all<FavoriteRow>(db, 'SELECT * FROM favorites WHERE profile_id = ?', a.profileId).map((r) => [
        r.account_no,
        r,
      ]),
    );
    const pending = new Map(
      all<SyncOpRow>(db, 'SELECT * FROM favorite_sync_ops WHERE profile_id = ?', a.profileId).map(
        (r) => [r.account_no, r],
      ),
    );
    const added: string[] = [];
    for (const item of a.accounts) {
      const row = local.get(item.accountNo);
      if (row) {
        const op = pending.get(item.accountNo);
        // 有未完成的目标状态 0 时以用户意图为准，不据平台快照改写
        if (!(op && op.target_status === 0)) {
          run(
            db,
            `UPDATE favorites SET platform_state = 'favorited', summary_json = COALESCE(?, summary_json)
             WHERE profile_id = ? AND account_no = ?`,
            item.summaryJson,
            a.profileId,
            item.accountNo,
          );
        }
        continue;
      }
      if (tomb.has(item.accountNo)) continue;
      insertFavorite(
        db,
        a.profileId,
        item.accountNo,
        'platform',
        'favorited',
        a.now,
        item.summaryJson,
      );
      added.push(item.accountNo);
    }
    const removedOnPlatform: string[] = [];
    for (const [accountNo, row] of local) {
      if (present.has(accountNo)) continue;
      const op = pending.get(accountNo);
      if (op && op.target_status === 1) continue;
      if (row.platform_state !== 'removed') removedOnPlatform.push(accountNo);
      run(
        db,
        `UPDATE favorites SET platform_state = 'removed' WHERE profile_id = ? AND account_no = ?`,
        a.profileId,
        accountNo,
      );
    }
    return { added, removedOnPlatform };
  },

  'favorites.setMonitor'(
    db: DatabaseSync,
    a: { profileId: string; accountNo: string; enabled: boolean },
  ) {
    run(
      db,
      `UPDATE favorites SET monitor_enabled = ?, baseline_pending = CASE WHEN ? = 1 THEN 1 ELSE baseline_pending END
       WHERE profile_id = ? AND account_no = ?`,
      a.enabled ? 1 : 0,
      a.enabled ? 1 : 0,
      a.profileId,
      a.accountNo,
    );
    return true;
  },

  'favorites.updateSummary'(
    db: DatabaseSync,
    a: { profileId: string; accountNo: string; summaryJson: string },
  ) {
    run(
      db,
      'UPDATE favorites SET summary_json = ? WHERE profile_id = ? AND account_no = ?',
      a.summaryJson,
      a.profileId,
      a.accountNo,
    );
    return true;
  },

  'favorites.markSeen'(db: DatabaseSync, a: { profileId: string; accountNo: string | null }) {
    if (a.accountNo) {
      run(
        db,
        'UPDATE favorites SET unseen = 0 WHERE profile_id = ? AND account_no = ?',
        a.profileId,
        a.accountNo,
      );
    } else {
      run(db, 'UPDATE favorites SET unseen = 0 WHERE profile_id = ?', a.profileId);
    }
    return true;
  },

  /** 写入监测轮次的观测结果（由领域函数计算）。 */
  'favorites.applyObservations'(
    db: DatabaseSync,
    a: {
      profileId: string;
      updates: {
        accountNo: string;
        trustedStatus: string | null;
        trustedAt: number | null;
        displayStatus: string;
        displayError: string | null;
        checkedAt: number;
        expireTimeMs: number | null;
        lastChangeAt: number | null;
        lastChangeFrom: string | null;
        lastChangeTo: string | null;
        cycleId: number;
        notifiedCycle: number;
        baselinePending: number;
        unseen: number;
        summaryJson: string | null;
      }[];
    },
  ) {
    const stmt = db.prepare(
      `UPDATE favorites SET trusted_status = ?, trusted_at = ?, display_status = ?, display_error = ?, checked_at = ?,
         expire_time_ms = ?, last_change_at = ?, last_change_from = ?, last_change_to = ?, cycle_id = ?, notified_cycle = ?,
         baseline_pending = ?, unseen = ?, summary_json = COALESCE(?, summary_json)
       WHERE profile_id = ? AND account_no = ?`,
    );
    for (const u of a.updates) {
      stmt.run(
        u.trustedStatus,
        u.trustedAt,
        u.displayStatus,
        u.displayError,
        u.checkedAt,
        u.expireTimeMs,
        u.lastChangeAt,
        u.lastChangeFrom,
        u.lastChangeTo,
        u.cycleId,
        u.notifiedCycle,
        u.baselinePending,
        u.unseen,
        u.summaryJson,
        a.profileId,
        u.accountNo,
      );
    }
    return true;
  },

  'syncOps.due'(db: DatabaseSync, a: { profileId: string; now: number }) {
    return all<SyncOpRow>(
      db,
      'SELECT * FROM favorite_sync_ops WHERE profile_id = ? AND next_attempt_at <= ? ORDER BY account_no',
      a.profileId,
      a.now,
    );
  },

  /** 写回成功：仅当 revision 仍为最新时移除意图并更新平台状态。 */
  'syncOps.succeeded'(
    db: DatabaseSync,
    a: { profileId: string; accountNo: string; revision: number },
  ) {
    const op = get<SyncOpRow>(
      db,
      'SELECT * FROM favorite_sync_ops WHERE profile_id = ? AND account_no = ?',
      a.profileId,
      a.accountNo,
    );
    if (!op || op.revision !== a.revision) return { current: false };
    run(
      db,
      'DELETE FROM favorite_sync_ops WHERE profile_id = ? AND account_no = ?',
      a.profileId,
      a.accountNo,
    );
    run(
      db,
      'UPDATE favorites SET platform_state = ? WHERE profile_id = ? AND account_no = ?',
      op.target_status === 1 ? 'favorited' : 'removed',
      a.profileId,
      a.accountNo,
    );
    return { current: true };
  },

  'syncOps.failed'(
    db: DatabaseSync,
    a: {
      profileId: string;
      accountNo: string;
      revision: number;
      error: string;
      nextAttemptAt: number;
    },
  ) {
    const res = run(
      db,
      `UPDATE favorite_sync_ops SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
       WHERE profile_id = ? AND account_no = ? AND revision = ?`,
      a.error,
      a.nextAttemptAt,
      a.profileId,
      a.accountNo,
      a.revision,
    );
    return { current: res.changes > 0 };
  },

  // ----- 下单预设 -----
  'presets.get'(db: DatabaseSync, a: { profileId: string; accountNo: string }) {
    return (
      get<PresetRow>(
        db,
        'SELECT * FROM order_presets WHERE profile_id = ? AND account_no = ?',
        a.profileId,
        a.accountNo,
      ) ?? null
    );
  },

  'presets.save'(
    db: DatabaseSync,
    a: {
      profileId: string;
      accountNo: string;
      rentKind: string;
      quantity: number;
      payChannel: number;
      autoCoupon: boolean;
      now: number;
    },
  ) {
    ensureProfile(db, a.profileId, a.now);
    run(
      db,
      `INSERT INTO order_presets (profile_id, account_no, rent_kind, quantity, pay_channel, auto_coupon, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, account_no) DO UPDATE SET rent_kind = excluded.rent_kind, quantity = excluded.quantity,
         pay_channel = excluded.pay_channel, auto_coupon = excluded.auto_coupon, updated_at = excluded.updated_at`,
      a.profileId,
      a.accountNo,
      a.rentKind,
      a.quantity,
      a.payChannel,
      a.autoCoupon ? 1 : 0,
      a.now,
    );
    return true;
  },

  // ----- 常用方案 -----
  'filters.list'(db: DatabaseSync, a: { profileId: string }) {
    return all<FilterPresetRow>(
      db,
      'SELECT * FROM filter_presets WHERE profile_id = ? ORDER BY COALESCE(last_used_at, created_at) DESC',
      a.profileId,
    );
  },

  'filters.save'(
    db: DatabaseSync,
    a: {
      profileId: string;
      id: string;
      name: string;
      conditionsJson: string;
      schemaVersion: number;
      overwriteId: string | null;
      now: number;
    },
  ) {
    ensureProfile(db, a.profileId, a.now);
    const clash = get<FilterPresetRow>(
      db,
      'SELECT * FROM filter_presets WHERE profile_id = ? AND name = ?',
      a.profileId,
      a.name,
    );
    if (a.overwriteId) {
      if (clash && clash.id !== a.overwriteId)
        return { ok: false as const, reason: 'DUPLICATE_NAME' };
      const res = run(
        db,
        `UPDATE filter_presets SET name = ?, conditions_json = ?, schema_version = ?, updated_at = ?, last_used_at = ?
         WHERE id = ? AND profile_id = ?`,
        a.name,
        a.conditionsJson,
        a.schemaVersion,
        a.now,
        a.now,
        a.overwriteId,
        a.profileId,
      );
      if (res.changes === 0) return { ok: false as const, reason: 'NOT_FOUND' };
      return { ok: true as const, id: a.overwriteId };
    }
    if (clash) return { ok: false as const, reason: 'DUPLICATE_NAME', existingId: clash.id };
    run(
      db,
      `INSERT INTO filter_presets (id, profile_id, name, conditions_json, schema_version, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.profileId,
      a.name,
      a.conditionsJson,
      a.schemaVersion,
      a.now,
      a.now,
      a.now,
    );
    return { ok: true as const, id: a.id };
  },

  'filters.rename'(
    db: DatabaseSync,
    a: { profileId: string; id: string; name: string; now: number },
  ) {
    const clash = get<FilterPresetRow>(
      db,
      'SELECT * FROM filter_presets WHERE profile_id = ? AND name = ? AND id <> ?',
      a.profileId,
      a.name,
      a.id,
    );
    if (clash) return { ok: false as const, reason: 'DUPLICATE_NAME' };
    const res = run(
      db,
      'UPDATE filter_presets SET name = ?, updated_at = ? WHERE id = ? AND profile_id = ?',
      a.name,
      a.now,
      a.id,
      a.profileId,
    );
    return res.changes ? { ok: true as const } : { ok: false as const, reason: 'NOT_FOUND' };
  },

  'filters.delete'(db: DatabaseSync, a: { profileId: string; id: string }) {
    return (
      run(db, 'DELETE FROM filter_presets WHERE id = ? AND profile_id = ?', a.id, a.profileId)
        .changes > 0
    );
  },

  'filters.touch'(db: DatabaseSync, a: { profileId: string; id: string; now: number }) {
    run(
      db,
      'UPDATE filter_presets SET last_used_at = ? WHERE id = ? AND profile_id = ?',
      a.now,
      a.id,
      a.profileId,
    );
    return (
      get<FilterPresetRow>(
        db,
        'SELECT * FROM filter_presets WHERE id = ? AND profile_id = ?',
        a.id,
        a.profileId,
      ) ?? null
    );
  },

  // ----- 账号快照与库存缓存 -----
  'snapshots.put'(
    db: DatabaseSync,
    a: {
      items: { accountNo: string; dataJson: string; source: string }[];
      now: number;
      schemaVersion: number;
    },
  ) {
    const stmt = db.prepare(
      `INSERT INTO account_snapshots (account_no, data_json, source, fetched_at, schema_version) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_no) DO UPDATE SET data_json = excluded.data_json, source = excluded.source,
         fetched_at = excluded.fetched_at, schema_version = excluded.schema_version`,
    );
    for (const item of a.items)
      stmt.run(item.accountNo, item.dataJson, item.source, a.now, a.schemaVersion);
    return true;
  },

  'snapshots.getMany'(db: DatabaseSync, a: { accountNos: string[]; schemaVersion: number }) {
    if (a.accountNos.length === 0) return [];
    const stmt = db.prepare(
      'SELECT account_no, data_json, fetched_at FROM account_snapshots WHERE account_no = ? AND schema_version = ?',
    );
    const out: { account_no: string; data_json: string; fetched_at: number }[] = [];
    for (const no of a.accountNos) {
      const row = stmt.get(no, a.schemaVersion) as unknown as
        | { account_no: string; data_json: string; fetched_at: number }
        | undefined;
      if (row) out.push(row);
    }
    return out;
  },

  'snapshots.all'(db: DatabaseSync, a: { schemaVersion: number }) {
    return all<{ account_no: string; data_json: string; fetched_at: number }>(
      db,
      'SELECT account_no, data_json, fetched_at FROM account_snapshots WHERE schema_version = ?',
      a.schemaVersion,
    );
  },

  'inventory.get'(db: DatabaseSync, a: { accountNo: string; now: number; schemaVersion: number }) {
    const row = get<{ items_json: string; fetched_at: number; expires_at: number }>(
      db,
      'SELECT items_json, fetched_at, expires_at FROM inventory_cache WHERE account_no = ? AND schema_version = ?',
      a.accountNo,
      a.schemaVersion,
    );
    if (!row || row.expires_at <= a.now) return null;
    run(db, 'UPDATE inventory_cache SET last_used_at = ? WHERE account_no = ?', a.now, a.accountNo);
    return row;
  },

  'inventory.put'(
    db: DatabaseSync,
    a: {
      accountNo: string;
      itemsJson: string;
      now: number;
      expiresAt: number;
      schemaVersion: number;
      maxBytes: number;
    },
  ) {
    const bytes = Buffer.byteLength(a.itemsJson, 'utf8');
    run(
      db,
      `INSERT INTO inventory_cache (account_no, items_json, bytes, fetched_at, expires_at, last_used_at, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_no) DO UPDATE SET items_json = excluded.items_json, bytes = excluded.bytes,
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, last_used_at = excluded.last_used_at,
         schema_version = excluded.schema_version`,
      a.accountNo,
      a.itemsJson,
      bytes,
      a.now,
      a.expiresAt,
      a.now,
      a.schemaVersion,
    );
    run(db, 'DELETE FROM inventory_cache WHERE expires_at <= ?', a.now);
    let total =
      get<{ t: number | null }>(db, 'SELECT SUM(bytes) AS t FROM inventory_cache')?.t ?? 0;
    if (total > a.maxBytes) {
      const rows = all<{ account_no: string; bytes: number }>(
        db,
        'SELECT account_no, bytes FROM inventory_cache ORDER BY last_used_at ASC',
      );
      for (const row of rows) {
        if (total <= a.maxBytes) break;
        run(db, 'DELETE FROM inventory_cache WHERE account_no = ?', row.account_no);
        total -= row.bytes;
      }
    }
    return true;
  },

  'inventory.usage'(db: DatabaseSync) {
    const row = get<{ t: number | null; n: number }>(
      db,
      'SELECT SUM(bytes) AS t, COUNT(*) AS n FROM inventory_cache',
    );
    return { bytes: row?.t ?? 0, entries: row?.n ?? 0 };
  },

  /** 清除缓存：只清库存与账号快照缓存，不触碰收藏、预设和订单恢复记录。 */
  'cache.clear'(db: DatabaseSync) {
    run(db, 'DELETE FROM inventory_cache');
    run(db, 'DELETE FROM account_snapshots');
    return true;
  },

  // ----- 出码尝试 -----
  'attempts.create'(db: DatabaseSync, a: { row: AttemptRow }) {
    ensureProfile(db, a.row.profile_id, a.row.created_at);
    const open = get<{ attempt_id: string }>(
      db,
      'SELECT attempt_id FROM order_attempts WHERE profile_id = ? AND finished = 0',
      a.row.profile_id,
    );
    if (open) return { ok: false as const, openAttemptId: open.attempt_id };
    const r = a.row;
    run(
      db,
      `INSERT INTO order_attempts (attempt_id, profile_id, account_no, params_json, state, payment_order_id, deadline_ms,
         release_state, lock_requested, create_sent, cleanup_done, finished, reason_json, resolution, trace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.attempt_id,
      r.profile_id,
      r.account_no,
      r.params_json,
      r.state,
      r.payment_order_id,
      r.deadline_ms,
      r.release_state,
      r.lock_requested,
      r.create_sent,
      r.cleanup_done,
      r.finished,
      r.reason_json,
      r.resolution,
      r.trace_id,
      r.created_at,
      r.updated_at,
    );
    return { ok: true as const };
  },

  'attempts.update'(
    db: DatabaseSync,
    a: { attemptId: string; patch: Partial<Omit<AttemptRow, 'attempt_id' | 'profile_id'>> },
  ) {
    const keys = Object.keys(a.patch) as (keyof typeof a.patch)[];
    if (keys.length === 0) return true;
    const allowed = new Set([
      'account_no',
      'params_json',
      'state',
      'payment_order_id',
      'deadline_ms',
      'release_state',
      'lock_requested',
      'create_sent',
      'cleanup_done',
      'finished',
      'reason_json',
      'resolution',
      'updated_at',
    ]);
    const cols = keys.filter((k) => allowed.has(k));
    const sql = `UPDATE order_attempts SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE attempt_id = ?`;
    const values = cols.map((c) => (a.patch[c] ?? null) as SQLInputValue);
    run(db, sql, ...values, a.attemptId);
    return true;
  },

  'attempts.open'(db: DatabaseSync, a: { profileId: string }) {
    return (
      get<AttemptRow>(
        db,
        'SELECT * FROM order_attempts WHERE profile_id = ? AND finished = 0 ORDER BY created_at DESC LIMIT 1',
        a.profileId,
      ) ?? null
    );
  },

  'attempts.openAll'(db: DatabaseSync) {
    return all<AttemptRow>(
      db,
      'SELECT * FROM order_attempts WHERE finished = 0 ORDER BY created_at',
    );
  },

  'attempts.get'(db: DatabaseSync, a: { attemptId: string }) {
    return (
      get<AttemptRow>(db, 'SELECT * FROM order_attempts WHERE attempt_id = ?', a.attemptId) ?? null
    );
  },

  // ----- 通知意图 -----
  'intents.create'(db: DatabaseSync, a: { row: IntentRow }) {
    const r = a.row;
    run(
      db,
      `INSERT INTO notification_intents (nonce, profile_id, account_no, action, preset_digest, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      r.nonce,
      r.profile_id,
      r.account_no,
      r.action,
      r.preset_digest,
      r.created_at,
      r.expires_at,
    );
    run(db, 'DELETE FROM notification_intents WHERE expires_at < ?', r.created_at - 86_400_000);
    return true;
  },

  /** 一次性消费：成功返回意图，否则给出失效原因；任何查询都不会让同一 nonce 被消费两次。 */
  'intents.consume'(db: DatabaseSync, a: { nonce: string; profileId: string | null; now: number }) {
    const row = get<IntentRow>(db, 'SELECT * FROM notification_intents WHERE nonce = ?', a.nonce);
    if (!row) return { ok: false as const, reason: 'UNKNOWN' };
    if (row.consumed_at != null) return { ok: false as const, reason: 'REPLAYED', intent: row };
    run(db, 'UPDATE notification_intents SET consumed_at = ? WHERE nonce = ?', a.now, a.nonce);
    if (row.expires_at <= a.now) return { ok: false as const, reason: 'EXPIRED', intent: row };
    if (!a.profileId || row.profile_id !== a.profileId)
      return { ok: false as const, reason: 'CROSS_PROFILE', intent: row };
    return { ok: true as const, intent: row };
  },
} satisfies Record<string, (db: DatabaseSync, args: never) => unknown>;

export type Ops = typeof ops;
export type OpName = keyof Ops;
export type OpArgs<K extends OpName> = Parameters<Ops[K]>[1];
export type OpResult<K extends OpName> = ReturnType<Ops[K]>;

export function executeOp(db: DatabaseSync, name: string, args: unknown): unknown {
  const fn = (ops as Record<string, (db: DatabaseSync, args: unknown) => unknown>)[name];
  if (!fn) throw new Error(`UNKNOWN_DB_OP:${name}`);
  return transaction(db, () => fn(db, args));
}
