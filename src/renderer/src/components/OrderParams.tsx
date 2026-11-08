// 下单参数控件（详情下单区与预设编辑框共用）：只列账号支持的租期、平台可下单数量、当前可用渠道；报价由主进程计算。
import { MinusOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Checkbox, Radio, Select, Space, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { DetailView, QuoteView } from '../../../shared/dto';
import {
  formatSlotWindow,
  formatWeekdays,
  quantityOptions,
  RENT_META,
  type RentKind,
  SLOT_WINDOWS,
} from '../../../shared/rent';
import { call } from '../api';

export interface ParamsValue {
  rentKind: RentKind;
  quantity: number | null;
  payChannel: 1 | 2;
  autoCoupon: boolean;
}

export function optionsFor(detail: DetailView, kind: RentKind): number[] {
  const d = detail.durations;
  return quantityOptions(
    kind,
    d ? { hourDuration: d.HOUR, dayDuration: d.DAY, weekDuration: d.WEEK } : null,
    detail.account.rentPeriod,
  );
}

export function initialParams(detail: DetailView, base: ParamsValue | null): ParamsValue {
  const from = base ?? detail.defaultParams;
  const kind = detail.account.supported.includes(from.rentKind)
    ? from.rentKind
    : (detail.account.supported[0] ?? from.rentKind);
  const opts = detail.durations || RENT_META[kind].slot ? optionsFor(detail, kind) : [];
  const quantity =
    from.quantity != null && opts.includes(from.quantity) ? from.quantity : (opts[0] ?? null);
  // 既有渠道失效时保留原值并提示重新选择，不静默替换用户的支付方式
  return { rentKind: kind, quantity, payChannel: from.payChannel, autoCoupon: from.autoCoupon };
}

export function OrderParamsFields({
  detail,
  value,
  onChange,
}: {
  detail: DetailView;
  value: ParamsValue;
  onChange: (v: ParamsValue) => void;
}) {
  const supported = detail.account.supported;
  const meta = RENT_META[value.rentKind];
  const options = optionsFor(detail, value.rentKind);
  const index = value.quantity != null ? options.indexOf(value.quantity) : -1;
  const channelOk =
    detail.channels.find((c) => c.payChannel === value.payChannel)?.available ?? false;
  return (
    <div className="jh-params">
      <div className="jh-param-row">
        <span className="jh-label">租期</span>
        <Select
          value={value.rentKind}
          style={{ width: 200 }}
          aria-label="租期"
          options={supported.map((k) => ({
            value: k,
            label: RENT_META[k].slot
              ? `${RENT_META[k].label}（${formatWeekdays(detail.account.weekRange[k as 'EARLY' | 'NOON' | 'NIGHT'])}）`
              : RENT_META[k].label,
          }))}
          onChange={(k: RentKind) => {
            const opts = optionsFor(detail, k);
            onChange({ ...value, rentKind: k, quantity: opts[0] ?? null });
          }}
        />
      </div>
      {meta.slot ? (
        <div className="jh-hint">
          {formatSlotWindow(value.rentKind as 'EARLY' | 'NOON' | 'NIGHT')} · 使用时段{' '}
          {SLOT_WINDOWS[value.rentKind as 'EARLY' | 'NOON' | 'NIGHT'].use}（北京时间）；固定 1 次
        </div>
      ) : (
        <div className="jh-param-row">
          <span className="jh-label">时长</span>
          <Space.Compact>
            <Button
              icon={<MinusOutlined />}
              aria-label="减少时长"
              disabled={index <= 0}
              onClick={() => onChange({ ...value, quantity: options[index - 1] ?? value.quantity })}
            />
            <span className="jh-qty" aria-live="polite">
              {value.quantity ?? '—'} {meta.unit}
            </span>
            <Button
              icon={<PlusOutlined />}
              aria-label="增加时长"
              disabled={index < 0 || index >= options.length - 1}
              onClick={() => onChange({ ...value, quantity: options[index + 1] ?? value.quantity })}
            />
          </Space.Compact>
          {options.length === 0 ? <span className="jh-error-text">未读取到可下单时长</span> : null}
        </div>
      )}
      <div className="jh-param-row">
        <span className="jh-label">支付</span>
        <Radio.Group
          value={value.payChannel}
          aria-label="支付方式"
          onChange={(e) => onChange({ ...value, payChannel: e.target.value })}
        >
          {detail.channels.map((c) => (
            <Radio key={c.payChannel} value={c.payChannel} disabled={!c.available}>
              {c.payChannel === 2 ? '微信' : '支付宝'}
            </Radio>
          ))}
        </Radio.Group>
        <Checkbox
          checked={value.autoCoupon}
          onChange={(e) => onChange({ ...value, autoCoupon: e.target.checked })}
          disabled={!detail.account.couponAllowed}
        >
          自动用券
        </Checkbox>
      </div>
      {!channelOk ? <div className="jh-error-text">所选支付方式当前不可用，请重新选择</div> : null}
    </div>
  );
}

/** 主进程计算的报价（参数变化后防抖刷新）。 */
export function useQuote(accountNo: string, value: ParamsValue | null) {
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const rentKind = value?.rentKind;
  const quantity = value?.quantity;
  const payChannel = value?.payChannel;
  const autoCoupon = value?.autoCoupon;
  useEffect(() => {
    if (!rentKind || quantity == null || payChannel == null || autoCoupon == null) {
      setQuote(null);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(() => {
      call('account.quote', {
        accountNo,
        params: { rentKind, quantity, payChannel, autoCoupon },
      })
        .then((q) => {
          if (id === seq.current) setQuote(q);
        })
        .catch(() => {
          if (id === seq.current) setQuote(null);
        })
        .finally(() => {
          if (id === seq.current) setLoading(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [accountNo, rentKind, quantity, payChannel, autoCoupon]);
  return { quote, loading };
}

export function QuoteLine({ quote, loading }: { quote: QuoteView | null; loading: boolean }) {
  if (loading && !quote) return <Spin size="small" />;
  if (!quote) return <span className="jh-hint">报价不可用</span>;
  if (quote.error) return <span className="jh-error-text">{quote.error}</span>;
  return (
    <div className="jh-quote" aria-live="polite">
      <span>
        原价 ¥{quote.originalYuan}（¥{quote.unitYuan} × {quote.quantity}）
      </span>
      {quote.couponApplied ? (
        <span className="jh-discount">优惠 -¥{quote.discountYuan}</span>
      ) : null}
      <span className="jh-price jh-num">本次报价 ¥{quote.amountYuan}</span>
      {loading ? <Spin size="small" /> : null}
    </div>
  );
}
