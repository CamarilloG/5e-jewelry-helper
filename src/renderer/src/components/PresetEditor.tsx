// 下单预设编辑框：每个收藏账号一份；由“一键出码”触发时，保存后自动继续出码（Q5）。
import { App, Modal, Skeleton } from 'antd';
import { useEffect, useState } from 'react';
import type { DetailView } from '../../../shared/dto';
import { call } from '../api';
import { startFavoriteCheckout } from '../pages/FavoritesPage';
import { useUi } from '../store';
import {
  initialParams,
  OrderParamsFields,
  type ParamsValue,
  QuoteLine,
  useQuote,
} from './OrderParams';

export function PresetEditor() {
  const editor = useUi((s) => s.presetEditor);
  return editor ? (
    <Editor
      key={editor.accountNo}
      accountNo={editor.accountNo}
      continueCheckout={editor.continueCheckout}
    />
  ) : null;
}

function Editor({ accountNo, continueCheckout }: { accountNo: string; continueCheckout: boolean }) {
  const { message } = App.useApp();
  const [detail, setDetail] = useState<DetailView | null>(null);
  const [params, setParams] = useState<ParamsValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call('account.detail', { accountNo, refresh: false })
      .then((d) => {
        setDetail(d);
        setParams(initialParams(d, d.preset));
      })
      .catch((e: Error) => setError(e.message || '加载失败'));
  }, [accountNo]);
  const { quote, loading } = useQuote(accountNo, params && params.quantity != null ? params : null);
  const close = () => useUi.setState({ presetEditor: null });
  const channelOk =
    detail && params
      ? (detail.channels.find((c) => c.payChannel === params.payChannel)?.available ?? false)
      : false;
  const save = async () => {
    if (!params || params.quantity == null) return;
    setSaving(true);
    try {
      await call('favorites.savePreset', {
        accountNo,
        preset: { ...params, quantity: params.quantity },
      });
      close();
      if (continueCheckout) await startFavoriteCheckout(accountNo, message);
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      title={`下单预设 · ${accountNo}`}
      onCancel={close}
      onOk={() => void save()}
      okText={continueCheckout ? '保存并出码' : '保存'}
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{
        disabled: !params || params.quantity == null || !channelOk || !!quote?.error,
      }}
      destroyOnHidden
    >
      {error ? (
        <div className="jh-error-text">{error}</div>
      ) : !detail || !params ? (
        <Skeleton active />
      ) : (
        <>
          <OrderParamsFields detail={detail} value={params} onChange={setParams} />
          <QuoteLine quote={quote} loading={loading} />
          {continueCheckout ? (
            <div className="jh-warn-small">保存后将直接创建订单并占用账号</div>
          ) : null}
        </>
      )}
    </Modal>
  );
}
