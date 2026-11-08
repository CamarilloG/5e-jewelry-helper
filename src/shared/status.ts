// 账号状态判定（接口与数据规范 §3）：缺字段→未知；不在架→已下架；在架租用→租赁中；在架空闲→可租。
export const ACCOUNT_STATUSES = ['AVAILABLE', 'RENTED', 'OFF_SHELF', 'UNKNOWN'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const STATUS_LABEL: Record<AccountStatus, string> = {
  AVAILABLE: '可租',
  RENTED: '租赁中',
  OFF_SHELF: '已下架',
  UNKNOWN: '未知',
};

function asInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

export function accountStatus(shelfStatus: unknown, rentStatus: unknown): AccountStatus {
  const shelf = asInteger(shelfStatus);
  const rent = asInteger(rentStatus);
  if (shelf == null || rent == null) return 'UNKNOWN';
  if (shelf !== 1) return 'OFF_SHELF';
  if (rent === 0) return 'AVAILABLE';
  if (rent === 1) return 'RENTED';
  return 'UNKNOWN';
}

/** Unix 秒字符串转 UTC 毫秒；非法或 0 返回 null。 */
export function secondsToMs(value: unknown): number | null {
  const n = asInteger(value);
  if (n == null || n <= 0) return null;
  return n * 1000;
}
