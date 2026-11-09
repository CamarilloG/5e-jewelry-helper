// 在线更新界面：顶部横幅与设置页共用同一组操作；下载和安装都由用户点击触发。
import { Alert, App, Button, Progress, Space, Tooltip } from 'antd';
import { useState } from 'react';
import { call } from '../api';
import { useUi } from '../store';

const BUSY_HINT = '有进行中的出码或待处理订单，完成后才能安装更新';

function UpdateActions({ compact }: { compact?: boolean }) {
  const update = useUi((s) => s.update);
  const busy = useUi((s) => s.checkout != null && !s.checkout.finished);
  const { message, modal } = App.useApp();
  if (!update) return null;
  const size = compact ? 'small' : 'middle';

  const showNotes = () =>
    modal.info({
      title: `${update.version ?? ''} 更新说明`,
      content: <div className="jh-update-notes">{update.notes}</div>,
      okText: '知道了',
    });

  const install = () =>
    modal.confirm({
      title: '重启并安装更新？',
      content: `将关闭助手并安装 ${update.version ?? '新版本'}，完成后自动重新打开。收藏、预设等数据会保留。`,
      okText: '重启安装',
      cancelText: '稍后',
      onOk: async () => {
        const result = await call('update.install');
        if (!result.ok) message.warning(result.reason);
      },
    });

  const retryDownload = update.phase === 'ERROR' && update.errorDuring === 'DOWNLOAD';
  return (
    <Space size={6}>
      {update.notes && update.phase !== 'LATEST' ? (
        <Button size={size} type="link" onClick={showNotes}>
          更新说明
        </Button>
      ) : null}
      {update.phase === 'AVAILABLE' || retryDownload ? (
        <Button size={size} type="primary" onClick={() => void call('update.download')}>
          {retryDownload ? '重新下载' : '下载更新'}
        </Button>
      ) : null}
      {update.phase === 'DOWNLOADED' ? (
        <Tooltip title={busy ? BUSY_HINT : ''}>
          <Button size={size} type="primary" disabled={busy} onClick={install}>
            重启安装
          </Button>
        </Tooltip>
      ) : null}
      {update.phase === 'ERROR' ? (
        <Button size={size} onClick={() => void call('app.openReleases')}>
          打开发布页
        </Button>
      ) : null}
    </Space>
  );
}

function statusText(update: NonNullable<ReturnType<typeof useUi.getState>['update']>) {
  const { phase, version, percent, error } = update;
  if (phase === 'AVAILABLE') return `发现新版本 ${version}`;
  if (phase === 'DOWNLOADING') return `正在下载 ${version}（${percent ?? 0}%）`;
  if (phase === 'DOWNLOADED') return `${version} 已下载完成，重启后安装`;
  if (phase === 'ERROR') return error ?? '更新失败';
  if (phase === 'CHECKING') return '正在检查更新…';
  if (phase === 'LATEST') return '已是最新版本';
  return '';
}

/** 只在有新版本需要处理时出现；检查失败或已是最新都不打扰。 */
export function UpdateBanner() {
  const update = useUi((s) => s.update);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!update?.version) return null;
  const visible =
    update.phase === 'AVAILABLE' ||
    update.phase === 'DOWNLOADING' ||
    update.phase === 'DOWNLOADED' ||
    (update.phase === 'ERROR' && update.errorDuring === 'DOWNLOAD');
  const key = `${update.version}:${update.phase}`;
  if (!visible || dismissed === key) return null;
  return (
    <div className="jh-banners">
      <Alert
        type={update.phase === 'ERROR' ? 'warning' : 'info'}
        showIcon
        banner
        closable={update.phase !== 'DOWNLOADING'}
        onClose={() => setDismissed(key)}
        message={statusText(update)}
        action={<UpdateActions compact />}
      />
    </div>
  );
}

export function UpdatePanel() {
  const update = useUi((s) => s.update);
  if (!update) return null;
  if (!update.supported) {
    return (
      <>
        <Button onClick={() => void call('app.openReleases')}>打开发布页</Button>
        <span className="jh-hint">当前环境不支持在线更新</span>
      </>
    );
  }
  const busy = update.phase === 'CHECKING' || update.phase === 'DOWNLOADING';
  const text = statusText(update);
  return (
    <div className="jh-update-panel">
      <Space wrap size={8}>
        {update.phase !== 'DOWNLOADED' && update.phase !== 'AVAILABLE' ? (
          <Button
            loading={update.phase === 'CHECKING'}
            disabled={busy}
            onClick={() => void call('update.check')}
          >
            检查更新
          </Button>
        ) : null}
        {text ? (
          <span className={update.phase === 'ERROR' ? 'jh-error-text' : undefined}>{text}</span>
        ) : null}
        <UpdateActions />
      </Space>
      {update.phase === 'DOWNLOADING' ? (
        <Progress percent={update.percent ?? 0} size="small" style={{ maxWidth: 320 }} />
      ) : null}
      <div className="jh-hint">每次启动时自动检查；下载和安装都需要你手动确认</div>
    </div>
  );
}
