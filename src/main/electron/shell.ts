// Electron 侧适配：平台传输、付款码加载、原生通知、托盘图标。
import { BrowserWindow, Notification, nativeImage, net } from 'electron';
import { type IconTone, renderIcon, toBgra } from '../icon';
import type { HttpTransport, TransportResponse } from '../platform/client';
import type { Notifier, ToastSpec } from '../services/notification-service';

/** 平台请求：Chromium 网络栈（遵守系统代理）；禁止跟随重定向；不携带 Cookie。 */
export const electronTransport: HttpTransport = {
  async post(url, body, headers, signal): Promise<TransportResponse> {
    const response = await net.fetch(url, {
      method: 'POST',
      body,
      headers,
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    return {
      status: response.status,
      header: (name) => response.headers.get(name),
      text: () => response.text(),
    };
  },
};

const MAX_CODE_IMAGE = 2 * 1024 * 1024;

/** 付款码：平台图片地址或图像数据；只在内存中转为 data URL，不落盘、不二次编码。 */
export async function loadPaymentImage(codeUrl: string): Promise<string | null> {
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(codeUrl)) {
    return codeUrl.length <= MAX_CODE_IMAGE * 1.4 ? codeUrl : null;
  }
  let url: URL;
  try {
    url = new URL(codeUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await net.fetch(url.toString(), {
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_CODE_IMAGE) return null;
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class ElectronNotifier implements Notifier {
  private live = new Set<Notification>();

  supported(): boolean {
    return Notification.isSupported();
  }

  show(spec: ToastSpec): boolean {
    try {
      const notice = new Notification({ toastXml: spec.xml });
      this.live.add(notice);
      const drop = () => this.live.delete(notice);
      notice.on('close', drop);
      notice.on('failed', drop);
      setTimeout(drop, 10 * 60_000);
      notice.show();
      return true;
    } catch {
      return false;
    }
  }
}

export function iconImage(size: number, opts: { tone?: IconTone; badge?: number } = {}) {
  return nativeImage.createFromBitmap(toBgra(renderIcon(size, opts)), {
    width: size,
    height: size,
    scaleFactor: 1,
  });
}

export function trayImage(opts: { tone: IconTone; badge: number }) {
  // 32 像素位图按 2 倍缩放提供 16 逻辑像素托盘图标，高 DPI 下保持清晰
  return nativeImage.createFromBitmap(toBgra(renderIcon(32, opts)), {
    width: 32,
    height: 32,
    scaleFactor: 2,
  });
}

export function focusWindow(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export { BrowserWindow };
