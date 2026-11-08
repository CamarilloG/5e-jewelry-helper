// 金额：元/分换算全程使用 Decimal（接口与数据规范 §5）。
import Decimal from 'decimal.js';

/** 原始租金（元）：单价 × 数量，ROUND_HALF_UP 保留两位。 */
export function originalYuan(unitYuan: string, count: number): Decimal {
  return new Decimal(unitYuan).mul(count).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** 原始租金（分）。 */
export function originalFen(unitYuan: string, count: number): Decimal {
  return originalYuan(unitYuan, count).mul(100);
}

/** 平台券接口的分值字段转为元：除以 100，向下保留两位（与平台前端一致）。 */
export function fenFieldToYuan(value: string | number): Decimal {
  return new Decimal(String(value)).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

/** 显示用：金额分 / 100，向下保留两位小数。 */
export function fenToDisplayYuan(fen: string): string {
  return new Decimal(fen).div(100).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);
}

export function isDecimalText(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

/** 列表展示金额：≥1 万显示「x.x 万」，否则保留两位（去掉无意义的 .00 不做）。 */
export function formatYuan(
  value: string | null | undefined,
  opts: { compact?: boolean } = {},
): string {
  if (value == null || !isDecimalText(value)) return '—';
  const d = new Decimal(value);
  if (opts.compact !== false && d.abs().gte(10000)) {
    return `¥${d.div(10000).toDecimalPlaces(1, Decimal.ROUND_DOWN).toFixed(1)} 万`;
  }
  return `¥${d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)}`;
}

export function compareDecimalText(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const av = a != null && isDecimalText(a) ? new Decimal(a) : null;
  const bv = b != null && isDecimalText(b) ? new Decimal(b) : null;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return av.cmp(bv);
}
