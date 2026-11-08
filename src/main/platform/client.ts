// 平台 HTTP 客户端：仅主进程发送鉴权请求；只附加 Content-Type 与客户端原样 Authorization；
// 禁止跟随重定向；按 status===true 判定业务成功（接口与数据规范 §1）。
import type { z } from 'zod';
import type { Logger } from '../logger';
import { PlatformError, sanitizePlatformMessage } from './errors';
import { envelopeSchema } from './schemas';

export const BASE_URL = 'https://gate.5eplay.com/rentinterface/http/v1';

export interface TransportResponse {
  status: number;
  header(name: string): string | null;
  text(): Promise<string>;
}

/** 传输层：生产使用 Electron net.fetch（redirect: 'error'），测试与离线预览使用虚拟平台。 */
export interface HttpTransport {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<TransportResponse>;
}

export interface CredentialSource {
  /** 只在主进程内存中返回凭证；没有时返回 null */
  credential(): string | null;
}

export interface CallResult<T> {
  data: T;
  serverTimeMs: number | null;
}

let traceSeq = 0;

export class PlatformClient {
  constructor(
    private readonly transport: HttpTransport,
    private readonly credentials: CredentialSource,
    private readonly logger: Logger,
    private readonly baseUrl = BASE_URL,
  ) {}

  /** 任何请求得到 HTTP/业务 401 时回调，用于暂停平台任务。 */
  onAuthExpired: (() => void) | null = null;
  /** 关键数据不符合契约时回调，用于显示“平台接口可能已变更”横幅。 */
  onContractChanged: (() => void) | null = null;

  private expired(): never {
    this.onAuthExpired?.();
    throw new PlatformError('AUTH_EXPIRED', 'AUTH_EXPIRED');
  }

  async post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
    timeoutMs: number,
  ): Promise<CallResult<z.infer<S>>> {
    const credential = this.credentials.credential();
    if (!credential) throw new PlatformError('NO_CREDENTIAL', 'NO_CREDENTIAL');
    const traceId = `t${Date.now().toString(36)}${(++traceSeq).toString(36)}`;
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: TransportResponse;
    try {
      response = await this.transport.post(
        `${this.baseUrl}${path}`,
        JSON.stringify(body),
        { 'Content-Type': 'application/json', Authorization: credential },
        controller.signal,
      );
    } catch (error) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      this.logger.warn('platform.request', {
        traceId,
        op: path,
        ms: Date.now() - started,
        reason: timedOut ? 'TIMEOUT' : 'NETWORK',
      });
      if (timedOut) throw new PlatformError('TIMEOUT', 'TIMEOUT');
      const message = error instanceof Error ? error.message : '';
      if (/redirect/i.test(message))
        throw new PlatformError('REDIRECT_BLOCKED', 'REDIRECT_BLOCKED');
      throw new PlatformError('NETWORK', 'NETWORK');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      clearTimeout(timer);
      throw new PlatformError(
        controller.signal.aborted ? 'TIMEOUT' : 'NETWORK',
        'BODY_READ_FAILED',
      );
    }
    clearTimeout(timer);
    const ms = Date.now() - started;
    const status = response.status;
    if (status >= 300 && status < 400) {
      this.logger.warn('platform.request', { traceId, op: path, ms, status, reason: 'REDIRECT' });
      throw new PlatformError('REDIRECT_BLOCKED', 'REDIRECT_BLOCKED', { httpStatus: status });
    }
    if (status === 401) {
      this.logger.warn('platform.request', {
        traceId,
        op: path,
        ms,
        status,
        reason: 'AUTH_EXPIRED',
      });
      this.expired();
    }
    if (status === 429) {
      const retryAfter = parseRetryAfter(response.header('retry-after'));
      this.logger.warn('platform.request', {
        traceId,
        op: path,
        ms,
        status,
        reason: 'RATE_LIMITED',
      });
      throw new PlatformError('RATE_LIMITED', 'RATE_LIMITED', {
        httpStatus: 429,
        retryAfterMs: retryAfter ?? 60_000,
      });
    }
    if (status >= 500) {
      this.logger.warn('platform.request', { traceId, op: path, ms, status, reason: 'SERVER' });
      throw new PlatformError('SERVER', 'SERVER', { httpStatus: status });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.logger.warn('platform.request', { traceId, op: path, ms, status, reason: 'NOT_JSON' });
      if (status >= 400) throw new PlatformError('BUSINESS', 'HTTP_ERROR', { httpStatus: status });
      throw new PlatformError('CONTRACT_CHANGED', 'NOT_JSON', { httpStatus: status });
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      this.logger.warn('platform.request', { traceId, op: path, ms, status, reason: 'ENVELOPE' });
      throw new PlatformError('CONTRACT_CHANGED', 'ENVELOPE', { httpStatus: status });
    }
    const env = envelope.data;
    const businessCode = env.code == null ? null : Number(env.code);
    if (businessCode === 401) {
      this.logger.warn('platform.request', {
        traceId,
        op: path,
        ms,
        status,
        code: 401,
        reason: 'AUTH_EXPIRED',
      });
      this.expired();
    }
    if (env.status !== true) {
      this.logger.info('platform.request', {
        traceId,
        op: path,
        ms,
        status,
        code: businessCode,
        reason: 'BUSINESS',
      });
      throw new PlatformError('BUSINESS', 'BUSINESS', {
        httpStatus: status,
        businessCode: businessCode ?? undefined,
        platformMessage: sanitizePlatformMessage(env.message),
      });
    }
    const parsed = schema.safeParse(env.data);
    if (!parsed.success) {
      this.logger.warn('platform.request', { traceId, op: path, ms, status, reason: 'SCHEMA' });
      this.onContractChanged?.();
      throw new PlatformError('CONTRACT_CHANGED', 'SCHEMA', { httpStatus: status });
    }
    this.logger.info('platform.request', { traceId, op: path, ms, status, code: businessCode });
    const ts = env.timestamp == null ? null : Number(env.timestamp);
    return {
      data: parsed.data,
      serverTimeMs: ts && Number.isFinite(ts) ? (ts > 1e12 ? ts : ts * 1000) : null,
    };
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}
