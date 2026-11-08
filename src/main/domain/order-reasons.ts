// 支付状态与业务错误映射（接口与数据规范 §7，产品文档 §6.4）。
export type PayVerdict =
  | { kind: 'PAID' }
  | { kind: 'PENDING' }
  | { kind: 'EXPIRED' }
  | { kind: 'REJECTED'; code: string; text: string; retryable: boolean }
  | { kind: 'PAYMENT_ABNORMAL'; text: string }
  | { kind: 'UNKNOWN'; text: string };

export const REASON_TEXT = {
  BANNED: '账号受平台限制，无法下单',
  TAKEN: '手慢了，该账号刚被他人下单。驿站账号先到先得，工具不代抢',
  OFF_SHELF: '该账号已下架',
  SLOT_CLOSED: '当前不在该时段的可下单时间',
  OUT_OF_RANGE: '超出可下单范围，请调整时长',
  PAYMENT_ABNORMAL: '支付异常，请到 5E 客户端核对订单，不代表已退款',
  UNKNOWN_STATUS: '订单状态需在客户端核对',
} as const;

export function payVerdict(payStatus: number, abnormalReason: number): PayVerdict {
  const reason = Number.isFinite(abnormalReason) ? abnormalReason : -1;
  if (payStatus === 1 && reason === 0) return { kind: 'PAID' };
  if (payStatus === 0 && reason === 0) return { kind: 'PENDING' };
  if (payStatus === 0 && reason === 5) return { kind: 'EXPIRED' };
  switch (reason) {
    case 1:
      return { kind: 'REJECTED', code: 'BANNED', text: REASON_TEXT.BANNED, retryable: false };
    case 2:
      return { kind: 'REJECTED', code: 'TAKEN', text: REASON_TEXT.TAKEN, retryable: false };
    case 3:
    case 6:
      return { kind: 'REJECTED', code: 'OFF_SHELF', text: REASON_TEXT.OFF_SHELF, retryable: false };
    case 4:
      return { kind: 'PAYMENT_ABNORMAL', text: REASON_TEXT.PAYMENT_ABNORMAL };
    case 7:
      return {
        kind: 'REJECTED',
        code: 'SLOT_CLOSED',
        text: REASON_TEXT.SLOT_CLOSED,
        retryable: false,
      };
    case 8:
      return {
        kind: 'REJECTED',
        code: 'OUT_OF_RANGE',
        text: REASON_TEXT.OUT_OF_RANGE,
        retryable: true,
      };
    default:
      return { kind: 'UNKNOWN', text: REASON_TEXT.UNKNOWN_STATUS };
  }
}
