// P7 设置：分组纵向排列 + 左侧锚点；修改即时保存并提示。
import {
  Anchor,
  App,
  Button,
  Empty,
  InputNumber,
  Radio,
  Select,
  Skeleton,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { RENT_KINDS, RENT_META } from '../../../shared/rent';
import {
  CACHE_TTL_LABEL,
  CACHE_TTLS,
  DEFAULT_RATE_LIMIT,
  type DeviceSettings,
  MONITOR_MIN_SECONDS,
  type OrderPreset,
} from '../../../shared/settings';
import { call } from '../api';
import { formatBytes, formatTime, relativeTime } from '../format';
import { useUi } from '../store';

const SECTIONS = [
  { key: 'auth', title: '登录态' },
  { key: 'monitor', title: '监测' },
  { key: 'notify', title: '通知' },
  { key: 'checkout', title: '出码' },
  { key: 'sync', title: '收藏同步' },
  { key: 'requests', title: '请求与缓存' },
  { key: 'general', title: '常规' },
  { key: 'about', title: '关于' },
];

const DISCLAIMER = `饰品驿站助手是第三方开源工具，与 5E 对战平台无关。它调用的是平台的非公开接口，平台可能随时变更或封堵；使用本工具产生的一切风险由用户自行承担。
本工具只做提醒和手动触发：不自动锁单、不自动抢单、不代为支付、不托管支付凭证；付款由你本人扫码完成，上号和下号回到 5E 客户端完成。
登录凭证只在本机读取，仅发送给 5E 官方鉴权接口，不写入日志、不出现在界面、不回传给作者或任何第三方。`;

export function SettingsPage() {
  const settings = useUi((s) => s.settings);
  const status = useUi((s) => s.status);
  const favorites = useUi((s) => s.favorites);
  const section = useUi((s) => s.settingsSection);
  const { message, modal } = App.useApp();
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void call('settings.get').then((s) => useUi.setState({ settings: s }));
  }, []);
  useEffect(() => {
    if (!section) return;
    document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' });
    useUi.setState({ settingsSection: null });
  }, [section]);
  if (!settings) {
    return (
      <div className="jh-page">
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }
  const d = settings.device;
  const update = async (patch: Partial<DeviceSettings> & { defaultPreset?: OrderPreset }) => {
    try {
      const next = await call('settings.update', patch);
      useUi.setState({ settings: next });
      message.success('已保存');
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    }
  };
  const auth = status?.auth;
  const preset = settings.profile?.defaultPreset;
  return (
    <div className="jh-settings">
      <nav className="jh-settings-nav" aria-label="设置分组">
        <Anchor
          affix={false}
          bounds={24}
          className="jh-settings-anchor"
          getContainer={() => container.current ?? window}
          items={SECTIONS.map((s) => ({
            key: s.key,
            href: `#settings-${s.key}`,
            title: s.title,
          }))}
          onClick={(e, link) => {
            e.preventDefault();
            document.getElementById(link.href.slice(1))?.scrollIntoView({ block: 'start' });
          }}
        />
      </nav>
      <div className="jh-settings-body" ref={container}>
        <Group id="auth" title="登录态">
          <Row label="当前状态">
            {auth?.phase === 'OK'
              ? `登录态正常${auth.daysLeft != null ? ` · 剩 ${auth.daysLeft} 天` : ''}`
              : (auth?.errorSummary ?? '登录态不可用')}
            <span className="jh-hint">（不显示凭证）· 上次读取 {formatTime(auth?.readAt)}</span>
          </Row>
          <Row label="重新读取">
            <Button
              onClick={() => void call('auth.reload').then((s) => useUi.setState({ status: s }))}
            >
              重新读取
            </Button>
          </Row>
          <Row label="客户端数据目录">
            <Typography.Text code className="jh-path">
              {auth?.dataDir ?? settings.defaultDataDir}
            </Typography.Text>
            <Space>
              <Button
                onClick={() =>
                  void call('auth.chooseDirectory').then((s) => useUi.setState({ status: s }))
                }
              >
                更改
              </Button>
              {auth?.customDir ? (
                <Button
                  onClick={() =>
                    void call('auth.resetDirectory').then((s) => useUi.setState({ status: s }))
                  }
                >
                  恢复自动检测
                </Button>
              ) : null}
            </Space>
          </Row>
        </Group>
        <Group id="monitor" title="监测">
          <Row label="检查间隔（秒）">
            <CommitNumber
              min={MONITOR_MIN_SECONDS}
              max={86_400}
              value={d.monitorIntervalSeconds}
              onCommit={(v) => void update({ monitorIntervalSeconds: v })}
              ariaLabel="检查间隔"
            />
            <span className="jh-hint">默认 60 秒，下限 30 秒；一轮结束后开始计时</span>
          </Row>
          <Row label="启动时自动开始监测">
            <Switch
              checked={d.autoStartMonitor}
              onChange={(v) => void update({ autoStartMonitor: v })}
            />
          </Row>
        </Group>
        <Group id="notify" title="通知">
          <Row label="桌面通知">
            <Switch checked={d.notifications} onChange={(v) => void update({ notifications: v })} />
          </Row>
          <Row label="提示音">
            <Switch checked={d.sound} onChange={(v) => void update({ sound: v })} />
          </Row>
        </Group>
        <Group id="checkout" title="出码">
          {preset ? (
            <>
              <Row label="新收藏的默认预设 · 租期">
                <Select
                  value={preset.rentKind}
                  style={{ width: 140 }}
                  options={RENT_KINDS.map((k) => ({ value: k, label: RENT_META[k].label }))}
                  onChange={(v) => void update({ defaultPreset: { ...preset, rentKind: v } })}
                />
              </Row>
              <Row label="数量">
                <Radio.Group
                  value={preset.quantity == null ? 'MIN' : 'FIXED'}
                  onChange={(e) =>
                    void update({
                      defaultPreset: {
                        ...preset,
                        quantity: e.target.value === 'MIN' ? null : (preset.quantity ?? 1),
                      },
                    })
                  }
                >
                  <Radio value="MIN">账号最小可选数量</Radio>
                  <Radio value="FIXED">固定</Radio>
                </Radio.Group>
                {preset.quantity != null ? (
                  <CommitNumber
                    min={1}
                    max={999}
                    value={preset.quantity}
                    onCommit={(v) => void update({ defaultPreset: { ...preset, quantity: v } })}
                    ariaLabel="固定数量"
                  />
                ) : null}
              </Row>
              <Row label="支付方式">
                <Radio.Group
                  value={preset.payChannel}
                  onChange={(e) =>
                    void update({ defaultPreset: { ...preset, payChannel: e.target.value } })
                  }
                >
                  <Radio value={1}>支付宝</Radio>
                  <Radio value={2}>微信</Radio>
                </Radio.Group>
                <span className="jh-hint">实际只启用平台当前返回的渠道</span>
              </Row>
              <Row label="自动用券">
                <Switch
                  checked={preset.autoCoupon}
                  onChange={(v) => void update({ defaultPreset: { ...preset, autoCoupon: v } })}
                />
              </Row>
            </>
          ) : (
            <div className="jh-hint">登录态就绪后可设置</div>
          )}
        </Group>
        <Group id="sync" title="收藏同步">
          <Row label="同步状态">
            {favorites?.sync.lastAt
              ? `${relativeTime(favorites.sync.lastAt)} · ${favorites.sync.ok ? '成功' : (favorites.sync.error ?? '未完成')}`
              : '尚未同步'}
            <Button
              size="small"
              loading={favorites?.sync.running}
              onClick={() => void call('favorites.syncNow')}
            >
              立即同步
            </Button>
          </Row>
          <Row label="已移除的收藏">
            {favorites && favorites.tombstones.length > 0 ? (
              <div className="jh-tombstones">
                {favorites.tombstones.map((t) => (
                  <div key={t.accountNo} className="jh-tombstone">
                    <span className="jh-account">{t.accountNo}</span>
                    <span className="jh-small">{formatTime(t.removedAt)} 移除</span>
                    <Button
                      size="small"
                      onClick={() => void call('favorites.restore', { accountNo: t.accountNo })}
                    >
                      恢复本地收藏
                    </Button>
                  </div>
                ))}
                <div className="jh-hint">恢复只恢复本地收藏，不会自动写回平台</div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有已移除的收藏" />
            )}
          </Row>
        </Group>
        <Group id="requests" title="请求与缓存">
          <Row label="请求速率上限（次/分钟）">
            <CommitNumber
              min={1}
              max={600}
              value={d.rateLimitPerMinute}
              onCommit={(v) => void update({ rateLimitPerMinute: v })}
              ariaLabel="请求速率上限"
            />
            {d.rateLimitPerMinute > DEFAULT_RATE_LIMIT ? (
              <span className="jh-warn-small">过高的请求频率可能被平台拦截或限制账号</span>
            ) : (
              <span className="jh-hint">默认 30 次/分钟，所有功能共用</span>
            )}
          </Row>
          <Row label="库存缓存时长">
            <Select
              value={d.inventoryCacheTtl}
              style={{ width: 140 }}
              options={CACHE_TTLS.map((t) => ({ value: t, label: CACHE_TTL_LABEL[t] }))}
              onChange={(v) => void update({ inventoryCacheTtl: v })}
            />
          </Row>
          <Row label="缓存占用">
            库存 {formatBytes(settings.cache.inventoryBytes)}（{settings.cache.inventoryEntries}{' '}
            个账号）· 图片 {formatBytes(settings.cache.imageBytes)}
            <Button
              size="small"
              onClick={() =>
                modal.confirm({
                  title: '清除本地缓存？',
                  content: '将清除库存和图片缓存，不删除收藏、预设和订单恢复记录。',
                  okText: '清除',
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    const next = await call('cache.clear');
                    useUi.setState({ settings: next });
                    message.success('缓存已清除');
                  },
                })
              }
            >
              清除缓存
            </Button>
            <span className="jh-hint">不删除收藏、预设和订单恢复记录</span>
          </Row>
        </Group>
        <Group id="general" title="常规">
          <Row label="关闭主窗口时">
            <Radio.Group
              value={d.closeBehavior}
              onChange={(e) => void update({ closeBehavior: e.target.value })}
            >
              <Radio value="TRAY">最小化到托盘</Radio>
              <Radio value="QUIT">退出</Radio>
            </Radio.Group>
          </Row>
          <Row label="诊断信息">
            <Button
              onClick={() =>
                void call('diagnostics.export').then((r) => {
                  if (r.saved) message.success('已导出（已脱敏，不含凭证、身份和付款码）');
                })
              }
            >
              导出诊断信息
            </Button>
          </Row>
        </Group>
        <Group id="about" title="关于">
          <Row label="版本">{settings.appVersion}</Row>
          <Row label="开源仓库">
            <Typography.Text copyable>{settings.repoUrl}</Typography.Text>
          </Row>
          <Row label="检查更新">
            <Button onClick={() => void call('app.openReleases')}>打开 GitHub 发布页</Button>
            <span className="jh-hint">不后台联网检查、不自动下载</span>
          </Row>
          <Row label="帮助">
            <Button onClick={() => void call('app.openHelp')}>查看帮助</Button>
          </Row>
          <Row label="免责声明">
            <div className="jh-disclaimer">{DISCLAIMER}</div>
          </Row>
        </Group>
      </div>
    </div>
  );
}

/** 数字设置项：输入过程不保存，失焦或回车时才提交一次。 */
function CommitNumber({
  value,
  min,
  max,
  onCommit,
  ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft == null || draft < min || draft > max) {
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  return (
    <InputNumber
      min={min}
      max={max}
      precision={0}
      value={draft}
      onChange={(next) => setDraft(typeof next === 'number' ? next : null)}
      onBlur={commit}
      onPressEnter={commit}
      aria-label={ariaLabel}
    />
  );
}

function Group({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={`settings-${id}`} className="jh-settings-group" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="jh-settings-row">
      <div className="jh-settings-label">{label}</div>
      <div className="jh-settings-value">{children}</div>
    </div>
  );
}
