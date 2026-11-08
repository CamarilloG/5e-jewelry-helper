// 调用冻结解析器：凭证只经子进程标准输出匿名管道返回主进程内存；不经命令行参数、环境变量或文件传递。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type ReaderOutcome =
  | { state: 'READ'; credential: string }
  | { state: 'NO_LOGIN' }
  | { state: 'NO_CLIENT' }
  | { state: 'READ_FAILED'; reason: string };

export type CredentialReader = (directory: string) => Promise<ReaderOutcome>;

export interface ReaderCommand {
  file: string;
  args: string[];
}

/** 打包后使用 resources/auth-reader.exe；开发时使用冻结产物或 .venv-auth 中的 Python。 */
export function locateReader(opts: {
  packaged: boolean;
  resourcesPath: string;
  appRoot: string;
}): ReaderCommand | null {
  if (opts.packaged) {
    const exe = path.join(opts.resourcesPath, 'auth-reader.exe');
    return fs.existsSync(exe) ? { file: exe, args: [] } : null;
  }
  const exe = path.join(opts.appRoot, 'native', 'auth-reader', 'dist', 'auth-reader.exe');
  if (fs.existsSync(exe)) return { file: exe, args: [] };
  const python = path.join(opts.appRoot, '.venv-auth', 'Scripts', 'python.exe');
  const script = path.join(opts.appRoot, 'native', 'auth-reader', 'reader.py');
  if (fs.existsSync(python) && fs.existsSync(script))
    return { file: python, args: ['-X', 'utf8', script] };
  return null;
}

export function createProcessReader(
  command: ReaderCommand | null,
  timeoutMs = 30_000,
): CredentialReader {
  return (directory) =>
    new Promise<ReaderOutcome>((resolve) => {
      if (!command) {
        resolve({ state: 'READ_FAILED', reason: 'READER_MISSING' });
        return;
      }
      const child = spawn(command.file, [...command.args, '--pipe', directory], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
          TEMP: process.env.TEMP ?? '',
          TMP: process.env.TMP ?? '',
        },
      });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (outcome: ReaderOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const chunk of chunks) chunk.fill(0);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ state: 'READ_FAILED', reason: 'TIMEOUT' });
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.on('error', () => finish({ state: 'READ_FAILED', reason: 'SPAWN' }));
      child.on('close', () => {
        const raw = Buffer.concat(chunks);
        let parsed: { state?: string; credential?: unknown; reason?: unknown };
        try {
          parsed = JSON.parse(raw.toString('utf8').trim().split('\n').pop() ?? '{}');
        } catch {
          raw.fill(0);
          finish({ state: 'READ_FAILED', reason: 'PROTOCOL' });
          return;
        }
        raw.fill(0);
        finish(parseOutcome(parsed));
      });
    });
}

export function parseOutcome(parsed: {
  state?: string;
  credential?: unknown;
  reason?: unknown;
}): ReaderOutcome {
  switch (parsed.state) {
    case 'READ':
      return typeof parsed.credential === 'string' && parsed.credential.length > 0
        ? { state: 'READ', credential: parsed.credential }
        : { state: 'NO_LOGIN' };
    case 'NO_LOGIN':
      return { state: 'NO_LOGIN' };
    case 'NO_CLIENT':
      return { state: 'NO_CLIENT' };
    default:
      return {
        state: 'READ_FAILED',
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 40) : 'UNKNOWN',
      };
  }
}

/** JWT 到期时间只作本地预判；无法解析时返回 null（以官方接口结果为准）。 */
export function jwtExpiryMs(credential: string): number | null {
  try {
    const token = credential.replace(/^Bearer\s+/i, '');
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    const exp = Number(json.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}
