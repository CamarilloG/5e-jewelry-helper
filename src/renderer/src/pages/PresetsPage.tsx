// P6 常用方案：套用（跳 P1 并自动筛选）、行内重命名（非空、不重名）、删除二次确认；按上次使用倒序。
import { App, Button, Empty, Input, Space, Tooltip } from 'antd';
import { useEffect, useState } from 'react';
import type { FilterPresetView } from '../../../shared/dto';
import { call } from '../api';
import { relativeTime } from '../format';
import { conditionsToForm, useUi } from '../store';

export function PresetsPage() {
  const version = useUi((s) => s.presetsVersion);
  const { modal, message } = App.useApp();
  const [list, setList] = useState<FilterPresetView[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    void version;
    call('filters.list').then(setList, () => setList([]));
  }, [version]);
  const bump = () => useUi.setState((s) => ({ presetsVersion: s.presetsVersion + 1 }));
  const apply = async (p: FilterPresetView) => {
    const form = conditionsToForm(p.conditions, { id: p.id, name: p.name });
    useUi.setState({ form, page: 'FILTER', drawer: null });
    try {
      await call('scan.start', { conditions: p.conditions, presetId: p.id });
      bump();
    } catch (e) {
      message.error((e as Error).message || '无法开始筛选');
    }
  };
  const rename = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      message.warning('方案名不能为空');
      return;
    }
    const res = await call('filters.rename', { id: editing.id, name });
    if (!res.ok) {
      message.error(res.reason === 'DUPLICATE_NAME' ? '已存在同名方案' : '重命名失败');
      return;
    }
    setEditing(null);
    bump();
  };
  if (list && list.length === 0) {
    return (
      <div className="jh-page">
        <div className="jh-empty">
          <Empty description="还没有常用方案，在筛选页点「保存为方案」即可添加">
            <Button type="primary" onClick={() => useUi.getState().setPage('FILTER')}>
              去筛选
            </Button>
          </Empty>
        </div>
      </div>
    );
  }
  return (
    <div className="jh-page">
      <div className="jh-page-head">共 {list?.length ?? 0} 个方案</div>
      <div className="jh-preset-list">
        {(list ?? []).map((p) => (
          <div key={p.id} className="jh-preset-row">
            <div className="jh-preset-main">
              {editing?.id === p.id ? (
                <Input
                  autoFocus
                  value={editing.name}
                  maxLength={40}
                  status={editing.name.trim() ? undefined : 'error'}
                  onChange={(e) => setEditing({ id: p.id, name: e.target.value })}
                  onPressEnter={() => void rename()}
                  onBlur={() => void rename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  aria-label="方案名"
                  style={{ maxWidth: 320 }}
                />
              ) : (
                <button
                  type="button"
                  className="jh-preset-name jh-linklike"
                  onDoubleClick={() => setEditing({ id: p.id, name: p.name })}
                  title="双击重命名"
                >
                  {p.name}
                </button>
              )}
              <Tooltip title={p.summary}>
                <div className="jh-tagline jh-small">{p.summary}</div>
              </Tooltip>
            </div>
            <span className="jh-small">上次使用 {relativeTime(p.lastUsedAt)}</span>
            <Space>
              <Button type="primary" onClick={() => void apply(p)}>
                套用
              </Button>
              <Button onClick={() => setEditing({ id: p.id, name: p.name })}>重命名</Button>
              <Button
                danger
                onClick={() =>
                  modal.confirm({
                    title: `删除方案「${p.name}」？`,
                    okText: '删除',
                    okButtonProps: { danger: true },
                    onOk: async () => {
                      await call('filters.delete', { id: p.id });
                      const form = useUi.getState().form;
                      if (form.presetId === p.id) {
                        useUi.getState().setForm((f) => ({
                          ...f,
                          presetId: null,
                          presetName: null,
                          presetSnapshot: null,
                        }));
                      }
                      bump();
                    },
                  })
                }
              >
                删除
              </Button>
            </Space>
          </div>
        ))}
      </div>
    </div>
  );
}
