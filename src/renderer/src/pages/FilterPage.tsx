// P1 筛选主页：条件面板（同件条件行、行间交集、租期价格、本地匹配）+ 可中断扫描进度 + 状态待确认折叠分组 + 卡片/列表结果。
import {
  CloseOutlined,
  DownOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  RightOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Cascader,
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
import {
  CATEGORIES,
  CATEGORY_BY_ID,
  CATEGORY_GROUPS,
  categoryDisplay,
  SKIN_SUGGESTIONS,
} from '../../../shared/catalog';
import {
  type FilterPresetView,
  partitionResultsForFilter,
  resultDisplayItems,
  type ScanResultView,
  type SortKey,
  type StatusFilter,
  sortResultList,
} from '../../../shared/dto';
import { formatYuan } from '../../../shared/money';
import { RENT_KINDS, RENT_META } from '../../../shared/rent';
import { call } from '../api';
import { activateOnKey, ItemCard, StatusBadge, VirtualGrid } from '../components/common';
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

const CARD_ITEM_SLOTS = 4;
const CARD_HEIGHT = 222;
const CARD_HEIGHT_WITH_HITS = 244;
const LIST_ITEM_SLOTS = 3;

export { partitionResultsForFilter, type SortKey, type StatusFilter, sortResultList };

interface CascadeOption {
  label: string;
  value: string;
  children?: CascadeOption[];
}

// 第一层大类、第二层子类；勾选整个大类 = 该大类任意饰品
const categoryOptions: CascadeOption[] = CATEGORY_GROUPS.map((g) => ({
  label: g.label,
  value: g.id,
  children: CATEGORIES.filter((c) => c.kind === 'weapon' && c.groupId === g.id).map((c) => ({
    label: c.label,
    value: c.id,
  })),
}));

/** 条件 id → 级联路径 */
function idToPath(id: string): string[] {
  const entry = CATEGORY_BY_ID.get(id);
  if (!entry) return [];
  return entry.kind === 'first' ? [id] : [entry.groupId, id];
}

/** 级联路径 → 条件 id（整组勾选时为大类 id） */
function pathToId(path: (string | number)[]): string | null {
  const last = path[path.length - 1];
  return typeof last === 'string' ? last : null;
}

/** 只含未展开大类、没有皮肤名称的行无法用关键词检索（匕首与手套已支持大类展开） */
function rowNeedsBrowse(row: { categoryIds: string[]; names: string[] }) {
  return (
    row.names.length === 0 &&
    row.categoryIds.some(
      (id) => CATEGORY_BY_ID.get(id)?.kind === 'first' && id !== 'f:手套' && id !== 'f:匕首',
    )
  );
}

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
  const [presetsFailed, setPresetsFailed] = useState(false);
  useEffect(() => {
    void presetsVersion;
    call('filters.list').then(
      (list) => {
        setPresets(list);
        setPresetsFailed(false);
      },
      () => {
        setPresets([]);
        setPresetsFailed(true);
      },
    );
  }, [presetsVersion]);
  const modified =
    form.presetId != null && form.presetSnapshot !== JSON.stringify(formToConditions(form));
  const invalid =
    priceInvalid(form) || !PRICE_RE.test(form.priceMin) || !PRICE_RE.test(form.priceMax);
  const active = scan?.phase === 'CANDIDATES' || scan?.phase === 'VERIFYING';
  const filled = form.rows.filter((r) => r.categoryIds.length > 0 || r.names.length > 0);
  const noKeyword = filled.length > 0 && filled.every(rowNeedsBrowse);
  const updateRow = (id: number, patch: Partial<{ categoryIds: string[]; names: string[] }>) =>
    setForm((f) => ({
      ...f,
      rows: f.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));

  const start = async (next?: FilterForm, forceRefresh = false) => {
    const f = next ?? form;
    try {
      await call('scan.start', {
        conditions: formToConditions(f),
        presetId: f.presetId,
        forceRefresh,
      });
    } catch (error) {
      message.error((error as Error).message || '无法开始筛选');
    }
  };

  const startLocal = async (next?: FilterForm) => {
    const f = next ?? form;
    try {
      await call('scan.startLocal', {
        conditions: formToConditions(f),
        presetId: f.presetId,
      });
    } catch (error) {
      message.error((error as Error).message || '无法执行本地匹配');
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
          notFoundContent={presetsFailed ? '方案加载失败，请稍后重试' : '还没有常用方案'}
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
            <Cascader<CascadeOption>
              multiple
              allowClear
              showSearch={{
                filter: (input, path) =>
                  path.some((o) => o.label.toLowerCase().includes(input.trim().toLowerCase())),
              }}
              showCheckedStrategy={Cascader.SHOW_PARENT}
              expandTrigger="hover"
              placeholder="大类 / 子类（可多选，任一即可）"
              style={{ width: '100%', marginBottom: 6 }}
              value={row.categoryIds.map(idToPath).filter((p) => p.length > 0)}
              options={categoryOptions}
              displayRender={(labels) => labels[labels.length - 1]}
              tagRender={({ label, closable, onClose }) => {
                // 大类名与子类名互不重复，整组勾选的标签显示为「任意××」
                const whole = CATEGORY_GROUPS.some((g) => g.label === label);
                return (
                  <Tag closable={closable} onClose={onClose} style={{ marginInlineEnd: 4 }}>
                    {whole ? `任意${String(label)}` : label}
                  </Tag>
                );
              }}
              aria-label={`条件 ${index + 1} 大类与子类`}
              onChange={(paths: (string | number)[][]) =>
                updateRow(row.id, {
                  categoryIds: (paths ?? [])
                    .map((p) => pathToId(p))
                    .filter((id): id is string => !!id),
                })
              }
            />
            <Select
              mode="tags"
              allowClear
              style={{ width: '100%' }}
              placeholder="皮肤，如 多普勒（可多选或直接输入）"
              value={row.names}
              options={SKIN_SUGGESTIONS.map((s) => ({ value: s, label: s }))}
              tokenSeparators={[',', '，']}
              aria-label={`条件 ${index + 1} 皮肤`}
              onChange={(values: string[]) =>
                updateRow(row.id, {
                  names: [
                    ...new Set(values.map((v) => v.trim().slice(0, 40)).filter(Boolean)),
                  ].slice(0, 20),
                })
              }
            />
            {row.categoryIds.length > 1 || row.names.length > 1 ? (
              <div className="jh-small" style={{ marginTop: 4 }}>
                同一件饰品满足
                {row.categoryIds.length > 1 ? '任一所选类别' : '所选类别'}
                {row.names.length > 0
                  ? row.names.length > 1
                    ? '且任一所选皮肤'
                    : '且所选皮肤'
                  : ''}
                即可
              </div>
            ) : null}
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
          条件只有“任意大类”时无法用关键词检索，将浏览该租期全部账号并逐个确认，耗时较长；建议再加一行具体子类或皮肤。
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
      {!PRICE_RE.test(form.priceMin) || !PRICE_RE.test(form.priceMax) ? (
        <div className="jh-error-text">价格只能填写数字，最多 2 位小数</div>
      ) : priceInvalid(form) ? (
        <div className="jh-error-text">价格下限不能大于上限</div>
      ) : null}
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
        <Button block disabled={invalid} onClick={() => void startLocal()}>
          本地匹配
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
        [i.categoryIds.map(categoryDisplay).join('/'), i.names.join('/')].filter(Boolean).join(' '),
      )
      .join(' + ');
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

function Results() {
  const scan = useUi((s) => s.scan);
  const status = useUi((s) => s.status);
  const settings = useUi((s) => s.settings);
  const setForm = useUi((s) => s.setForm);
  const { message } = App.useApp();
  const hasItems = scan?.hasItemConditions ?? false;
  // A3（R04）：默认排序改为价格升序（PRICE_ASC）
  const [sort, setSort] = useState<SortKey>('PRICE_ASC');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('AVAILABLE');
  const [pendingExpanded, setPendingExpanded] = useState(true);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const view = settings?.device.resultView ?? 'CARD';

  const rentKind = scan?.conditions?.rentKind ?? 'HOUR';
  const { mainResults, pendingResults, availableCount, hiddenNonAvailableCount } = useMemo(
    () => partitionResultsForFilter(scan?.results ?? [], sort, statusFilter, rentKind),
    [scan?.results, sort, statusFilter, rentKind],
  );

  const phase = scan?.phase ?? 'IDLE';
  const active = phase === 'CANDIDATES' || phase === 'VERIFYING';
  const totalVisible = mainResults.length + pendingResults.length;
  const cardHeight = hasItems ? CARD_HEIGHT_WITH_HITS : CARD_HEIGHT;

  const examples: { label: string; form: Partial<FilterForm> }[] = [
    { label: '蝴蝶刀 + 多普勒', form: { rows: [newRow(['w:蝴蝶刀'], ['多普勒'])] } },
    {
      label: '蝴蝶刀或爪子刀 且 任意手套',
      form: { rows: [newRow(['w:蝴蝶刀', 'w:爪子刀']), newRow(['f:手套'])] },
    },
    { label: '多普勒 · 时租 ≤ ¥10', form: { rows: [newRow([], ['多普勒'])], priceMax: '10' } },
  ];

  const emptyText =
    scan?.emptyReason === 'NO_LOCAL_RECORDS'
      ? '无本地记录'
      : scan?.emptyReason === 'SOURCE_UNAVAILABLE'
        ? '未完成：候选来源不可用'
        : hiddenNonAvailableCount > 0 && statusFilter === 'AVAILABLE'
          ? `已命中 ${hiddenNonAvailableCount} 个账号（均为租赁中或已下架，已在「仅可租」下隐藏）`
          : '没有符合条件的账号';

  return (
    <section className="jh-results" aria-label="筛选结果">
      <ScanHeader />
      {phase !== 'IDLE' ? (
        <div className="jh-toolbar">
          <Space wrap>
            <Select<SortKey>
              value={sort}
              onChange={setSort}
              style={{ width: 108 }}
              aria-label="排序"
              options={[
                { value: 'PRICE_ASC', label: '价格↑' },
                { value: 'PRICE_DESC', label: '价格↓' },
                ...(hasItems ? [{ value: 'SCORE' as SortKey, label: '匹配度' }] : []),
                { value: 'VALUE_ASC', label: '总价值↑' },
                { value: 'VALUE_DESC', label: '总价值↓' },
              ]}
            />
            <Select<StatusFilter>
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 96 }}
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
          <span className="jh-small">
            {statusFilter === 'AVAILABLE' ? (
              <>
                当前可租 {availableCount} 个
                {pendingResults.length > 0 ? ` · 状态待确认 ${pendingResults.length} 个` : ''}
                {hiddenNonAvailableCount > 0
                  ? `（已隐藏 ${hiddenNonAvailableCount} 个租赁中/已下架）`
                  : ''}
              </>
            ) : (
              <>当前显示 {mainResults.length} 个</>
            )}
            <Tooltip title="本次搜索范围：平台候选 + 本地已知账号；不代表平台全部下架账号">
              <InfoCircleOutlined className="jh-scope-icon" aria-label="搜索范围说明" />
            </Tooltip>
          </span>
        </div>
      ) : null}
      <div className="jh-results-body" ref={setScroller}>
        {phase === 'IDLE' ? (
          <div className="jh-empty">
            <Empty description="设置条件后点击开始筛选，或使用本地匹配查看已缓存结果；下方示例可一键填入条件" />
            <Space wrap style={{ justifyContent: 'center' }}>
              {examples.map((ex) => (
                <Button
                  key={ex.label}
                  onClick={() => {
                    setForm(() => ({ ...emptyForm(), ...ex.form }));
                    message.info('已填入条件，点击「开始筛选」查询');
                  }}
                >
                  {ex.label}
                </Button>
              ))}
            </Space>
            {status?.auth.phase !== 'OK' ? (
              <div className="jh-hint">当前离线或登录态未就绪，仍可使用「本地匹配」</div>
            ) : null}
          </div>
        ) : (
          <>
            {statusFilter === 'AVAILABLE' && pendingResults.length > 0 ? (
              <section className="jh-pending-group" aria-label="已匹配，状态待确认分组">
                <button
                  type="button"
                  className="jh-pending-head"
                  aria-expanded={pendingExpanded}
                  onClick={() => setPendingExpanded((e) => !e)}
                >
                  <Space size={6}>
                    {pendingExpanded ? <DownOutlined /> : <RightOutlined />}
                    <span>已匹配，状态待确认（{pendingResults.length}）</span>
                    <span className="jh-small">状态确认后可租账号会自动移入下方「仅可租」列表</span>
                  </Space>
                </button>
                {pendingExpanded ? (
                  <div className="jh-pending-body">
                    <VirtualGrid
                      items={pendingResults}
                      minColumnWidth={250}
                      rowHeight={cardHeight}
                      getKey={(r) => r.account.accountNo}
                      ariaLabel="状态待确认结果"
                      render={(r) => <ResultCard result={r} />}
                      scrollParent={scroller}
                    />
                  </div>
                ) : null}
              </section>
            ) : null}

            {totalVisible === 0 && hiddenNonAvailableCount === 0 && active ? (
              <div className="jh-skeletons">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} active paragraph={{ rows: 4 }} />
                ))}
              </div>
            ) : mainResults.length === 0 && pendingResults.length === 0 ? (
              <div className="jh-empty">
                <Empty description={emptyText} />
                <div className="jh-hint">
                  {hiddenNonAvailableCount > 0 && statusFilter === 'AVAILABLE' ? (
                    <Button size="small" type="link" onClick={() => setStatusFilter('ALL')}>
                      切换到「全部」查看已命中的 {hiddenNonAvailableCount} 个账号
                    </Button>
                  ) : (
                    '建议：放宽价格 / 减少条件 / 状态选「全部」'
                  )}
                </div>
              </div>
            ) : mainResults.length === 0 ? null : view === 'CARD' ? (
              <VirtualGrid
                items={mainResults}
                minColumnWidth={250}
                rowHeight={cardHeight}
                getKey={(r) => r.account.accountNo}
                ariaLabel="结果卡片"
                render={(r) => <ResultCard result={r} />}
                scrollParent={scroller}
              />
            ) : (
              <ResultList results={mainResults} hasItems={hasItems} scrollParent={scroller} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

function ScanHeader() {
  const scan = useUi((s) => s.scan);
  const status = useUi((s) => s.status);
  const form = useUi((s) => s.form);
  if (!scan || scan.phase === 'IDLE') return null;

  const discoveryDone = Boolean(scan.discoveryComplete);
  const pct =
    discoveryDone && scan.candidates > 0 ? Math.round((scan.confirmed / scan.candidates) * 100) : 0;
  const waiting = status?.requests.waitingMs ?? 0;
  const paused = status?.requests.pausedReason;
  const count = scan.results.length;
  const availableTotal = scan.results.filter((r) => r.account.status === 'AVAILABLE').length;
  const checkedCount = scan.checkedCount ?? scan.confirmed;
  const pendingCount = scan.pendingCount ?? Math.max(0, scan.candidates - scan.confirmed);
  const failedPageCount = scan.failedPages?.length ?? 0;
  const hasFailures = scan.failedAccounts.length > 0 || failedPageCount > 0;
  const partialText =
    scan.partialReasons && scan.partialReasons.length > 0
      ? `（${scan.partialReasons.join('、')}）`
      : '';

  return (
    <div className="jh-scan-head" aria-live="polite">
      {scan.phase === 'CANDIDATES' ? (
        <>
          <span>
            正在获取候选账号… 已展示 {count} 个匹配
            {checkedCount > 0 ? ` · 已检查 ${checkedCount}` : ''}
          </span>
          <Button size="small" onClick={() => void call('scan.stop')}>
            停止
          </Button>
        </>
      ) : scan.phase === 'VERIFYING' ? (
        <>
          <span>
            {scan.hasItemConditions ? '确认中' : '状态确认中'} · 已检查 {checkedCount} / 待检查{' '}
            {pendingCount}（候选 {scan.candidates}）
          </span>
          {discoveryDone ? (
            <Progress
              percent={pct}
              size="small"
              style={{ width: 160, margin: 0 }}
              showInfo={false}
            />
          ) : null}
          <Button size="small" onClick={() => void call('scan.stop')}>
            停止
          </Button>
        </>
      ) : scan.phase === 'COMPLETE' ? (
        <span>
          共 {count} 个符合条件的账号（其中可租 {availableTotal} 个）· 完成于{' '}
          {formatTime(scan.finishedAt)}
          {scan.localOnly ? (
            <Tag color="blue" style={{ marginLeft: 8 }}>
              本地匹配
            </Tag>
          ) : scan.coverageComplete && !scan.incomplete ? (
            <Tag color="green" style={{ marginLeft: 8 }}>
              覆盖完整
            </Tag>
          ) : (
            <Tag color="orange" style={{ marginLeft: 8 }}>
              结果不完整{partialText}
            </Tag>
          )}
        </span>
      ) : scan.phase === 'STOPPED' ? (
        <>
          <span>
            已停止 ·{' '}
            {discoveryDone ? `已确认 ${checkedCount}/${scan.candidates}` : '候选获取未结束'}
            ，结果不完整{partialText}
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

      {scan.fromCache && scan.snapshotAt ? (
        <Space size={6}>
          <span className="jh-small">候选快照：{formatTime(scan.snapshotAt)}</span>
          {status?.auth.phase === 'OK' ? (
            <Button
              size="small"
              onClick={() =>
                void call('scan.start', {
                  conditions: scan.conditions ?? formToConditions(form),
                  presetId: form.presetId,
                  forceRefresh: true,
                })
              }
            >
              刷新最新
            </Button>
          ) : null}
        </Space>
      ) : null}

      {scan.phase === 'VERIFYING' && waiting > 0 ? (
        <Tag>限速等待 {Math.ceil(waiting / 1000)}s</Tag>
      ) : null}
      {paused && (scan.phase === 'VERIFYING' || scan.phase === 'CANDIDATES') ? (
        <Tag color="orange">{paused}</Tag>
      ) : null}
      {hasFailures && (scan.phase === 'COMPLETE' || scan.phase === 'STOPPED') ? (
        <Button size="small" onClick={() => void call('scan.retryFailed')}>
          重试失败项（
          {[
            failedPageCount > 0 ? `${failedPageCount} 页` : null,
            scan.failedAccounts.length > 0 ? `${scan.failedAccounts.length} 个账号` : null,
          ]
            .filter(Boolean)
            .join(' + ')}
          ）
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

/** 补位来源：优先完整库存选出的饰品，未读库存时退回平台展示位。 */
function fillCandidates(result: ScanResultView) {
  return result.fillItems?.length ? result.fillItems : result.account.displayItems;
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
  const kind = useUi((s) => s.scan?.conditions?.rentKind ?? 'HOUR');
  const hasItemConditions = useUi((s) => s.scan?.hasItemConditions ?? false);
  const a = result.account;
  const current = a.prices.find((p) => p.kind === kind);
  const others = a.prices.filter((p) => p.kind !== kind && p.supported);
  const shown = resultDisplayItems(result.hitItems, fillCandidates(result), CARD_ITEM_SLOTS);
  const hitKeys = new Set(result.hitItems.map((i) => i.key));
  const more = result.hitCount != null ? Math.max(0, result.hitCount - hitKeys.size) : 0;
  const isSearchEvidence = result.evidence === 'search' || result.hitCount === null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: 卡片内含收藏按钮，不能嵌套在 <button> 中
    <div
      className="jh-card"
      role="button"
      tabIndex={0}
      aria-label={`账号 ${a.accountNo}`}
      onClick={() => openDrawer(result)}
      onKeyDown={activateOnKey(() => openDrawer(result))}
    >
      <div className="jh-card-head">
        <span className="jh-account">{a.accountNo}</span>
        <FavoriteStar accountNo={a.accountNo} />
      </div>
      <div className="jh-card-sub">
        <StatusBadge status={a.status} expireTimeMs={a.expireTimeMs} />
        {result.origin === 'local' ? <Tag>本地已知</Tag> : null}
        {result.fromHistory ? <Tag>上次结果</Tag> : null}
        {result.reverifyFailed ? <Tag color="orange">未能复核</Tag> : null}
        {result.stale ? <Tag color="blue">历史/待核验</Tag> : null}
        {a.couponAllowed ? <Tag color="purple">券</Tag> : null}
      </div>
      <Tooltip title={a.tags.join(' / ')}>
        <div className="jh-tagline">{a.tags.join(' / ') || '—'}</div>
      </Tooltip>
      <div className="jh-card-items">
        {shown.map((item) => (
          <ItemCard key={item.key} item={item} hit={hitKeys.has(item.key)} compact />
        ))}
      </div>
      {hasItemConditions ? (
        <div className="jh-small">
          {isSearchEvidence ? '类别条件匹配，库存详情按需加载' : `命中 ${result.hitCount} 件`}
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
      ) : null}
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

function ResultList({
  results,
  hasItems,
  scrollParent,
}: {
  results: ScanResultView[];
  hasItems: boolean;
  scrollParent: HTMLElement | null;
}) {
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
        <span>{hasItems ? '命中饰品' : '饰品'}</span>
        {hasItems ? <span>命中</span> : null}
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
        scrollParent={scrollParent}
        render={(r) => {
          const shown = resultDisplayItems(r.hitItems, fillCandidates(r), LIST_ITEM_SLOTS);
          const hitKeys = new Set(r.hitItems.map((i) => i.key));
          const shownHits = shown.filter((i) => hitKeys.has(i.key)).length;
          const isSearchEvidence = r.evidence === 'search' || r.hitCount === null;
          return (
            // biome-ignore lint/a11y/useSemanticElements: 行内含收藏按钮，不能嵌套在 <button> 中
            <div
              className={`jh-list-row ${hasItems ? '' : 'no-hit'}`}
              role="button"
              tabIndex={0}
              onClick={() => openDrawer(r)}
              onKeyDown={activateOnKey(() => openDrawer(r))}
            >
              <FavoriteStar accountNo={r.account.accountNo} />
              <span className="jh-account">{r.account.accountNo}</span>
              <StatusBadge status={r.account.status} />
              <span className="jh-list-items">
                {shown.map((i) => (
                  <ItemCard key={i.key} item={i} compact hit={hitKeys.has(i.key)} />
                ))}
                {r.hitCount != null && r.hitCount > shownHits ? (
                  <span className="jh-small">+{r.hitCount - shownHits}</span>
                ) : null}
              </span>
              {hasItems ? (
                <span className="jh-num">
                  {isSearchEvidence ? (
                    <Tooltip title="类别条件匹配，库存详情按需加载">
                      <span className="jh-small">未计算</span>
                    </Tooltip>
                  ) : (
                    r.hitCount
                  )}
                </span>
              ) : null}
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
