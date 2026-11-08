// SQLite 适配器：只使用 DatabaseSync、预编译语句与事务；迁移前备份，失败恢复并阻止写入（技术选型 §5）。
import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import m001 from './migrations/001_init.sql?raw';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [{ version: 1, name: '001_init', sql: m001 }];

export class MigrationFailedError extends Error {
  constructor(
    message: string,
    readonly restored: boolean,
  ) {
    super(message);
    this.name = 'MigrationFailedError';
  }
}

export interface OpenResult {
  db: DatabaseSync;
  applied: number[];
  backupPath: string | null;
}

export function configure(db: DatabaseSync, file: string): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 事务可能已被 SQLite 自动回滚
    }
    throw error;
  }
}

function currentVersion(db: DatabaseSync): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

function pruneBackups(dir: string, keep: number): void {
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('app-pre-migration-') && name.endsWith('.db'))
    .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const file of files.slice(keep)) fs.rmSync(path.join(dir, file.name), { force: true });
}

export async function openDatabase(
  file: string,
  options: { backupDir?: string; migrations?: Migration[]; now?: () => number } = {},
): Promise<OpenResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  const now = options.now ?? Date.now;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = new DatabaseSync(file);
  configure(db, file);
  const version = currentVersion(db);
  const pending = migrations
    .filter((m) => m.version > version)
    .sort((a, b) => a.version - b.version);
  let backupPath: string | null = null;
  if (pending.length > 0 && file !== ':memory:' && version > 0 && options.backupDir) {
    fs.mkdirSync(options.backupDir, { recursive: true });
    backupPath = path.join(options.backupDir, `app-pre-migration-v${version}-${now()}.db`);
    await backup(db, backupPath);
    pruneBackups(options.backupDir, 3);
  }
  const applied: number[] = [];
  for (const migration of pending) {
    try {
      transaction(db, () => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        ).run(migration.version, migration.name, now());
      });
      applied.push(migration.version);
    } catch (error) {
      let restored = false;
      if (backupPath) {
        db.close();
        for (const suffix of ['-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
        fs.copyFileSync(backupPath, file);
        db = new DatabaseSync(file);
        restored = true;
      }
      db.close();
      const reason = error instanceof Error ? error.message : String(error);
      throw new MigrationFailedError(`迁移 ${migration.name} 失败：${reason}`, restored);
    }
  }
  return { db, applied, backupPath };
}
