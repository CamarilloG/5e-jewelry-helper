// 数据库 Worker：串行执行 SQLite 操作，避免同步数据库调用阻塞主进程事件循环。

import type { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { executeOp } from './ops';
import { MigrationFailedError, openDatabase } from './sqlite';

interface InitData {
  file: string;
  backupDir: string;
}

const port = parentPort;
if (!port) throw new Error('db worker must run in worker thread');

let db: DatabaseSync | null = null;
const ready = openDatabase((workerData as InitData).file, {
  backupDir: (workerData as InitData).backupDir,
})
  .then((result) => {
    db = result.db;
    port.postMessage({ type: 'ready', applied: result.applied });
  })
  .catch((error: unknown) => {
    port.postMessage({
      type: 'failed',
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        restored: error instanceof MigrationFailedError ? error.restored : false,
      },
    });
  });

port.on(
  'message',
  async (message: { id: number; op: string; args: unknown } | { type: 'close' }) => {
    if ('type' in message) {
      await ready;
      db?.close();
      db = null;
      port.postMessage({ type: 'closed' });
      return;
    }
    await ready;
    if (!db) {
      port.postMessage({
        id: message.id,
        ok: false,
        error: { name: 'DbUnavailable', message: 'DB_UNAVAILABLE' },
      });
      return;
    }
    try {
      const result = executeOp(db, message.op, message.args);
      port.postMessage({ id: message.id, ok: true, result });
    } catch (error) {
      port.postMessage({
        id: message.id,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },
);
