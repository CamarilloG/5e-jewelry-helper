// P1 筛选主页：条件面板（同件条件行、行间交集、租期价格）+ 可中断扫描进度 + 卡片/紧凑列表结果。
import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App,
  AutoComplete,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Progress,
  Radio,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, CATEGORY_BY_ID, SKIN_SUGGESTIONS } from '../../../shared/catalog';
import type { FilterPresetView, ScanResultView } from '../../../shared/dto';
import { compareDecimalText, formatYuan } from '../../../shared/money';
import { RENT_KINDS, RENT_META } from '../../../shared/rent';
import { call } from '../api';
import { ItemCard, StatusBadge, VirtualGrid } from '../components/common';
import { FavoriteStar, useFavoriteSet } from '../components/favorite-actions';
import { formatTime } from '../format';
import {
  conditionsToForm,
  emptyForm,
  type FilterForm,
  formToConditions,
  newRow,
  useUi,
} from '../store';

const PRICE_RE = /^\d{0,7}(\.\d{0,2})?$/;

type SortKey = 'SCORE' | 'PRICE_ASC' | 'PRICE_DESC' | 'VALUE_ASC' | 'VALUE_DESC';
type StatusFilter = 'AVAILABLE' | 'ALL' | 'RENTED' | 'OFF_SHELF';

const categoryOptions = (() => {
  const groups = new Map<string, { label: string; value: string }[]>();
  for (const c of CATEGORIES) {
    const list = groups.get(c.group) ?? [];
    list.push({ label: c.label, value: c.id });
    groups.set(c.group, list);
  }
  return [...groups.entries()].map(([label, options]) => ({ label, options }));
})();

function priceInvalid(form: FilterForm) {
  return (
    !!form.priceMin &&
    !!form.priceMax &&
    PRICE_RE.test(form.priceMin) &&
    PRICE_RE.test(form.priceMax) &&
    Number(form.priceMin) > Number(form.priceMax)
  );
}

export function FilterPage() {
  return (
    <div className="jh-filter">
      <ConditionPanel />
      <Results />
    </div>
  );
}

function ConditionPanel() {
  const form = useUi((s) => s.form);
  const setForm = useUi((s) => s.setForm);
  const scan = useUi((s) => s.scan);
  const presetsVersion = useUi((s) => s.presetsVersion);
  const { message } = App.useApp();
  const [presets, setPresets] = useState<FilterPresetView[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void presetsVersion;
    call('filters.list').then(setPresets, () => setPresets([]));
  }, [presetsVersion]);
  const modified =
    form.presetId != null && form.presetSnapshot !== JSON.stringify(formToConditions(form));
  const invalid =
    priceInvalid(form) || !PRICE_RE.test(form.priceMin) || !PRICE_RE.test(form.priceMax);
  const active = scan?.phase === 'CANDIDATES' || scan?.phase === 'VERIFYING';
  const noKeyword = form.rows.some(
    (r) => r.categoryId && !r.name.trim() && !CATEGORY_BY_ID.get(r.categoryId)?.keyword,
  );

  const start = async (next?: FilterForm) => {
    const f = next ?? form;
    try {
      await call('scan.start', { conditions: formToConditions(f), presetId: f.presetId });
    } catch (error) {
      message.error((error as Error).message || '无法开始筛选');
    }
  };

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const next = conditionsToForm(preset.conditions, { id: preset.id, name: preset.name });
    setForm(() => next);
    void start(next);
  };

  return (
    <aside className="jh-conditions" aria-label="筛选条件">
      <div className="jh-field">
        <span className="jh-label">方案</span>
        <Select
          style={{ width: '100%' }}
          placeholder="选择常用方案"
          value={form.presetId ?? undefined}
          labelRender={() =>
            form.presetName ? `${form.presetName}${modified ? '（已修改）' : ''}` : null
          }
          options={presets.map((p) => ({ label: p.name, value: p.id }))}
          onChange={applyPreset}
          notFoundContent="还没有常用方案"
          aria-label="选择常用方案"
        />
      </div>
      <div className="jh-section-title">饰品条件（同时满足）</div>
      {form.rows.map((row, index) => (
        <div key={row.id}>
          {index > 0 ? <div className="jh-and">且</div> : null}
          <fieldset className="jh-row-card" aria-label={`条件 ${index + 1}`}>
            <div className="jh-row-head">
              <span>条件 {index + 1}</span>
              <Tooltip title={form.rows.length === 1 ? '清空该行' : '删除该行'}>
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  aria-label={form.rows.length === 1 ? '清空条件' : `删除条件 ${index + 1}`}
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      rows:
                        f.rows.length === 1 ? [newRow()] : f.rows.filter((r) => r.id !== row.id),
                    }))
                  }
                />
              </Tooltip>
            </div>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="大类 / 刀型 / 武器"
              style={{ width: '100%', marginBottom: 6 }}
              value={row.categoryId ?? undefined}
              options={categoryOptions}
              aria-label={`条件 ${index + 1} 大类`}
              onChange={(value?: string) =>
                setForm((f) => ({
                  ...f,
                  rows: f.rows.map((r) =>
                    r.id === row.id ? { ...r, categoryId: value ?? null } : r,
                  ),
                }))
              }
            />
            <AutoComplete
              style={{ width: '100%' }}
              placeholder="名称，如 多普勒"
              value={row.name}
              options={SKIN_SUGGESTIONS.filter((s) => !row.name || s.includes(row.name.trim())).map(
                (s) => ({ value: s }),
              )}
              aria-label={`条件 ${index + 1} 名称`}
              onChange={(value: string) =>
                setForm((f) => ({
                  ...f,
                  rows: f.rows.map((r) =>
                    r.id === row.id ? { ...r, name: value.slice(0, 40) } : r,
                  ),
                }))
              }
            />
          </fieldset>
        </div>
      ))}
      <Button
        block
        type="dashed"
        icon={<PlusOutlined />}
        onClick={() => setForm((f) => ({ ...f, rows: [...f.rows, newRow()] }))}
      >
        添加饰品条件
      </Button>
      {noKeyword ? (
        <div className="jh-hint">
          只选大类时无法用单个关键词检索，将浏览该租期全部账号并逐个确认，耗时较长；建议再填写名称。
        </div>
      ) : null}
      <div className="jh-section-title">租期</div>
      <Radio.Group
        value={form.rentKind}
        onChange={(e) => setForm((f) => ({ ...f, rentKind: e.target.value }))}
        className="jh-rent-radio"
        aria-label="租期"
      >
        {RENT_KINDS.map((k) => (
          <Radio key={k} value={k}>
            {RENT_META[k].label}
          </Radio>
        ))}
      </Radio.Group>
      <div className="jh-section-title">价格（元/{RENT_META[form.rentKind].unit}）</div>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          placeholder="最低"
          value={form.priceMin}
          status={priceInvalid(form) || !PRICE_RE.test(form.priceMin) ? 'error' : undefined}
          aria-label="价格下限"
          onChange={(e) => setForm((f) => ({ ...f, priceMin: e.target.value.trim() }))}
        />
        <Input
          className="jh-sep"
          disabled
          placeholder="–"
          style={{ width: 32, textAlign: 'center' }}
        />
        <Input
          placeholder="最高"
          value={form.priceMax}
          status={priceInvalid(form) || !PRICE_RE.test(form.priceMax) ? 'error' : undefined}
          aria-label="价格上限"
          onChange={(e) => setForm((f) => ({ ...f, priceMax: e.target.value.trim() }))}
        />
      </Space.Compact>
      {priceInvalid(form) ? <div className="jh-error-text">价格下限不能大于上限</div> : null}
      <Checkbox
        style={{ marginTop: 10 }}
        checked={form.couponOnly}
        onChange={(e) => setForm((f) => ({ ...f, couponOnly: e.target.checked }))}
      >
        仅可用券
      </Checkbox>
      <div className="jh-actions">
        <Button type="primary" block disabled={invalid} onClick={() => void start()}>
          {active ? '重新筛选' : '开始筛选'}
        </Button>
        <Space style={{ width: '100%' }}>
          <Button onClick={() => setSaving(true)} disabled={invalid}>
            保存为方案
          </Button>
          <Button
            onClick={() => setForm((f) => ({ ...emptyForm(), rentKind: f.rentKind }))}
            aria-label="重置条件（不清空结果）"
          >
            重置
          </Button>
        </Space>
      </div>
      <SavePresetModal open={saving} onClose={() => setSaving(false)} presets={presets} />
    </aside>
  );
}

function SavePresetModal({
  open,
  onClose,
  presets,
}: {
  open: boolean;
  onClose: () => void;
  presets: FilterPresetView[];
}) {
  const form = useUi((s) => s.form);
  const setForm = useUi((s) => s.setForm);
  const bump = () => useUi.setState((s) => ({ presetsVersion: s.presetsVersion + 1 }));
  const { modal, message } = App.useApp();
  const [name, setName] = useState('');
  useEffect(() => {
    if (!open) return;
    const c = formToConditions(form);
    const auto = c.items
      .map((i) =>
        [i.categoryId ? CATEGORY_BY_ID.get(i.categoryId)?.label : null, i.name]
          .filter(Boolean)
          .join(''),
      )
      .join('+');
    setName(
      form.presetName ?? `${auto || '不限饰品'} · ${RENT_META[c.rentKind].label}`.slice(0, 40),
    );
  }, [open, form]);

  const save = async (overwriteId: string | null) => {
    const trimmed = name.trim();
    if (!trimmed) {
      message.warning('方案名不能为空');
      return;
    }
    const conditions = formToConditions(form);
    const res = await call('filters.save', { name: trimmed, conditions, overwriteId });
    if (res.ok) {
      setForm((f) => ({
        ...f,
        presetId: res.id,
        presetName: trimmed,
        presetSnapshot: JSON.stringify(conditions),
      }));
      bump();
      onClose();
      return;
    }
    if (res.reason === 'DUPLICATE_NAME' && res.existingId) {
      const existingId = res.existingId;
      modal.confirm({
        title: '已存在同名方案，是否覆盖？',
        okText: '覆盖',
        okButtonProps: { danger: true },
        onOk: async () => {
          await save(existingId);
        },
      });
      return;
    }
    message.error(res.reason === 'DUPLICATE_NAME' ? '已存在同名方案' : '保存失败');
  };

  return (
    <Modal
      open={open}
      title="保存为方案"
      onCancel={onClose}
      destroyOnHidden
      footer={
        form.presetId && presets.some((p) => p.id === form.presetId)
          ? [
              <Button key="cancel" onClick={onClose}>
                取消
              </Button>,
              <Button key="new" onClick={() => void save(null)}>
                另存为新方案
              </Button>,
              <Button key="over" type="primary" danger onClick={() => void save(form.presetId)}>
                覆盖原方案
              </Button>,
            ]
          : [
              <Button key="cancel" onClick={onClose}>
                取消
              </Button>,
              <Button key="ok" type="primary" onClick={() => void save(null)}>
                保存
              </Button>,
            ]
      }
    >
      <Input
        autoFocus
        value={name}
        maxLength={40}
        status={name.trim() ? undefined : 'error'}
        onChange={(e) => setName(e.target.value)}
        aria-label="方案名"
        onPressEnter={() =>
          void save(
            form.presetId && presets.some((p) => p.id === form.presetId) ? form.presetId : null,
          )
        }
      />
      {!name.trim() ? <div className="jh-error-text">方案名不能为空</div> : null}
    </Modal>
  );
}

function useSortedResults(sort: SortKey, statusFilter: StatusFilter) {
  const scan = useUi((s) => s.scan);
  return useMemo(() => {
    if (!scan) return [];
    const kind = scan.conditions?.rentKind ?? 'HOUR';
    const priceOf = (r: ScanResultView) =>
      r.account.prices.find((p) => p.kind === kind)?.price ?? null;
    const list = scan.results.filter((r) => {
      if (statusFilter === 'ALL') return true;
      return r.account.status === statusFilter;
    });
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'SCORE':
          return b.score - a.score || compareDecimalText(priceOf(a), priceOf(b));
        case 'PRICE_ASC':
          return compareDecimalText(priceOf(a), priceOf(b));
        case 'PRICE_DESC':
          return compareDecimalText(priceOf(b), priceOf(a));
        case 'VALUE_ASC':
          return compareDecimalText(a.account.value, b.account.value);
        case 'VALUE_DESC':
          return compareDecimalText(b.account.value, a.account.value);
      }
      return 0;
    });
    return sorted;
  }, [scan, sort, statusFilter]);
}

function Results() {
  const scan = useUi((s) => s.scan);
  const status = useUi((s) => s.status);
  const settings = useUi((s) => s.settings);
  const setForm = useUi((s) => s.setForm);
  const hasItems = scan?.hasItemConditions ?? false;
  const [sort, setSort] = useState<SortKey>('SCORE');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('AVAILABLE');
  const view = settings?.device.resultView ?? 'CARD';
  useEffect(() => {
    setSort(hasItems ? 'SCORE' : 'PRICE_ASC');
  }, [hasItems]);
  const results = useSortedResults(sort, statusFilter);
  const phase = scan?.phase ?? 'IDLE';
  const active = phase === 'CANDIDATES' || phase === 'VERIFYING';

  const examples: { label: string; form: Partial<FilterForm> }[] = [
    { label: '蝴蝶刀 + 多普勒', form: { rows: [newRow('w:蝴蝶刀', '多普勒')] } },
    { label: '爪子刀 且 运动手套', form: { rows: [newRow('w:爪子刀'), newRow('w:运动手套')] } },
    { label: '多普勒 · 时租 ≤ ¥10', form: { rows: [newRow(null, '多普勒')], priceMax: '10' } },
  ];

  return (
    <section className="jh-results" aria-label="筛选结果">
      <ScanHeader />
      {phase !== 'IDLE' ? (
        <div className="jh-toolbar">
          <Space wrap>
            <Select<SortKey>
              value={sort}
              onChange={setSort}
              style={{ width: 132 }}
              aria-label="排序"
              options={[
                ...(hasItems ? [{ value: 'SCORE' as SortKey, label: '匹配度' }] : []),
                { value: 'PRICE_ASC', label: '价格↑' },
                { value: 'PRICE_DESC', label: '价格↓' },
                { value: 'VALUE_ASC', label: '总价值↑' },
                { value: 'VALUE_DESC', label: '总价值↓' },
              ]}
            />
            <Select<StatusFilter>
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 120 }}
              aria-label="状态过滤"
              options={[
                { value: 'AVAILABLE', label: '仅可租' },
                { value: 'ALL', label: '全部' },
                { value: 'RENTED', label: '租赁中' },
                { value: 'OFF_SHELF', label: '已下架' },
              ]}
            />
            <Segmented
              value={view}
              aria-label="视图"
              options={[
                { label: '卡片', value: 'CARD' },
                { label: '列表', value: 'LIST' },
              ]}
              onChange={(value) =>
                void call('settings.update', { resultView: value as 'CARD' | 'LIST' }).then((s) =>
                  useUi.setState({ settings: s }),
                )
              }
            />
          </Space>
          <span className="jh-small">当前显示 {results.length} 个</span>
          <span className="jh-scope">
            本次搜索范围：平台候选 + 本地已知账号；不代表平台全部下架账号
          </span>
        </div>
      ) : null}
      <div className="jh-results-body">
        {phase === 'IDLE' ? (
          <div className="jh-empty">
            <Empty description="设置条件后点击开始筛选" />
            <Space wrap style={{ justifyContent: 'center' }}>
              {examples.map((ex) => (
                <Button
                  key={ex.label}
                  onClick={() => setForm(() => ({ ...emptyForm(), ...ex.form }))}
                >
                  {ex.label}
                </Button>
              ))}
            </Space>
            {status?.auth.phase !== 'OK' ? (
              <div className="jh-hint">登录态就绪后才能筛选</div>
            ) : null}
          </div>
        ) : results.length === 0 && active ? (
          <div className="jh-skeletons">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} active paragraph={{ rows: 4 }} />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="jh-empty">
            <Empty description="没有符合条件的账号" />
            <div className="jh-hint">建议：放宽价格 / 减少条件 / 状态选「全部」</div>
          </div>
        ) : view === 'CARD' ? (
          <VirtualGrid
            items={results}
            minColumnWidth={250}
            rowHeight={hasItems ? 300 : 236}
            getKey={(r) => r.account.accountNo}
            ariaLabel="结果卡片"
            render={(r) => <ResultCard result={r} />}
          />
        ) : (
          <ResultList results={results} hasItems={hasItems} />
        )}
      </div>
    </section>
  );
}

function ScanHeader() {
  const scan = useUi((s) => s.scan);
  const status = useUi((s) => s.status);
  if (!scan || scan.phase === 'IDLE') return null;
  const pct = scan.candidates > 0 ? Math.round((scan.confirmed / scan.candidates) * 100) : 0;
  const waiting = status?.requests.waitingMs ?? 0;
  const paused = status?.requests.pausedReason;
  const count = scan.results.length;
  return (
    <div className="jh-scan-head" aria-live="polite">
      {scan.phase === 'CANDIDATES' ? (
        <span>正在获取候选账号…</span>
      ) : scan.phase === 'VERIFYING' ? (
        <>
          <span>
            {scan.hasItemConditions ? '已确认库存' : '已确认状态'} {scan.confirmed} / 候选{' '}
            {scan.candidates}
          </span>
          <Progress percent={pct} size="small" style={{ width: 180, margin: 0 }} showInfo={false} />
          <Button size="small" onClick={() => void call('scan.stop')}>
            停止
          </Button>
        </>
      ) : scan.phase === 'COMPLETE' ? (
        <span>
          共 {count} 个符合条件的账号 · 完成于 {formatTime(scan.finishedAt)}
          {scan.incomplete ? (
            <Tag color="orange" style={{ marginLeft: 8 }}>
              结果不完整
            </Tag>
          ) : null}
        </span>
      ) : scan.phase === 'STOPPED' ? (
        <>
          <span>
            已停止 · 已确认 {scan.confirmed}/{scan.candidates}，结果可能不完整
            {scan.error ? `（${scan.error}）` : ''}
          </span>
          <Button size="small" type="primary" onClick={() => void call('scan.continue')}>
            继续
          </Button>
        </>
      ) : (
        <>
          <span className="jh-error-text">筛选失败：{scan.error}</span>
          <Button size="small" onClick={() => void call('scan.retryFailed')}>
            重试
          </Button>
        </>
      )}
      {scan.phase === 'VERIFYING' && waiting > 0 ? (
        <Tag>限速等待 {Math.ceil(waiting / 1000)}s</Tag>
      ) : null}
      {paused && (scan.phase === 'VERIFYING' || scan.phase === 'CANDIDATES') ? (
        <Tag color="orange">{paused}</Tag>
      ) : null}
      {scan.failedAccounts.length > 0 && (scan.phase === 'COMPLETE' || scan.phase === 'STOPPED') ? (
        <Button size="small" onClick={() => void call('scan.retryFailed')}>
          重试失败的 {scan.failedAccounts.length} 个账号
        </Button>
      ) : null}
      {scan.warnings.map((w) => (
        <div key={w} className="jh-hint" style={{ width: '100%' }}>
          {w}
        </div>
      ))}
    </div>
  );
}

function priceLine(result: ScanResultView, kind: (typeof RENT_KINDS)[number]) {
  const p = result.account.prices.find((x) => x.kind === kind);
  return p?.price ? `${formatYuan(p.price, { compact: false })}/${RENT_META[kind].unit}` : '—';
}

function openDrawer(result: ScanResultView, focusInventory = false) {
  useUi.setState({
    drawer: {
      accountNo: result.account.accountNo,
      hitKeys: result.hitItems.length || result.score ? result.hitItems.map((i) => i.key) : null,
      focusInventory,
    },
  });
}

function ResultCard({ result }: { result: ScanResultView }) {
  const scan = useUi((s) => s.scan);
  const kind = scan?.conditions?.rentKind ?? 'HOUR';
  const a = result.account;
  const current = a.prices.find((p) => p.kind === kind);
  const others = a.prices.filter((p) => p.kind !== kind && p.supported);
  const shown = result.hitItems.length > 0 ? result.hitItems : a.displayItems.slice(0, 4);
  const more = Math.max(0, (result.hitCount || 0) - shown.length);
  return (
    // biome-ignore lint/a11y/useSemanticElements: 卡片内含收藏按钮，不能嵌套在 <button> 中
    <div
      className="jh-card"
      role="button"
      tabIndex={0}
      aria-label={`账号 ${a.accountNo}`}
      onClick={() => openDrawer(result)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openDrawer(result);
      }}
    >
      <div className="jh-card-head">
        <span className="jh-account">{a.accountNo}</span>
        <FavoriteStar accountNo={a.accountNo} />
      </div>
      <div className="jh-card-sub">
        <StatusBadge status={a.status} expireTimeMs={a.expireTimeMs} />
        {result.origin === 'local' ? <Tag>本地已知</Tag> : null}
        {a.couponAllowed ? <Tag color="purple">券</Tag> : null}
      </div>
      <Tooltip title={a.tags.join(' / ')}>
        <div className="jh-tagline">{a.tags.join(' / ') || '—'}</div>
      </Tooltip>
      <div className="jh-card-items">
        {shown.map((item) => (
          <ItemCard key={item.key} item={item} hit={result.hitItems.length > 0} compact />
        ))}
        {more > 0 ? (
          <Button
            size="small"
            type="link"
            onClick={(e) => {
              e.stopPropagation();
              openDrawer(result, true);
            }}
          >
            +{more}
          </Button>
        ) : null}
      </div>
      {scan?.hasItemConditions ? <div className="jh-small">命中 {result.hitCount} 件</div> : null}
      <div className="jh-card-foot">
        <span className="jh-small">总值 {formatYuan(a.value)}</span>
        <span className="jh-price jh-num">
          {current?.price
            ? `${formatYuan(current.price, { compact: false })}/${RENT_META[kind].unit}`
            : '—'}
        </span>
      </div>
      <div className="jh-card-other">
        {current?.firstPrice ? <Tag color="gold">首单 ¥{current.firstPrice}</Tag> : null}
        {current?.actPrice ? <Tag color="magenta">活动 ¥{current.actPrice}</Tag> : null}
        {others.slice(0, 3).map((p) => (
          <span key={p.kind} className="jh-small">
            {RENT_META[p.kind].label} {priceLine(result, p.kind)}
          </span>
        ))}
      </div>
    </div>
  );
}

function ResultList({ results, hasItems }: { results: ScanResultView[]; hasItems: boolean }) {
  const scan = useUi((s) => s.scan);
  const kind = scan?.conditions?.rentKind ?? 'HOUR';
  const favorites = useFavoriteSet();
  void favorites;
  return (
    <div className="jh-list">
      <div className={`jh-list-row jh-list-head ${hasItems ? '' : 'no-hit'}`}>
        <span />
        <span>账号编号</span>
        <span>状态</span>
        <span>命中饰品</span>
        {hasItems ? <span>命中件数</span> : null}
        <span>{RENT_META[kind].label}单价</span>
        <span>总价值</span>
        <span>卖点</span>
      </div>
      <VirtualGrid
        items={results}
        minColumnWidth={10_000}
        rowHeight={56}
        gap={0}
        getKey={(r) => r.account.accountNo}
        ariaLabel="结果列表"
        render={(r) => {
          const shown =
            r.hitItems.length > 0 ? r.hitItems.slice(0, 3) : r.account.displayItems.slice(0, 3);
          return (
            // biome-ignore lint/a11y/useSemanticElements: 行内含收藏按钮，不能嵌套在 <button> 中
            <div
              className={`jh-list-row ${hasItems ? '' : 'no-hit'}`}
              role="button"
              tabIndex={0}
              onClick={() => openDrawer(r)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openDrawer(r);
              }}
            >
              <FavoriteStar accountNo={r.account.accountNo} />
              <span className="jh-account">{r.account.accountNo}</span>
              <StatusBadge status={r.account.status} />
              <span className="jh-list-items">
                {shown.map((i) => (
                  <ItemCard key={i.key} item={i} compact hit={r.hitItems.length > 0} />
                ))}
                {r.hitCount > shown.length ? (
                  <span className="jh-small">+{r.hitCount - shown.length}</span>
                ) : null}
              </span>
              {hasItems ? <span className="jh-num">{r.hitCount}</span> : null}
              <span className="jh-num jh-price">{priceLine(r, kind)}</span>
              <span className="jh-num">{formatYuan(r.account.value)}</span>
              <span className="jh-tagline">{r.account.tags.join(' / ')}</span>
            </div>
          );
        }}
      />
    </div>
  );
}
