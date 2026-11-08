// 通知协议激活参数：只带版本、动作和随机 128 位 nonce（技术选型 §6）。
export const URI_SCHEME = 'jewelry-helper';
export const ACTIVATION_VERSION = '1';
export type ActivationAction = 'view' | 'checkout' | 'list';

export interface Activation {
  action: ActivationAction;
  nonce: string;
}

export function activationUrl(action: ActivationAction, nonce: string): string {
  return `${URI_SCHEME}://notification?v=${ACTIVATION_VERSION}&a=${action}&n=${nonce}`;
}

/** 解析并严格校验；任何不符合格式的参数返回 null（只能打开收藏页）。 */
export function parseActivation(raw: string | null | undefined): Activation | null | 'INVALID' {
  if (!raw) return null;
  if (!raw.toLowerCase().startsWith(`${URI_SCHEME}:`)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== `${URI_SCHEME}:` || url.hostname !== 'notification') return 'INVALID';
    const keys = [...url.searchParams.keys()].sort().join(',');
    if (keys !== 'a,n,v') return 'INVALID';
    if (url.searchParams.get('v') !== ACTIVATION_VERSION) return 'INVALID';
    const action = url.searchParams.get('a');
    const nonce = url.searchParams.get('n') ?? '';
    if (action !== 'view' && action !== 'checkout' && action !== 'list') return 'INVALID';
    if (!/^[0-9a-f]{32}$/.test(nonce)) return 'INVALID';
    return { action, nonce };
  } catch {
    return 'INVALID';
  }
}

export function findActivationArg(argv: string[]): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${URI_SCHEME}:`)) ?? null;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
