// P4 一键出码弹窗：展示主进程出码状态；待支付时关闭/Esc/取消共用二次确认；未结束尝试可隐藏但不会被清除。
import {
  CheckCircleFilled,
  ClockCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { App, Button, Modal, Progress, Space, Spin } from 'antd';
import { useEffect, useState } from 'react';
import type { CheckoutView } from '../../../shared/dto';
import { RENT_META } from '../../../shared/rent';
import { call } from '../api';
import { formatCountdown } from '../format';
import { useUi } from '../store';
import { RiskBar } from './common';

const CONFIRM_TEXT = '将申请释放账号；最终订单状态以平台为准。确定继续吗？';

function useCountdown(view: CheckoutView | null) {
  const [base, setBase] = useState<{ at: number; remaining: number } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    setBase(
      view?.remainingMs != null ? { at: performance.now(), remaining: view.remainingMs } : null,
    );
  }, [view?.remainingMs, view]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!base) return null;
  return Math.max(0, base.remaining - (performance.now() - base.at));
}

export function CheckoutModal() {
  const view = useUi((s) => s.checkout);
  const open = useUi((s) => s.checkoutOpen);
  const { modal } = App.useApp();
  const remaining = useCountdown(view);
  if (!view) return null;
  const hide = () => useUi.setState({ checkoutOpen: false });
  const askCancel = () => {
    modal.confirm({
      title: '申请取消并释放账号',
      content: CONFIRM_TEXT,
      okText: '确定',
      okButtonProps: { danger: true },
      cancelText: '继续支付',
      onOk: () => call('checkout.cancel'),
    });
  };
  const onClose = () => {
    if (view.state === 'PENDING' && view.canCancel) {
      askCancel();
      return;
    }
    if (view.state === 'CREATING') return;
    if (view.finished) {
      void call('checkout.dismiss');
    }
    hide();
  };
  const params = view.params;
  const meta = params ? RENT_META[params.rentKind] : null;
  const paramsText =
    params && meta ? `${meta.label}${meta.slot ? '' : ` × ${params.quantity}`}` : '—';
  const channelText = params ? (params.payChannel === 2 ? '微信' : '支付宝') : '—';
  const pendingPayable =
    view.state === 'PENDING' && view.paymentImage != null && (remaining ?? 0) > 0;
  const total =
    view.deadlineMs && view.createdAt ? Math.max(1, view.deadlineMs - view.createdAt) : 180_000;
  return (
    <Modal
      open={open}
      title={`一键出码 · ${view.accountNo}`}
      onCancel={onClose}
      keyboard
      maskClosable={false}
      closable={view.state !== 'CREATING'}
      footer={null}
      width={560}
      zIndex={1100}
      destroyOnHidden={false}
    >
      {view.state === 'CHECKING' ? (
        <div className="jh-co-center">
          <Spin indicator={<LoadingOutlined spin />} />
          <div>{view.statusText}</div>
          {view.canCancel ? (
            <Button onClick={() => void call('checkout.cancel')}>取消</Button>
          ) : null}
        </div>
      ) : view.state === 'CREATING' ? (
        <div className="jh-co-center">
          <Spin indicator={<LoadingOutlined spin />} />
          <div>正在创建订单…</div>
          <div className="jh-hint">为避免状态不明，创建过程中不能中断</div>
        </div>
      ) : view.state === 'PENDING' ? (
        <div>
          <RiskBar>
            订单已创建，账号已为你锁定。请在倒计时内完成支付，多次未支付可能被平台冻结，导致无法下单。
          </RiskBar>
          <div className="jh-co-pay">
            <div className="jh-co-code">
              {pendingPayable ? (
                <img
                  src={view.paymentImage ?? undefined}
                  alt="付款二维码"
                  width={196}
                  height={196}
                />
              ) : (
                <div className="jh-co-code-empty">
                  {view.imageError
                    ? '付款码加载失败，订单仍有效；可在 5E 客户端核对或申请取消'
                    : view.statusText}
                </div>
              )}
              {remaining != null ? (
                <>
                  <div className={`jh-num ${remaining <= 60_000 ? 'jh-error-text' : ''}`}>
                    剩余 {formatCountdown(remaining)}
                  </div>
                  <Progress
                    percent={Math.round((remaining / total) * 100)}
                    showInfo={false}
                    size="small"
                    status={remaining <= 60_000 ? 'exception' : 'active'}
                  />
                </>
              ) : null}
              <div className="jh-small">请用{channelText}扫码支付</div>
            </div>
            <dl className="jh-co-summary">
              <dt>实付</dt>
              <dd className="jh-price jh-num">¥{view.quote?.amountYuan ?? '—'}</dd>
              <dt>租期</dt>
              <dd>{paramsText}</dd>
              <dt>支付</dt>
              <dd>{channelText}</dd>
              <dt>优惠</dt>
              <dd>
                {view.quote?.couponApplied ? `已用券 -¥${view.quote.discountYuan}` : '未用券'}
              </dd>
            </dl>
          </div>
          <div className="jh-co-status">状态：{view.statusText}</div>
          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            {view.needsManualCheck ? <ManualResolve /> : null}
            {view.canCancel ? (
              <Button danger onClick={askCancel}>
                申请取消并释放账号
              </Button>
            ) : null}
          </Space>
        </div>
      ) : view.state === 'PAID' ? (
        <div className="jh-co-center">
          <CheckCircleFilled style={{ color: '#22C55E', fontSize: 48 }} />
          <div className="jh-co-title">支付成功</div>
          <div>
            {paramsText} · 实付 ¥{view.quote?.amountYuan ?? '—'}
          </div>
          <div className="jh-co-strong">请回到 5E 客户端完成上号（助手不涉及上号/下号）</div>
          <Button type="primary" onClick={onClose}>
            完成
          </Button>
        </div>
      ) : view.state === 'EXPIRED' ? (
        <div className="jh-co-center">
          <ClockCircleFilled style={{ color: '#F59E0B', fontSize: 48 }} />
          <div className="jh-co-title">平台已确认支付超时</div>
          <div>{view.finished ? '释放处理已完成。' : '正在处理释放…'}</div>
          <div className="jh-error-text">多次未支付可能被平台冻结</div>
          <Space>
            <Button onClick={onClose}>关闭</Button>
            <RetryButton view={view} />
          </Space>
        </div>
      ) : view.state === 'RELEASE_PENDING' || view.state === 'RELEASE_ACCEPTED' ? (
        <div className="jh-co-center">
          {view.state === 'RELEASE_PENDING' ? (
            <Spin />
          ) : (
            <WarningFilled style={{ color: '#F59E0B', fontSize: 40 }} />
          )}
          <div className="jh-co-title">{view.statusText}</div>
          <div className="jh-hint">释放受理不等于订单已取消；处理完成前不能发起新的出码。</div>
          <Space>
            {view.needsManualCheck ? <ManualResolve /> : null}
            <Button onClick={hide}>关闭弹窗</Button>
          </Space>
        </div>
      ) : view.state === 'CREATE_UNKNOWN' ||
        view.state === 'STATUS_UNKNOWN' ||
        view.state === 'RELEASE_UNKNOWN' ? (
        <div className="jh-co-center">
          <WarningFilled style={{ color: '#F59E0B', fontSize: 44 }} />
          <div className="jh-co-title">{view.statusText}</div>
          {view.reason ? <div>{view.reason.text}</div> : null}
          <div className="jh-hint">
            请打开 5E 客户端「我的租赁 /
            订单」核对该账号是否存在待支付或已支付订单。助手不会重发创建请求。
          </div>
          <Space>
            <ManualResolve />
            <Button onClick={hide}>稍后处理</Button>
          </Space>
        </div>
      ) : view.state === 'MANUALLY_RESOLVED' ? (
        <div className="jh-co-center">
          <CheckCircleFilled style={{ color: '#4F46E5', fontSize: 40 }} />
          <div className="jh-co-title">{view.reason?.text ?? view.statusText}</div>
          <Button type="primary" onClick={onClose}>
            关闭
          </Button>
        </div>
      ) : (
        <div className="jh-co-center">
          <CloseCircleFilled style={{ color: '#EF4444', fontSize: 44 }} />
          <div className="jh-co-title">
            {view.state === 'PREFLIGHT_CANCELLED' ? '已取消，未创建订单' : '无法下单'}
          </div>
          {view.reason ? <div>{view.reason.text}</div> : null}
          {!view.finished ? <div className="jh-hint">正在清理可能的账号锁…</div> : null}
          <Space>
            <Button onClick={onClose}>关闭</Button>
            {view.reason?.code === 'OUT_OF_RANGE' ||
            view.reason?.code === 'QUANTITY_INVALID' ||
            view.reason?.code === 'CHANNEL_UNAVAILABLE' ? (
              <Button
                onClick={() => {
                  onClose();
                  useUi.setState({
                    presetEditor: { accountNo: view.accountNo, continueCheckout: false },
                  });
                }}
              >
                编辑预设
              </Button>
            ) : null}
            <RetryButton view={view} />
          </Space>
        </div>
      )}
    </Modal>
  );
}

function RetryButton({ view }: { view: CheckoutView }) {
  const { message } = App.useApp();
  if (!view.canRetry || !view.params) return null;
  return (
    <Button
      type="primary"
      onClick={async () => {
        await call('checkout.dismiss');
        try {
          const params = view.params;
          if (!params) return;
          const result = await call('checkout.start', {
            accountNo: view.accountNo,
            params,
            source: 'DETAIL',
            expectedAmountYuan: view.quote?.amountYuan ?? null,
          });
          if (result.kind === 'BLOCKED') message.error(result.reason);
          else useUi.setState({ checkoutOpen: true });
        } catch (e) {
          message.error((e as Error).message || '出码失败');
        }
      }}
    >
      {view.state === 'EXPIRED' ? '重新出码' : '重试'}
    </Button>
  );
}

function ManualResolve() {
  const { modal } = App.useApp();
  const confirm = (result: 'PAID' | 'NO_PENDING') =>
    modal.confirm({
      title: result === 'PAID' ? '确认已在客户端看到支付成功？' : '确认客户端中没有待支付订单？',
      content: '此结果记为你的人工核对，不代表平台自动确认。',
      okText: '确认',
      onOk: () => call('checkout.manualResolve', { result }),
    });
  return (
    <Space>
      <Button onClick={() => confirm('PAID')}>已支付</Button>
      <Button onClick={() => confirm('NO_PENDING')}>已无待支付订单</Button>
    </Space>
  );
}
