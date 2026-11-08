// 渲染进程调用入口：桌面端使用 preload 暴露的具名方法；离线预览（浏览器）使用同源 HTTP 桥。
import type { JewelryApi } from '../../preload/api';
import type { MainEvent } from '../../shared/dto';
import {
  IPC_CHANNELS,
  type IpcChannel,
  type IpcInput,
  type IpcOutputs,
  type IpcResult,
} from '../../shared/ipc';

function previewBridge(): JewelryApi {
  const methods: Record<string, (input?: unknown) => Promise<unknown>> = {};
  for (const channel of IPC_CHANNELS) {
    methods[channel] = async (input?: unknown) => {
      const res = await fetch(`/ipc/${encodeURIComponent(channel)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const result = (await res.json()) as IpcResult<unknown>;
      if (result.ok) return result.value ?? undefined;
      const error = new Error(result.error.message);
      error.name = result.error.code;
      throw error;
    };
  }
  const source = new EventSource('/events');
  return {
    methods: methods as unknown as JewelryApi['methods'],
    on(type, listener) {
      const handler = (e: MessageEvent<string>) =>
        (listener as (p: unknown) => void)(JSON.parse(e.data));
      source.addEventListener(type, handler as EventListener);
      return () => source.removeEventListener(type, handler as EventListener);
    },
  };
}

const bridge: JewelryApi = window.jewelry ?? previewBridge();
export const isPreview = !window.jewelry;

const ipcErrors = new WeakSet<object>();

/** 是否为主进程调用失败（未被页面处理时由全局统一提示）。 */
export function isIpcError(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && ipcErrors.has(error);
}

function normalizeIpcError(error: unknown): Error {
  // fetch 的网络失败是英文 TypeError，不直接展示给用户
  const normalized =
    error instanceof Error && !(error instanceof TypeError)
      ? error
      : new Error('无法连接本地服务，请重试');
  ipcErrors.add(normalized);
  return normalized;
}

export function call<C extends IpcChannel>(
  channel: C,
  ...input: IpcInput<C> extends undefined ? [] : [IpcInput<C>]
): Promise<IpcOutputs[C]> {
  const method = bridge.methods[channel] as (...args: unknown[]) => Promise<IpcOutputs[C]>;
  return method(...input).catch((error: unknown) => {
    throw normalizeIpcError(error);
  });
}

export function on<T extends MainEvent['type']>(
  type: T,
  listener: (payload: Extract<MainEvent, { type: T }>['payload']) => void,
): () => void {
  return bridge.on(type, listener as never);
}

/** 图片地址：桌面端走 jhimg:// 受控协议；离线预览映射到本地占位图服务。 */
export function imgSrc(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (isPreview && url.startsWith('jhimg://')) {
    const target = new URL(url.replace('jhimg://', 'http://')).searchParams.get('u') ?? '';
    return `/jhimg/?u=${encodeURIComponent(target)}`;
  }
  return url;
}
