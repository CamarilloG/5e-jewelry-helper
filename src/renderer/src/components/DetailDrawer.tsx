// P2 账号详情抽屉：状态、租价表、完整库存（全部/仅命中）、就地下单参数与一键出码。
import { CloseOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inventoryCategoryKey, inventoryCategoryTabs } from '../../../shared/catalog';
import type { DetailView, InventoryView } from '../../../shared/dto';
import { compareDecimalText, formatYuan } from '../../../shared/money';
import { formatSlotWindow, formatWeekdays, RENT_META, SLOT_WINDOWS } from '../../../shared/rent';
import { AGREEMENT_VERSION } from '../../../shared/settings';
import { call } from '../api';
import { useUi } from '../store';
import { ItemCard, StatusBadge, VirtualGrid } from './common';
import { FavoriteStar } from './favorite-actions';
import {
  initialParams,
  OrderParamsFields,
  type ParamsValue,
  QuoteLine,
  useQuote,
} from './OrderParams';

const MIN_W = 360;
const MAX_W = 640;

function clampWidth(w: number) {
  return Math.round(Math.max(MIN_W, Math.min(w, MAX_W, window.innerWidth * 0.55)));
}

export function DetailDrawer() {
  const drawer = useUi((s) => s.drawer);
  const [width, setWidth] = useState(440);
  const dragging = useRef(false);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(clampWidth(window.innerWidth - e.clientX));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.classList.remove('jh-resizing');
    };
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  const close = useCallback(() => useUi.setState({ drawer: null }), []);
  const open = drawer != null;
  // 无遮罩以便主内容仍可滚动；点击主内容空白区域等同点遮罩关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        !target ||
        target.closest(
          '.jh-drawer-root, .ant-modal-root, .ant-select-dropdown, .ant-popover, .ant-tooltip, .ant-message, .ant-dropdown, .ant-picker-dropdown',
        )
      )
        return;
      if (target.closest('.jh-card, .jh-list-row, .jh-fav-row')) return;
      if (target.closest('.jh-main')) close();
    };
    // 焦点不在抽屉内时 Esc 同样关闭（有模态框时交给模态框处理）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('.ant-modal-wrap:not([style*="display: none"]) .ant-modal'))
        return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return (
    <Drawer
      open={drawer != null}
      onClose={close}
      placement="right"
      size={width}
      mask={false}
      closable={false}
      keyboard
      destroyOnHidden
      className="jh-drawer"
      rootClassName="jh-drawer-root"
      styles={{ body: { padding: 0 } }}
    >
      <button
        type="button"
        className="jh-drawer-handle"
        aria-label="拖动调整详情宽度（左右方向键调整）"
        onMouseDown={() => {
          dragging.current = true;
          document.body.classList.add('jh-resizing');
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setWidth((w) => clampWidth(w + 20));
          if (e.key === 'ArrowRight') setWidth((w) => clampWidth(w - 20));
        }}
      />
      {drawer ? <DetailBody key={drawer.accountNo} onClose={close} /> : null}
    </Drawer>
  );
}

function DetailBody({ onClose }: { onClose: () => void }) {
  const drawer = useUi((s) => s.drawer);
  const status = useUi((s) => s.status);
  const { message } = App.useApp();
  const accountNo = drawer?.accountNo ?? '';
  const [detail, setDetail] = useState<DetailView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const load = useCallback(
    (refresh: boolean) => {
      setDetailError(null);
      call('account.detail', { accountNo, refresh })
        .then(setDetail)
        .catch((e: Error) => setDetailError(e.message || '加载失败'));
    },
    [accountNo],
  );
  useEffect(() => load(false), [load]);
  const inventoryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (drawer?.focusInventory && detail) inventoryRef.current?.scrollIntoView({ block: 'start' });
  }, [drawer?.focusInventory, detail]);

  return (
    <div className="jh-detail">
      <header className="jh-detail-head">
        <Tooltip title="复制编号">
          <button
            type="button"
            className="jh-account jh-copy"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(accountNo)
                .then(() => message.success('已复制编号'));
            }}
          >
            {accountNo} <CopyOutlined />
          </button>
        </Tooltip>
        <Space>
          <FavoriteStar accountNo={accountNo} size={18} />
          <Tooltip title="刷新">
            <Button
              type="text"
              icon={<ReloadOutlined />}
              aria-label="刷新详情"
              onClick={() => load(true)}
            />
          </Tooltip>
          <Button type="text" icon={<CloseOutlined />} aria-label="关闭详情" onClick={onClose} />
        </Space>
      </header>
      {detailError ? (
        <div className="jh-pad">
          <Empty description={`详情加载失败 · ${detailError}`}>
            <Button onClick={() => load(true)}>重试</Button>
          </Empty>
        </div>
      ) : !detail ? (
        <div className="jh-pad">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      ) : (
        <>
          <section className="jh-pad">
            <StatusBadge
              status={detail.account.status}
              expireTimeMs={detail.account.expireTimeMs}
            />
            <div className="jh-tags-all">卖点：{detail.account.tags.join(' / ') || '—'}</div>
            <div className="jh-small">
              总价值{' '}
              <span className="jh-num">{formatYuan(detail.account.value, { compact: false })}</span>
            </div>
          </section>
          <PriceTable detail={detail} />
          <div ref={inventoryRef}>
            <Inventory accountNo={accountNo} hitKeys={drawer?.hitKeys ?? null} />
          </div>
          <OrderArea
            detail={detail}
            reload={() => load(true)}
            authOk={status?.auth.phase === 'OK'}
          />
        </>
      )}
    </div>
  );
}

function PriceTable({ detail }: { detail: DetailView }) {
  return (
    <section className="jh-pad jh-section">
      <div className="jh-section-title">租价</div>
      <div className="jh-price-grid">
        {detail.account.prices.map((p) => {
          const meta = RENT_META[p.kind];
          return (
            <div key={p.kind} className={`jh-price-cell ${p.supported ? '' : 'jh-disabled'}`}>
              <span>{meta.label}</span>
              <span className="jh-num">
                {p.supported && p.price ? `¥${p.price}/${meta.unit}` : '—'}
              </span>
              {p.supported && p.firstPrice ? <Tag color="gold">首单 ¥{p.firstPrice}</Tag> : null}
              {p.supported && p.actPrice ? <Tag color="magenta">活动 ¥{p.actPrice}</Tag> : null}
              {p.supported && meta.slot ? (
                <div className="jh-hint">
                  {formatWeekdays(detail.account.weekRange[p.kind as 'EARLY' | 'NOON' | 'NIGHT'])} ·{' '}
                  {formatSlotWindow(p.kind as 'EARLY' | 'NOON' | 'NIGHT')} · 使用{' '}
                  {SLOT_WINDOWS[p.kind as 'EARLY' | 'NOON' | 'NIGHT'].use}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="jh-hint">营销价仅作标注，下单按原价计费并在下单区显示本次报价。</div>
    </section>
  );
}

type InvSort = 'PRICE' | 'RARITY' | 'NAME';

function Inventory({ accountNo, hitKeys }: { accountNo: string; hitKeys: string[] | null }) {
  const [inv, setInv] = useState<InventoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'ALL' | 'HIT'>('ALL');
  const [sort, setSort] = useState<InvSort>('PRICE');
  const [category, setCategory] = useState('ALL');
  const load = useCallback(
    (refresh: boolean) => {
      setError(null);
      call('account.inventory', { accountNo, refresh })
        .then(setInv)
        .catch((e: Error) => setError(e.message || '加载失败'));
    },
    [accountNo],
  );
  useEffect(() => load(false), [load]);
  const hits = useMemo(() => new Set(hitKeys ?? []), [hitKeys]);
  const scoped = useMemo(() => {
    if (!inv) return [];
    return mode === 'HIT' ? inv.items.filter((i) => hits.has(i.key)) : inv.items;
  }, [inv, mode, hits]);
  const tabs = useMemo(() => inventoryCategoryTabs(scoped), [scoped]);
  // 切到「仅命中」后原类别可能不存在，此时回到「全部」
  const activeCategory = tabs.some((t) => t.key === category) ? category : 'ALL';
  const items = useMemo(() => {
    const list =
      activeCategory === 'ALL'
        ? [...scoped]
        : scoped.filter((i) => inventoryCategoryKey(i.firstType) === activeCategory);
    list.sort((a, b) => {
      if (sort === 'NAME') return a.name.localeCompare(b.name, 'zh-CN');
      if (sort === 'RARITY')
        return (
          (b.rarityName ?? '').localeCompare(a.rarityName ?? '', 'zh-CN') ||
          compareDecimalText(b.price, a.price)
        );
      return compareDecimalText(b.price, a.price);
    });
    if (hitKeys && mode === 'ALL')
      list.sort((a, b) => Number(hits.has(b.key)) - Number(hits.has(a.key)));
    return list;
  }, [scoped, activeCategory, mode, sort, hits, hitKeys]);
  return (
    <section className="jh-pad jh-section">
      <div className="jh-section-title jh-row-between">
        <span>库存（{inv ? inv.items.length : '…'}）</span>
        <Space size={6}>
          {hitKeys ? (
            <Segmented
              size="small"
              value={mode}
              onChange={(v) => setMode(v as 'ALL' | 'HIT')}
              options={[
                { label: '全部', value: 'ALL' },
                { label: '仅命中', value: 'HIT' },
              ]}
            />
          ) : null}
          <Select<InvSort>
            size="small"
            value={sort}
            onChange={setSort}
            style={{ width: 92 }}
            aria-label="库存排序"
            options={[
              { value: 'PRICE', label: '估价↓' },
              { value: 'RARITY', label: '稀有度' },
              { value: 'NAME', label: '名称' },
            ]}
          />
        </Space>
      </div>
      {tabs.length > 1 ? (
        <fieldset className="jh-cat-tabs" aria-label="库存分类">
          {[{ key: 'ALL', label: '全部', count: scoped.length }, ...tabs].map((t) => (
            <button
              key={t.key}
              type="button"
              className={`jh-cat-tab ${activeCategory === t.key ? 'active' : ''}`}
              aria-pressed={activeCategory === t.key}
              onClick={() => setCategory(t.key)}
            >
              {t.label}
              <span className="jh-num">{t.count}</span>
            </button>
          ))}
        </fieldset>
      ) : null}
      {error ? (
        <div className="jh-inline-error">
          库存加载失败 ·{' '}
          <Button size="small" type="link" onClick={() => load(true)}>
            重试
          </Button>
        </div>
      ) : !inv ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : items.length === 0 ? (
        <Empty description="没有饰品" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ height: Math.min(520, Math.ceil(items.length / 3) * 196 + 8) }}>
          <VirtualGrid
            items={items}
            minColumnWidth={118}
            rowHeight={184}
            gap={8}
            getKey={(i) => i.key}
            ariaLabel="完整库存"
            render={(item) => <ItemCard item={item} hit={hits.has(item.key)} />}
          />
        </div>
      )}
      {inv?.fromCache ? <div className="jh-hint">库存来自本地缓存，可点刷新重新读取</div> : null}
    </section>
  );
}

function OrderArea({
  detail,
  reload,
  authOk,
}: {
  detail: DetailView;
  reload: () => void;
  authOk: boolean;
}) {
  const { message } = App.useApp();
  const [params, setParams] = useState<ParamsValue>(() =>
    initialParams(detail, detail.preset ?? null),
  );
  const [accepted, setAccepted] = useState(detail.agreementAccepted);
  const [starting, setStarting] = useState(false);
  const { quote, loading } = useQuote(
    detail.account.accountNo,
    params.quantity != null ? params : null,
  );
  const channelOk =
    detail.channels.find((c) => c.payChannel === params.payChannel)?.available ?? false;
  const blocked =
    detail.orderBlockedReason ??
    (!authOk ? '登录态不可用' : null) ??
    (!detail.platformAgreementDone ? '请先在 5E 客户端完成平台租赁协议（助手不代签）' : null) ??
    (!channelOk ? '请选择当前可用的支付方式' : null) ??
    quote?.error ??
    null;
  const start = async () => {
    if (!quote || quote.error || params.quantity == null) return;
    setStarting(true);
    try {
      const result = await call('checkout.start', {
        accountNo: detail.account.accountNo,
        params: { ...params, quantity: params.quantity },
        source: 'DETAIL',
        expectedAmountYuan: quote.amountYuan,
      });
      if (result.kind === 'STARTED' || result.kind === 'EXISTING') {
        useUi.setState({ checkoutOpen: true });
        if (result.kind === 'EXISTING') message.info('已有进行中的出码，已为你定位到该尝试');
      } else if (result.kind === 'NEEDS_AGREEMENT') {
        message.warning('请先阅读并勾选协议与占号风险');
      } else if (result.kind === 'BLOCKED') {
        message.error(result.reason);
      }
    } catch (error) {
      message.error((error as Error).message || '出码失败');
    } finally {
      setStarting(false);
    }
  };
  return (
    <section className="jh-pad jh-section jh-order">
      <div className="jh-section-title">下单</div>
      <OrderParamsFields detail={detail} value={params} onChange={setParams} />
      <QuoteLine quote={quote} loading={loading} />
      {!accepted ? (
        <div className="jh-agreement">
          <Checkbox
            onChange={async (e) => {
              if (!e.target.checked) return;
              try {
                await call('agreement.accept', { version: AGREEMENT_VERSION });
                setAccepted(true);
              } catch {
                message.error('保存确认失败');
              }
            }}
          >
            我已阅读并同意平台租赁协议，了解：点击「一键出码」会立即创建订单并占用账号；未按时付款可能触发平台冻结；付款由我本人扫码完成，上号回到
            5E 客户端。
          </Checkbox>
        </div>
      ) : null}
      <Space direction="vertical" style={{ width: '100%' }}>
        <Button
          type="primary"
          block
          size="large"
          loading={starting}
          disabled={!accepted || blocked != null || !quote || loading}
          onClick={() => void start()}
        >
          一键出码
        </Button>
        <div className="jh-warn-small">将创建订单并占用账号</div>
        {blocked ? <div className="jh-error-text">{blocked}</div> : null}
        {detail.favorite ? (
          <div className="jh-hint">
            已收藏：参数预填自下单预设，此处修改只对本次有效{' '}
            <Button
              size="small"
              type="link"
              onClick={() =>
                useUi.setState({
                  presetEditor: { accountNo: detail.account.accountNo, continueCheckout: false },
                })
              }
            >
              编辑预设
            </Button>
          </div>
        ) : null}
        <Button size="small" type="link" onClick={reload}>
          刷新账号信息
        </Button>
      </Space>
    </section>
  );
}
