// 主进程侧数据库客户端：Worker 实现用于运行时，Inline 实现用于测试与离线预览。
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { executeOp, type OpArgs, type OpName, type OpResult } from './ops';
import { openDatabase } from './sqlite';

export class DbError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export interface DbClient {
  call<K extends OpName>(op: K, args: OpArgs<K>): Promise<OpResult<K>>;
  close(): Promise<void>;
}

export class WorkerDbClient implements DbClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<{ applied: number[] }>;
  private closed = false;

  constructor(workerPath: string, file: string, backupDir: string) {
    this.worker = new Worker(workerPath, { workerData: { file, backupDir } });
    this.ready = new Promise((resolve, reject) => {
      const onMessage = (message: {
        type?: string;
        applied?: number[];
        error?: { name: string; message: string; restored: boolean };
      }) => {
        if (message.type === 'ready') {
          this.worker.off('message', onMessage);
          resolve({ applied: message.applied ?? [] });
        } else if (message.type === 'failed' && message.error) {
          this.worker.off('message', onMessage);
          const error = new DbError(message.error.name, message.error.message);
          (error as DbError & { restored?: boolean }).restored = message.error.restored;
          reject(error);
        }
      };
      this.worker.on('message', onMessage);
      // Worker 无法启动（脚本缺失、加载失败）或提前退出时，打开失败而不是一直等待
      this.worker.once('error', (error) => reject(new DbError('DbWorkerFailed', error.message)));
      this.worker.once('exit', (code) =>
        reject(new DbError('DbWorkerExited', `DB_WORKER_EXIT_${code}`)),
      );
    });
    this.ready.catch(() => undefined);
    this.worker.on(
      'message',
      (message: {
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: { name: string; message: string };
      }) => {
        if (message.id == null) return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else
          entry.reject(
            new DbError(message.error?.name ?? 'Error', message.error?.message ?? 'DB_ERROR'),
          );
      },
    );
    this.worker.on('error', (error) => {
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    });
  }

  call<K extends OpName>(op: K, args: OpArgs<K>): Promise<OpResult<K>> {
    if (this.closed) return Promise.reject(new DbError('DbClosed', 'DB_CLOSED'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.worker.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
      this.worker.postMessage({ type: 'close' });
    });
    await this.worker.terminate();
  }
}

/** 同进程实现：同样逐个串行执行事务，供测试与离线预览使用。 */
export class InlineDbClient implements DbClient {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly db: DatabaseSync) {}

  static async open(file = ':memory:', backupDir?: string): Promise<InlineDbClient> {
    const { db } = await openDatabase(file, { backupDir });
    return new InlineDbClient(db);
  }

  call<K extends OpName>(op: K, args: OpArgs<K>): Promise<OpResult<K>> {
    const next = this.chain.then(
      () => executeOp(this.db, op, structuredClone(args)) as OpResult<K>,
    );
    this.chain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.chain;
    this.db.close();
  }
}
