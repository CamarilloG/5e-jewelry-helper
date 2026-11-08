// 受控图片缓存：仅允许 HTTPS 的官方 OSS 与 Steam 图像来源，请求不附带鉴权；磁盘上限 256 MiB、最长 7 天（技术选型 §5）。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 256 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 3600 * 1000;
const MAX_IMAGE = 5 * 1024 * 1024;

export type ImageFetcher = (url: string) => Promise<{ body: Buffer; contentType: string } | null>;

const ALLOWED_SUFFIXES = ['.5eplay.com', '.5eplaycdn.com', '.steamstatic.com', '.akamaihd.net'];

export function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/** 渲染进程使用的受控图片地址。 */
export function imageProxyUrl(value: string | null | undefined): string | null {
  if (!value || !isAllowedImageUrl(value)) return null;
  return `jhimg://img/?u=${encodeURIComponent(value)}`;
}

export class ImageCache {
  private inflight = new Map<string, Promise<{ body: Buffer; contentType: string } | null>>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private bytesCache: number | null = null;

  constructor(
    private readonly dir: string,
    private readonly fetcher: ImageFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  private key(url: string) {
    return createHash('sha256').update(url).digest('hex');
  }

  async get(url: string): Promise<{ body: Buffer; contentType: string } | null> {
    if (!isAllowedImageUrl(url)) return null;
    const key = this.key(url);
    const file = path.join(this.dir, `${key}.img`);
    const meta = path.join(this.dir, `${key}.type`);
    try {
      const stat = await fs.promises.stat(file);
      if (this.now() - stat.birthtimeMs < MAX_AGE) {
        const body = await fs.promises.readFile(file);
        const contentType = await fs.promises.readFile(meta, 'utf8').catch(() => 'image/png');
        const t = new Date(this.now());
        fs.promises.utimes(file, t, t).catch(() => undefined);
        return { body, contentType };
      }
    } catch {
      // 未缓存
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const task = this.download(url, file, meta).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** 通知需要本地文件路径；失败返回 null。 */
  async localPath(url: string | null): Promise<string | null> {
    if (!url) return null;
    const result = await this.get(url);
    if (!result) return null;
    const file = path.join(this.dir, `${this.key(url)}.img`);
    return fs.existsSync(file) ? file : null;
  }

  private async download(url: string, file: string, meta: string) {
    await this.acquire();
    try {
      const result = await this.fetcher(url);
      if (!result || result.body.length > MAX_IMAGE) return null;
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(file, result.body);
      await fs.promises.writeFile(meta, result.contentType);
      this.bytesCache = (this.bytesCache ?? 0) + result.body.length;
      if (this.bytesCache > MAX_BYTES) await this.prune();
      return result;
    } catch {
      return null;
    } finally {
      this.release();
    }
  }

  private async acquire() {
    if (this.active < 4) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private release() {
    this.active--;
    this.waiters.shift()?.();
  }

  async usage(): Promise<number> {
    let total = 0;
    try {
      for (const name of await fs.promises.readdir(this.dir)) {
        total += (await fs.promises.stat(path.join(this.dir, name))).size;
      }
    } catch {
      return 0;
    }
    this.bytesCache = total;
    return total;
  }

  async prune(): Promise<void> {
    let entries: { name: string; size: number; used: number; born: number }[] = [];
    try {
      entries = await Promise.all(
        (await fs.promises.readdir(this.dir))
          .filter((n) => n.endsWith('.img'))
          .map(async (name) => {
            const stat = await fs.promises.stat(path.join(this.dir, name));
            return { name, size: stat.size, used: stat.mtimeMs, born: stat.birthtimeMs };
          }),
      );
    } catch {
      return;
    }
    entries.sort((a, b) => b.used - a.used);
    let total = 0;
    for (const entry of entries) {
      total += entry.size;
      if (total > MAX_BYTES || this.now() - entry.born > MAX_AGE) {
        const base = entry.name.slice(0, -4);
        await fs.promises.rm(path.join(this.dir, entry.name), { force: true });
        await fs.promises.rm(path.join(this.dir, `${base}.type`), { force: true });
        total -= entry.size;
      }
    }
    this.bytesCache = total;
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.dir, { recursive: true, force: true });
    this.bytesCache = 0;
  }
}
