// app:// 随包资源协议、jhimg:// 受控图片协议与生产 CSP（技术选型 §3）。
import fs from 'node:fs';
import path from 'node:path';
import { net, protocol, session } from 'electron';
import type { ImageCache } from '../services/image-cache';

export const APP_ORIGIN = 'app://bundle';

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'jhimg', privileges: { standard: true, secure: true } },
  ]);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function productionCsp(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: jhimg:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function developmentCsp(devUrl: string): string {
  const origin = new URL(devUrl).origin;
  const ws = origin.replace(/^http/, 'ws');
  return [
    `default-src 'self' ${origin}`,
    `script-src 'self' ${origin}`,
    `style-src 'self' 'unsafe-inline' ${origin}`,
    `img-src 'self' data: blob: jhimg: ${origin}`,
    `font-src 'self' data: ${origin}`,
    `connect-src 'self' ${origin} ${ws}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function registerAppProtocol(rendererDir: string): void {
  const root = path.resolve(rendererDir);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'bundle') return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.resolve(root, `.${relative}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    const body = await fs.promises.readFile(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': productionCsp(),
        'x-content-type-options': 'nosniff',
      },
    });
  });
}

export function registerImageProtocol(cache: ImageCache): void {
  protocol.handle('jhimg', async (request) => {
    const url = new URL(request.url);
    const target = url.searchParams.get('u');
    if (!target) return new Response('Bad request', { status: 400 });
    const result = await cache.get(target);
    if (!result) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(result.body), {
      headers: { 'content-type': result.contentType, 'cache-control': 'max-age=3600' },
    });
  });
}

/** 开发模式下也为渲染页面加 CSP；生产资源由 app:// 协议直接附带。 */
export function applySessionCsp(devUrl: string | null): void {
  if (!devUrl) return;
  const csp = developmentCsp(devUrl);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
    });
  });
}

/** 图片请求使用 Chromium 网络栈（遵守系统代理）且不附带凭证。 */
export async function electronImageFetch(
  url: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const response = await net.fetch(url, {
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) return null;
  const body = Buffer.from(await response.arrayBuffer());
  return { body, contentType };
}
