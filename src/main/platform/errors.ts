// 具名错误类型：平台响应按代码、字段和阶段映射（接口与数据规范 §1、§7）。
export type PlatformErrorCode =
  | 'AUTH_EXPIRED'
  | 'CONTRACT_CHANGED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SERVER'
  | 'RATE_LIMITED'
  | 'BUSINESS'
  | 'REDIRECT_BLOCKED'
  | 'NO_CREDENTIAL';

export class PlatformError extends Error {
  constructor(
    readonly code: PlatformErrorCode,
    message: string,
    readonly details: {
      httpStatus?: number;
      businessCode?: number;
      retryAfterMs?: number;
      /** 平台业务提示，已脱敏，可展示 */
      platformMessage?: string;
    } = {},
  ) {
    super(message);
    this.name = 'PlatformError';
  }

  /** 网络错误、超时、5xx 可对只读请求重试。 */
  get retryable(): boolean {
    return this.code === 'NETWORK' || this.code === 'TIMEOUT' || this.code === 'SERVER';
  }
}

export class CancelledError extends Error {
  constructor(message = 'CANCELLED') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancelled(error: unknown): error is CancelledError {
  return error instanceof CancelledError;
}

export function errorCode(error: unknown): string {
  if (error instanceof PlatformError) return error.code;
  if (error instanceof CancelledError) return 'CANCELLED';
  if (error instanceof Error) return error.name;
  return 'UNKNOWN';
}

/** 平台业务提示脱敏：去掉疑似标识与 URL，限制长度。 */
export function sanitizePlatformMessage(message: unknown): string {
  if (typeof message !== 'string') return '';
  return message
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[A-Za-z0-9_-]{24,}/g, '')
    .replace(/\d{8,}/g, '')
    .trim()
    .slice(0, 120);
}

/** 面向用户的错误文案（不含凭证与原始响应）。 */
export function userMessage(error: unknown): string {
  if (error instanceof PlatformError) {
    switch (error.code) {
      case 'AUTH_EXPIRED':
        return '登录态已失效，请在 5E 客户端重新登录后重新读取';
      case 'CONTRACT_CHANGED':
        return '平台接口可能已变更，部分功能暂不可用';
      case 'NETWORK':
        return '网络连接失败，请检查网络或代理';
      case 'TIMEOUT':
        return '请求超时';
      case 'SERVER':
        return '平台服务暂时异常';
      case 'RATE_LIMITED':
        return '平台限流，已暂停请求';
      case 'BUSINESS':
        return error.details.platformMessage || '平台拒绝了请求';
      case 'REDIRECT_BLOCKED':
        return '平台返回了意外的跳转，已拦截';
      case 'NO_CREDENTIAL':
        return '未读取到登录态';
    }
  }
  if (error instanceof CancelledError) return '已取消';
  return '发生未知错误';
}
