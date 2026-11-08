// 脱敏日志：只记录操作类型、耗时、状态码和本地追踪 ID；7 天、单文件 5 MiB、总量 20 MiB（技术选型 §7）。
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_FIELDS = new Set([
  'traceId',
  'op',
  'ms',
  'status',
  'code',
  'count',
  'state',
  'reason',
  'phase',
  'kind',
  'attempt',
  'priority',
  'retry',
]);
const MAX_FILE = 5 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 3600 * 1000;

export type LogFields = Partial<Record<string, string | number | boolean | null>>;

/** 去除疑似凭证（长 token、JWT）、URL、长数字串（身份/订单标识）。 */
export function scrubText(value: string): string {
  return value
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .replace(/\d{6,}/g, '[n]')
    .slice(0, 200);
}

export function sanitizeFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key) || value === undefined) continue;
    out[key] = typeof value === 'string' ? scrubText(value) : value;
  }
  return out;
}

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export class FileLogger implements Logger {
  private currentFile: string | null = null;
  private currentSize = 0;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.prune();
  }

  info(event: string, fields: LogFields = {}) {
    this.write('info', event, fields);
  }
  warn(event: string, fields: LogFields = {}) {
    this.write('warn', event, fields);
  }
  error(event: string, fields: LogFields = {}) {
    this.write('error', event, fields);
  }

  private write(level: string, event: string, fields: LogFields) {
    try {
      const line = `${JSON.stringify({ t: new Date(this.now()).toISOString(), level, event: scrubText(event), ...sanitizeFields(fields) })}\n`;
      const file = this.fileFor(Buffer.byteLength(line));
      fs.appendFileSync(file, line, 'utf8');
      this.currentSize += Buffer.byteLength(line);
    } catch {
      // 日志失败不影响业务
    }
  }

  private fileFor(incoming: number): string {
    const day = new Date(this.now()).toISOString().slice(0, 10).replaceAll('-', '');
    if (
      !this.currentFile ||
      !path.basename(this.currentFile).startsWith(`app-${day}`) ||
      this.currentSize + incoming > MAX_FILE
    ) {
      let index = 0;
      let candidate = path.join(this.dir, `app-${day}-${index}.log`);
      while (fs.existsSync(candidate) && fs.statSync(candidate).size + incoming > MAX_FILE) {
        index += 1;
        candidate = path.join(this.dir, `app-${day}-${index}.log`);
      }
      this.currentFile = candidate;
      this.currentSize = fs.existsSync(candidate) ? fs.statSync(candidate).size : 0;
      this.prune();
    }
    return this.currentFile;
  }

  prune() {
    try {
      const files = fs
        .readdirSync(this.dir)
        .filter((n) => n.startsWith('app-') && n.endsWith('.log'))
        .map((n) => {
          const stat = fs.statSync(path.join(this.dir, n));
          return { n, size: stat.size, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      let total = 0;
      for (const f of files) {
        total += f.size;
        if (this.now() - f.mtime > MAX_AGE || total > MAX_TOTAL) {
          if (path.join(this.dir, f.n) !== this.currentFile)
            fs.rmSync(path.join(this.dir, f.n), { force: true });
        }
      }
    } catch {
      // 忽略
    }
  }
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };
