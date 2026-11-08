// P3 收藏监测：监测控制条、收藏行（状态、预设、上次变化、单条监测开关、一键出码）、平台同步标记。
import { MoreOutlined } from '@ant-design/icons';
import { App, Button, Dropdown, Empty, Select, Space, Switch, Tag, Tooltip } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FavoriteView } from '../../../shared/dto';
import { STATUS_LABEL } from '../../../shared/status';
import { call } from '../api';
import { StatusBadge, Thumb } from '../components/common';
import { useFavoriteActions } from '../components/favorite-actions';
import { formatCountdown, formatTime } from '../format';
import { useUi } from '../store';

type SortKey = 'AVAILABLE_FIRST' | 'CREATED' | 'CHANGED';
const STATUS_ORDER = { AVAILABLE: 0, RENTED: 1, UNKNOWN: 2, OFF_SHELF: 3 } as const;

function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

export async function startFavoriteCheckout(
  accountNo: string,
  message: { error(t: string): void; info(t: string): void; warning(t: string): void },
) {
  try {
    const result = await call('checkout.start', {
      accountNo,
      params: null,
      source: 'FAVORITE',
      expectedAmountYuan: null,
    });
    if (result.kind === 'NEEDS_PRESET') {
      useUi.setState({ presetEditor: { accountNo, continueCheckout: true } });
    } else if (result.kind === 'NEEDS_AGREEMENT') {
      message.warning('首次出码前请在详情下单区阅读并勾选协议与占号风险');
      useUi.setState({ drawer: { accountNo, hitKeys: null, focusInventory: false } });
    } else if (result.kind === 'BLOCKED') {
      message.error(result.reason);
    } else {
      useUi.setState({ checkoutOpen: true });
      if (result.kind === 'EXISTING') message.info('已有进行中的出码，已为你定位到该尝试');
    }
  } catch (error) {
    message.error((error as Error).message || '出码失败');
  }
}

export function FavoritesPage() {
  const favorites = useUi((s) => s.favorites);
  const status = useUi((s) => s.status);
  const filter = useUi((s) => s.favoriteFilter);
  const focus = useUi((s) => s.favoriteFocus);
  const { message } = App.useApp();
  const [sort, setSort] = useState<SortKey>('AVAILABLE_FIRST');
  const now = useNow();
  const monitor = status?.monitor;
  const items = favorites?.items ?? [];
  const list = useMemo(() => {
    const filtered = items.filter((f) => filter === 'ALL' || f.status === filter);
    return [...filtered].sort((a, b) => {
      if (sort === 'CREATED') return b.createdAt - a.createdAt;
      if (sort === 'CHANGED') return (b.lastChange?.at ?? 0) - (a.lastChange?.at ?? 0);
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt;
    });
  }, [items, filter, sort]);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (!focus) return;
    const el = rowRefs.current.get(focus);
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
  }, [focus]);
  const availableCount = items.filter((f) => f.status === 'AVAILABLE').length;
  const cooldown = monitor?.cooldownUntil ? Math.max(0, monitor.cooldownUntil - now) : 0;
  const authOk = status?.auth.phase === 'OK';
  return (
    <div className="jh-page jh-favorites">
      <div className="jh-monitor-bar">
        <Space wrap size={12}>
          <span>
            监测{' '}
            <Switch
              checked={monitor?.enabled ?? false}
              disabled={!authOk}
              aria-label="全局监测开关"
              onChange={(enabled) => void call('monitor.setEnabled', { enabled })}
            />
          </span>
          <span>
            每 {monitor?.intervalSeconds ?? 60} 秒检查{' '}
            <Button
              size="small"
              type="link"
              onClick={() =>
                useUi.setState({ page: 'SETTINGS', settingsSection: 'monitor', drawer: null })
              }
            >
              修改
            </Button>
          </span>
          <span className="jh-num">
            {monitor?.running
              ? '检查中…'
              : monitor?.paused
                ? '监测已暂停'
                : monitor?.nextAt
                  ? `下次 ${formatCountdown(monitor.nextAt - now)}`
                  : '—'}
          </span>
          <Button
            size="small"
            disabled={!authOk || cooldown > 0}
            onClick={() =>
              void call('monitor.checkNow').then((r) => {
                if (!r.started && r.cooldownUntil) message.info('冷却中，请稍后再试');
              })
            }
          >
            {cooldown > 0 ? `立即检查（${Math.ceil(cooldown / 1000)}s）` : '立即检查'}
          </Button>
          {monitor?.lastRoundError ? (
            <Tag color="orange">最近一次检查：{monitor.lastRoundError}</Tag>
          ) : null}
          {favorites?.sync.ok === false ? (
            <span className="jh-warn-small">
              平台收藏同步失败
              <Button size="small" type="link" onClick={() => void call('favorites.syncNow')}>
                重试
              </Button>
            </span>
          ) : null}
        </Space>
        <Space wrap>
          <Select
            value={filter}
            style={{ width: 110 }}
            aria-label="状态过滤"
            onChange={(v) => useUi.setState({ favoriteFilter: v })}
            options={[
              { value: 'ALL', label: '全部' },
              { value: 'AVAILABLE', label: '可租' },
              { value: 'RENTED', label: '租赁中' },
              { value: 'OFF_SHELF', label: '已下架' },
              { value: 'UNKNOWN', label: '未知' },
            ]}
          />
          <Select<SortKey>
            value={sort}
            style={{ width: 120 }}
            aria-label="排序"
            onChange={setSort}
            options={[
              { value: 'AVAILABLE_FIRST', label: '可租优先' },
              { value: 'CREATED', label: '收藏时间' },
              { value: 'CHANGED', label: '最近变化' },
            ]}
          />
          <span className="jh-small">
            共 {items.length} · 可租 {availableCount}
          </span>
        </Space>
      </div>
      {items.length === 0 ? (
        <div className="jh-empty">
          <Empty description="还没有收藏账号（平台收藏会自动同步进来）">
            <Button type="primary" onClick={() => useUi.getState().setPage('FILTER')}>
              去筛选
            </Button>
          </Empty>
        </div>
      ) : (
        <div className="jh-fav-list">
          {list.map((f) => (
            <FavoriteRow
              key={f.accountNo}
              favorite={f}
              focused={focus === f.accountNo}
              refCallback={(el) => {
                if (el) rowRefs.current.set(f.accountNo, el);
                else rowRefs.current.delete(f.accountNo);
              }}
            />
          ))}
          {list.length === 0 ? <Empty description="没有符合过滤条件的收藏" /> : null}
        </div>
      )}
    </div>
  );
}

function FavoriteRow({
  favorite: f,
  focused,
  refCallback,
}: {
  favorite: FavoriteView;
  focused: boolean;
  refCallback: (el: HTMLDivElement | null) => void;
}) {
  const { message } = App.useApp();
  const { remove } = useFavoriteActions();
  const checkout = useUi((s) => s.checkout);
  const authOk = useUi((s) => s.status?.auth.phase === 'OK');
  const busy = checkout != null && !checkout.finished;
  const open = () => {
    useUi.setState({ drawer: { accountNo: f.accountNo, hitKeys: null, focusInventory: false } });
    if (f.unseen) void call('favorites.markSeen', { accountNo: f.accountNo });
  };
  const change = f.lastChange
    ? `${formatTime(f.lastChange.at)} ${f.lastChange.from ? STATUS_LABEL[f.lastChange.from as keyof typeof STATUS_LABEL] : '首次'}→${f.lastChange.to ? STATUS_LABEL[f.lastChange.to as keyof typeof STATUS_LABEL] : '—'}`
    : '—';
  return (
    <article
      ref={refCallback}
      tabIndex={-1}
      className={`jh-fav-row ${f.unseen ? 'jh-fav-new' : ''} ${focused ? 'jh-fav-focus' : ''}`}
      aria-label={`收藏 ${f.accountNo} ${STATUS_LABEL[f.status]}`}
    >
      <Thumb src={f.thumbnail} alt={f.accountNo} size={{ w: 88, h: 66 }} />
      <div className="jh-fav-main">
        <div className="jh-fav-line">
          <button type="button" className="jh-account jh-linklike" onClick={open}>
            {f.accountNo}
          </button>
          <StatusBadge status={f.status} expireTimeMs={f.expireTimeMs} />
          {!f.monitorEnabled ? <Tag>未监测</Tag> : null}
          {f.unseen ? <Tag color="green">新</Tag> : null}
          {f.source === 'platform' ? <Tag>来自平台</Tag> : null}
          {f.platformState === 'removed' ? <Tag color="orange">平台已取消收藏</Tag> : null}
          {f.pendingSync ? (
            <Tooltip title={f.syncError ?? '将在下次同步时重试'}>
              <Tag color="gold">待同步</Tag>
            </Tooltip>
          ) : null}
          {f.status === 'UNKNOWN' && f.checkError ? (
            <Tooltip title={`${f.checkError} · ${formatTime(f.checkedAt)}`}>
              <Tag color="default">检查失败</Tag>
            </Tooltip>
          ) : null}
        </div>
        <div className="jh-fav-line jh-small">
          <span className="jh-tagline">{f.tags.join(' / ') || '—'}</span>
          <span className="jh-num jh-price">{f.presetPrice ? `¥${f.presetPrice}` : '—'}</span>
          <span>上次变化 {change}</span>
        </div>
        <div className="jh-fav-line jh-small">
          {f.presetSummary ? (
            <span>{f.presetSummary}</span>
          ) : (
            <span>
              未设置预设 ·{' '}
              <Button
                size="small"
                type="link"
                onClick={() =>
                  useUi.setState({
                    presetEditor: { accountNo: f.accountNo, continueCheckout: false },
                  })
                }
              >
                去设置
              </Button>
            </span>
          )}
        </div>
      </div>
      <div className="jh-fav-actions">
        <span className="jh-small">
          监测{' '}
          <Switch
            size="small"
            checked={f.monitorEnabled}
            aria-label={`监测 ${f.accountNo}`}
            onChange={(enabled) =>
              void call('favorites.setMonitor', { accountNo: f.accountNo, enabled })
            }
          />
        </span>
        <Space size={4} wrap>
          <Tooltip
            title={f.status !== 'AVAILABLE' ? '仅「可租」时可用' : busy ? '已有进行中的出码' : ''}
          >
            <Button
              type="primary"
              size="small"
              disabled={f.status !== 'AVAILABLE' || !authOk}
              onClick={() => void startFavoriteCheckout(f.accountNo, message)}
            >
              一键出码
            </Button>
          </Tooltip>
          <Button
            size="small"
            onClick={() =>
              useUi.setState({ presetEditor: { accountNo: f.accountNo, continueCheckout: false } })
            }
          >
            编辑预设
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                ...(f.platformState === 'removed'
                  ? [
                      { key: 'refav', label: '重新在平台收藏' },
                      { key: 'local', label: '本地也移除' },
                    ]
                  : []),
                { key: 'remove', label: '取消收藏', danger: true },
                { key: 'copy', label: '复制编号' },
              ],
              onClick: ({ key }) => {
                if (key === 'remove' || key === 'local') remove(f.accountNo);
                if (key === 'refav')
                  void call('favorites.platformFavorite', { accountNo: f.accountNo });
                if (key === 'copy')
                  void navigator.clipboard
                    ?.writeText(f.accountNo)
                    .then(() => message.success('已复制编号'));
              },
            }}
          >
            <Button size="small" icon={<MoreOutlined />} aria-label={`更多操作 ${f.accountNo}`} />
          </Dropdown>
        </Space>
        <div className="jh-warn-small">将创建订单并占用账号</div>
      </div>
    </article>
  );
}
