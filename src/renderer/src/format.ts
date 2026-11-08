// 显示格式：金额 2 位小数、≥1 万显示万；时间按系统时区（今天 HH:mm / 昨天 HH:mm / MM-DD HH:mm）。
export { formatYuan } from '../../shared/money';

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay(d, today)) return hm;
  const yesterday = new Date(now - 86_400_000);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '从未';
  const diff = now - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return formatTime(ms, now);
}
