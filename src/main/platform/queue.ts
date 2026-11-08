// 统一请求调度：所有平台业务请求共用一个执行队列，同时最多 1 个；滚动 60 秒预算 + 平滑间隔；优先级；
// 429 遵守 Retry-After；只读请求网络错误/5xx 最多重试 2 次（2s、5s）；重试计入预算（业务流程 §2）。
import { CancelledError, PlatformError } from './errors';

export enum Priority {
  ORDER_RECOVERY = 0,
  CHECKOUT = 1,
  USER = 2,
  MONITOR = 3,
  SCAN = 4,
  BACKGROUND = 5,
}

export interface TaskOptions {
  priority: Priority;
  /** 取消分组前缀，如 scan:12、monitor */
  group?: string;
  label: string;
}

interface QueuedTask {
  seq: number;
  options: TaskOptions;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface QueueStats {
  limit: number;
  lastMinute: number;
  queued: number;
  waitingMs: number;
  backoffUntil: number | null;
  pausedReason: string | null;
  active: boolean;
}

export interface Clock {
  now(): number;
}

const MINUTE = 60_000;
const READ_RETRY_DELAYS = [2000, 5000];

export class RequestQueue {
  private tasks: QueuedTask[] = [];
  private starts: number[] = [];
  private active = false;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffUntil: number | null = null;
  private pausedReason: string | null = null;
  private blocked = new Set<Priority>();
  private listeners = new Set<() => void>();
  private cancelListeners = new Set<(prefix: string) => void>();

  constructor(
    private limit: number,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('INVALID_LIMIT');
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  setLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('INVALID_LIMIT');
    this.limit = limit;
    this.schedule();
    this.emit();
  }

  getLimit() {
    return this.limit;
  }

  pause(reason: string) {
    this.pausedReason = reason;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit();
  }

  resume() {
    this.pausedReason = null;
    this.schedule();
    this.emit();
  }

  isPaused() {
    return this.pausedReason != null;
  }

  /** 暂停某个优先级的任务（如支付期间暂停库存扫描），任务保留在队列中。 */
  setBlocked(priority: Priority, blocked: boolean) {
    if (blocked) this.blocked.add(priority);
    else this.blocked.delete(priority);
    this.schedule();
    this.emit();
  }

  isBlocked(priority: Priority) {
    return this.blocked.has(priority);
  }

  /** 取消尚未发送的请求；已在执行的请求不受影响。 */
  cancelGroup(prefix: string) {
    const keep: QueuedTask[] = [];
    for (const task of this.tasks) {
      if (task.options.group?.startsWith(prefix)) task.reject(new CancelledError());
      else keep.push(task);
    }
    if (keep.length !== this.tasks.length) {
      this.tasks = keep;
      this.emit();
    }
    for (const listener of this.cancelListeners) {
      listener(prefix);
    }
  }

  upgradeGroupPriority(group: string, priority: Priority) {
    let changed = false;
    for (const task of this.tasks) {
      if (task.options.group === group && priority < task.options.priority) {
        task.options = { ...task.options, priority };
        changed = true;
      }
    }
    if (changed) {
      this.schedule();
      this.emit();
    }
  }

  onCancelGroup(listener: (prefix: string) => void): () => void {
    this.cancelListeners.add(listener);
    return () => {
      this.cancelListeners.delete(listener);
    };
  }

  /** 单次执行（不重试）。排队期间不计网络超时：fn 在真正发送时才被调用。 */
  run<T>(options: TaskOptions, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({
        seq: ++this.seq,
        options,
        run: fn,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.schedule();
      this.emit();
    });
  }

  /** 只读请求：网络错误/超时/5xx 退避重试最多 2 次；429 等待 Retry-After 后重试，同样计入次数。 */
  async runRead<T>(options: TaskOptions, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.run(options, fn);
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        const canRetry = attempt < READ_RETRY_DELAYS.length;
        if (error.code === 'RATE_LIMITED' && canRetry) {
          attempt++;
          continue;
        }
        if (!error.retryable || !canRetry) throw error;
        const delay = READ_RETRY_DELAYS[attempt] ?? 5000;
        attempt++;
        await sleep(delay);
      }
    }
  }

  stats(): QueueStats {
    const now = this.clock.now();
    this.trim(now);
    const runnable = this.tasks.some((t) => !this.blocked.has(t.options.priority));
    return {
      limit: this.limit,
      lastMinute: this.starts.length,
      queued: this.tasks.length,
      waitingMs:
        runnable && !this.active && !this.pausedReason
          ? Math.max(0, this.nextAllowed(now) - now)
          : 0,
      backoffUntil: this.backoffUntil && this.backoffUntil > now ? this.backoffUntil : null,
      pausedReason: this.pausedReason,
      active: this.active,
    };
  }

  /** 测试辅助：仍在 60 秒窗口内的请求起点。 */
  startTimes(): number[] {
    return [...this.starts];
  }

  private trim(now: number) {
    while (this.starts.length > 0 && now - (this.starts[0] ?? 0) >= MINUTE) this.starts.shift();
  }

  private nextAllowed(now: number): number {
    this.trim(now);
    let at = now;
    const last = this.starts.at(-1);
    if (last != null) at = Math.max(at, last + Math.ceil(MINUTE / this.limit));
    if (this.starts.length >= this.limit) {
      const oldest = this.starts[this.starts.length - this.limit] ?? now;
      at = Math.max(at, oldest + MINUTE);
    }
    if (this.backoffUntil != null) at = Math.max(at, this.backoffUntil);
    return at;
  }

  private pick(): QueuedTask | null {
    let best: QueuedTask | null = null;
    for (const task of this.tasks) {
      if (this.blocked.has(task.options.priority)) continue;
      if (
        !best ||
        task.options.priority < best.options.priority ||
        (task.options.priority === best.options.priority && task.seq < best.seq)
      ) {
        best = task;
      }
    }
    return best;
  }

  private schedule() {
    if (this.active || this.pausedReason) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const task = this.pick();
    if (!task) return;
    const now = this.clock.now();
    const at = this.nextAllowed(now);
    if (at > now) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.schedule();
      }, at - now);
      return;
    }
    this.tasks = this.tasks.filter((t) => t !== task);
    this.active = true;
    this.starts.push(now);
    this.emit();
    let runPromise: Promise<unknown>;
    try {
      runPromise = task.run();
    } catch (error) {
      runPromise = Promise.reject(error);
    }
    runPromise
      .then(task.resolve, (error: unknown) => {
        if (error instanceof PlatformError && error.code === 'RATE_LIMITED') {
          this.backoffUntil = this.clock.now() + (error.details.retryAfterMs ?? MINUTE);
        }
        task.reject(error);
      })
      .finally(() => {
        this.active = false;
        this.schedule();
        this.emit();
      });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
