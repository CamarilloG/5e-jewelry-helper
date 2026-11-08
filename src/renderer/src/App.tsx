// 全局框架 G：左侧导航（含可租角标）、主内容、底部状态栏、登录引导页、横幅、出码弹窗与退出确认。
import { AppstoreOutlined, FilterOutlined, SettingOutlined, StarOutlined } from '@ant-design/icons';
import { Alert, App as AntApp, Badge, Button, Result, Space, Tag } from 'antd';
import { useEffect, useState } from 'react';
import { call, isIpcError, on } from './api';
import { CheckoutModal } from './components/CheckoutModal';
import { DetailDrawer } from './components/DetailDrawer';
import { PresetEditor } from './components/PresetEditor';
import { formatCountdown } from './format';
import { FavoritesPage } from './pages/FavoritesPage';
import { FilterPage } from './pages/FilterPage';
import { PresetsPage } from './pages/PresetsPage';
import { SettingsPage } from './pages/SettingsPage';
import { type Page, useUi } from './store';

const NAV: { key: Page; label: string; icon: React.ReactNode }[] = [
  { key: 'FILTER', label: '筛选', icon: <FilterOutlined /> },
  { key: 'FAVORITES', label: '收藏监测', icon: <StarOutlined /> },
  { key: 'PRESETS', label: '常用方案', icon: <AppstoreOutlined /> },
  { key: 'SETTINGS', label: '设置', icon: <SettingOutlined /> },
];

function useMainEvents() {
  const { message, modal } = AntApp.useApp();
  useEffect(() => {
    const offs = [
      on('status', (status) => useUi.setState({ status })),
      on('scan', (scan) => useUi.setState({ scan })),
      on('favorites', (favorites) => useUi.setState({ favorites })),
      on('checkout', (checkout) => {
        const prev = useUi.getState().checkout;
        const update: Partial<ReturnType<typeof useUi.getState>> = { checkout };
        // 新的支付/结果状态到达时置前弹窗，保证待支付弹窗不被遮挡
        if (
          checkout &&
          (!prev || prev.attemptId !== checkout.attemptId || prev.state !== checkout.state)
        ) {
          if (
            ['CHECKING', 'PENDING', 'PAID', 'CREATE_UNKNOWN'].includes(checkout.state) ||
            checkout.finished
          ) {
            update.checkoutOpen = true;
          }
        }
        useUi.setState(update);
      }),
      on('navigate', (target) => {
        const state: Partial<ReturnType<typeof useUi.getState>> = {
          page: target.page,
          drawer: null,
        };
        if (target.page === 'FAVORITES') {
          state.favoriteFocus = target.accountNo ?? null;
          state.favoriteFilter = target.filter ?? 'ALL';
          if (target.accountNo) {
            state.drawer = { accountNo: target.accountNo, hitKeys: null, focusInventory: false };
            void call('favorites.markSeen', { accountNo: target.accountNo });
          }
        }
        if (target.page === 'SETTINGS') state.settingsSection = target.section ?? null;
        useUi.setState(state);
      }),
      on('checkoutRequest', ({ accountNo, reason }) => {
        if (reason === 'NEEDS_PRESET')
          useUi.setState({ presetEditor: { accountNo, continueCheckout: true } });
        else {
          message.warning('首次出码前请在下单区阅读并勾选协议与占号风险');
          useUi.setState({ drawer: { accountNo, hitKeys: null, focusInventory: false } });
        }
      }),
      on('toast', ({ kind, text }) => message[kind](text, 3)),
      on('confirmQuit', () =>
        modal.confirm({
          title: '退出饰品驿站助手？',
          content: '退出前将申请清理当前订单；未确认结果将在下次启动时恢复。已支付订单不会解锁。',
          okText: '退出',
          okButtonProps: { danger: true },
          onOk: () => call('app.quitConfirmed'),
        }),
      ),
    ];
    // 页面未单独处理的操作失败统一提示，避免点击后没有任何反馈
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!isIpcError(event.reason)) return;
      event.preventDefault();
      message.error(event.reason.message || '操作失败，请重试');
    };
    window.addEventListener('unhandledrejection', onRejection);
    void call('app.status').then((status) => useUi.setState({ status }));
    void call('scan.state').then((scan) => useUi.setState({ scan }));
    void call('favorites.state').then((favorites) => useUi.setState({ favorites }));
    void call('checkout.state').then((checkout) => useUi.setState({ checkout }));
    void call('settings.get').then((settings) => useUi.setState({ settings }));
    return () => {
      for (const off of offs) off();
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [message, modal]);
}

export function Shell() {
  useMainEvents();
  const page = useUi((s) => s.page);
  const status = useUi((s) => s.status);
  const setPage = useUi((s) => s.setPage);
  const auth = status?.auth;
  const guide =
    status && auth && auth.phase !== 'OK' && !auth.runtimeExpired && auth.phase !== 'CHECKING';
  const badge = status?.monitor.badge ?? 0;
  return (
    <div className="jh-shell">
      <nav className="jh-nav" aria-label="主导航">
        <div className="jh-brand">
          <span className="jh-logo" aria-hidden>
            ◇
          </span>
          <span>饰品驿站助手</span>
        </div>
        {NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`jh-nav-item ${page === n.key ? 'active' : ''}`}
            aria-current={page === n.key ? 'page' : undefined}
            onClick={() => setPage(n.key)}
          >
            {n.icon}
            <span>{n.label}</span>
            {n.key === 'FAVORITES' && badge > 0 ? (
              <Badge
                count={badge}
                size="small"
                style={{ marginLeft: 'auto' }}
                aria-label={`当前可租 ${badge} 个`}
              />
            ) : null}
          </button>
        ))}
      </nav>
      <main className="jh-main">
        <Banners />
        <div className="jh-main-content">
          {status?.dbError ? (
            <Result status="error" title="本地数据库不可用" subTitle={status.dbError} />
          ) : guide ? (
            <AuthGuide />
          ) : page === 'FILTER' ? (
            <FilterPage />
          ) : page === 'FAVORITES' ? (
            <FavoritesPage />
          ) : page === 'PRESETS' ? (
            <PresetsPage />
          ) : (
            <SettingsPage />
          )}
        </div>
      </main>
      <StatusBar />
      <DetailDrawer />
      <PresetEditor />
      <CheckoutModal />
    </div>
  );
}

function Banners() {
  const status = useUi((s) => s.status);
  if (!status || status.banners.length === 0) return null;
  return (
    <div className="jh-banners">
      {status.banners.map((b) => (
        <Alert
          key={b.id}
          type={b.kind}
          showIcon
          banner
          message={b.text}
          action={
            b.action === 'RELOAD_AUTH' ? (
              <Button
                size="small"
                onClick={() => void call('auth.reload').then((s) => useUi.setState({ status: s }))}
              >
                重新读取
              </Button>
            ) : undefined
          }
        />
      ))}
    </div>
  );
}

function AuthGuide() {
  const auth = useUi((s) => s.status?.auth);
  if (!auth) return null;
  const reload = () => void call('auth.reload').then((s) => useUi.setState({ status: s }));
  const choose = () => void call('auth.chooseDirectory').then((s) => useUi.setState({ status: s }));
  const map = {
    NO_CLIENT: {
      title: '未检测到 5E 客户端，请先安装并登录',
      actions: (
        <Space>
          <Button type="primary" onClick={reload}>
            重新检测
          </Button>
          <Button onClick={choose}>手动指定目录</Button>
        </Space>
      ),
    },
    NO_LOGIN: {
      title: '请先在 5E 客户端登录一次',
      actions: (
        <Space>
          <Button type="primary" onClick={reload}>
            我已登录，重新读取
          </Button>
          <Button onClick={choose}>手动指定目录</Button>
        </Space>
      ),
    },
    EXPIRED: {
      title: '登录态已过期，请在 5E 客户端重新登录',
      actions: (
        <Button type="primary" onClick={reload}>
          重新读取
        </Button>
      ),
    },
    READ_FAILED: {
      title: '读取登录态失败',
      actions: (
        <Space>
          <Button type="primary" onClick={reload}>
            重试
          </Button>
          <Button onClick={() => void call('app.openHelp')}>查看帮助</Button>
          <Button onClick={choose}>手动指定目录</Button>
        </Space>
      ),
    },
    NETWORK: {
      title: '无法连接 5E 平台确认登录态',
      actions: (
        <Button type="primary" onClick={reload}>
          重试
        </Button>
      ),
    },
    INIT: { title: '正在读取登录态…', actions: null },
    CHECKING: { title: '正在确认登录态…', actions: null },
    OK: { title: '', actions: null },
  } as const;
  const entry = map[auth.phase];
  return (
    <div className="jh-guide">
      <Result
        status={auth.phase === 'NETWORK' ? 'warning' : 'info'}
        title={entry.title}
        subTitle={
          <div>
            {auth.errorSummary ? <div>{auth.errorSummary}</div> : null}
            <div className="jh-hint">
              助手只读取本机 5E
              客户端已有的登录态，不会自行登录、不会把客户端挤下线；凭证不会显示在任何位置。
            </div>
            <div className="jh-hint">数据目录：{auth.dataDir}</div>
          </div>
        }
        extra={entry.actions}
      />
    </div>
  );
}

function StatusBar() {
  const status = useUi((s) => s.status);
  const checkout = useUi((s) => s.checkout);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!status) return <footer className="jh-statusbar" />;
  const { auth, monitor, requests, scan } = status;
  const authOk = auth.phase === 'OK';
  const go = (page: Page, section?: string) =>
    useUi.setState({ page, drawer: null, settingsSection: section ?? null });
  const nextIn = monitor.nextAt ? Math.max(0, monitor.nextAt - Date.now()) : null;
  return (
    <footer className="jh-statusbar">
      <button type="button" className="jh-seg" onClick={() => go('SETTINGS', 'auth')}>
        <span
          className="jh-dot"
          style={{ background: authOk ? 'var(--jh-ok)' : 'var(--jh-risk)' }}
        />
        {authOk
          ? `登录态正常${auth.daysLeft != null ? ` · 剩 ${auth.daysLeft} 天` : ''}`
          : auth.phase === 'NO_LOGIN' || auth.phase === 'NO_CLIENT'
            ? '未读取到登录态'
            : auth.phase === 'INIT' || auth.phase === 'CHECKING'
              ? '正在读取登录态'
              : '登录态失效'}
      </button>
      <button type="button" className="jh-seg" onClick={() => go('FAVORITES')}>
        {monitor.paused ? (
          <span className="jh-muted">监测已暂停</span>
        ) : (
          <span className={monitor.lastRoundError ? 'jh-warn-text' : ''}>
            {monitor.lastRoundError ? '监测异常 · ' : ''}监测中 {monitor.available}/
            {monitor.monitored}
            {monitor.running
              ? ' · 检查中'
              : nextIn != null
                ? ` · 下次 ${formatCountdown(nextIn)}`
                : ''}
          </span>
        )}
      </button>
      <button type="button" className="jh-seg" onClick={() => go('SETTINGS', 'requests')}>
        请求 {requests.lastMinute}/分（上限 {requests.limit}）
        {scan ? ` · 扫描 ${scan.confirmed}/${scan.candidates}` : ''}
        {requests.waitingMs > 0 && requests.queued > 0
          ? ` · 限速等待中 ${Math.ceil(requests.waitingMs / 1000)}s`
          : ''}
        {requests.backoffUntil ? ' · 平台限流退避中' : ''}
        {requests.pausedReason ? ` · ${requests.pausedReason}` : ''}
      </button>
      {checkout && !checkout.finished ? (
        <Tag
          color="orange"
          className="jh-seg-tag"
          onClick={() => useUi.setState({ checkoutOpen: true })}
        >
          订单处理中 · 点击查看
        </Tag>
      ) : null}
    </footer>
  );
}
