// 收藏/取消收藏：取消收藏始终确认，并提供默认不勾选的“同时在平台取消收藏”。

import { StarFilled, StarOutlined } from '@ant-design/icons';
import { App, Button, Checkbox, Tooltip } from 'antd';
import { useMemo } from 'react';
import { call } from '../api';
import { useUi } from '../store';

export function useFavoriteSet(): Set<string> {
  const favorites = useUi((s) => s.favorites);
  return useMemo(() => new Set((favorites?.items ?? []).map((f) => f.accountNo)), [favorites]);
}

export function useFavoriteActions() {
  const { modal, message } = App.useApp();
  const add = async (accountNo: string) => {
    try {
      await call('favorites.add', { accountNo });
    } catch (error) {
      message.error((error as Error).message || '收藏失败');
    }
  };
  const remove = (accountNo: string) => {
    let alsoPlatform = false;
    modal.confirm({
      title: `取消收藏 ${accountNo}？`,
      content: (
        <div>
          <p>本地将记为“已移除”，之后同步不会自动加回；可在设置中恢复。</p>
          <Checkbox onChange={(e) => (alsoPlatform = e.target.checked)}>
            同时在平台取消收藏
          </Checkbox>
        </div>
      ),
      okText: '取消收藏',
      okButtonProps: { danger: true },
      cancelText: '保留',
      onOk: async () => {
        try {
          await call('favorites.remove', { accountNo, alsoPlatform });
        } catch (error) {
          message.error((error as Error).message || '操作失败');
        }
      },
    });
  };
  return { add, remove };
}

export function FavoriteStar({ accountNo, size = 16 }: { accountNo: string; size?: number }) {
  const set = useFavoriteSet();
  const { add, remove } = useFavoriteActions();
  const active = set.has(accountNo);
  return (
    <Tooltip title={active ? '取消收藏' : '收藏'}>
      <Button
        type="text"
        size="small"
        aria-label={active ? `取消收藏 ${accountNo}` : `收藏 ${accountNo}`}
        aria-pressed={active}
        icon={
          active ? (
            <StarFilled style={{ color: '#F59E0B', fontSize: size }} />
          ) : (
            <StarOutlined style={{ fontSize: size }} />
          )
        }
        onClick={(e) => {
          e.stopPropagation();
          if (active) remove(accountNo);
          else void add(accountNo);
        }}
      />
    </Tooltip>
  );
}
