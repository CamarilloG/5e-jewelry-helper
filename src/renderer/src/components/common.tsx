// 通用组件：状态徽标、缩略图（懒加载 + 破图占位）、饰品缩略卡、虚拟滚动网格、风险提示条。
import { Tag, Tooltip } from 'antd';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { ItemView } from '../../../shared/dto';
import { formatYuan } from '../../../shared/money';
import { type AccountStatus, STATUS_LABEL } from '../../../shared/status';
import { imgSrc } from '../api';
import { formatTime } from '../format';

export const STATUS_COLOR: Record<AccountStatus, string> = {
  AVAILABLE: '#22C55E',
  RENTED: '#F59E0B',
  OFF_SHELF: '#6B7280',
  UNKNOWN: '#9CA3AF',
};

export function StatusBadge({
  status,
  expireTimeMs,
  note,
}: {
  status: AccountStatus;
  expireTimeMs?: number | null;
  note?: string | null;
}) {
  const color = STATUS_COLOR[status];
  const extra = status === 'RENTED' && expireTimeMs ? ` · 约 ${formatTime(expireTimeMs)} 可租` : '';
  return (
    <span
      className={`jh-status jh-status-${status.toLowerCase()}`}
      style={{ color, borderColor: color }}
      role="status"
      aria-label={`${STATUS_LABEL[status]}${extra}`}
    >
      <span
        className="jh-dot"
        style={{ background: status === 'UNKNOWN' ? 'transparent' : color, borderColor: color }}
      />
      {STATUS_LABEL[status]}
      {extra}
      {note ? <span className="jh-status-note">{note}</span> : null}
    </span>
  );
}

export function Thumb({
  src,
  fallback,
  alt,
  size,
  style,
}: {
  src: string | null;
  fallback?: string | null;
  alt: string;
  size?: number | { w: number; h: number };
  style?: CSSProperties;
}) {
  const [current, setCurrent] = useState(src ?? fallback ?? null);
  const [broken, setBroken] = useState(!src && !fallback);
  useEffect(() => {
    setCurrent(src ?? fallback ?? null);
    setBroken(!src && !fallback);
  }, [src, fallback]);
  const w = typeof size === 'number' ? size : (size?.w ?? 72);
  const h = typeof size === 'number' ? size : (size?.h ?? 54);
  if (broken || !current) {
    return (
      <div
        className="jh-thumb jh-thumb-broken"
        style={{ width: w, height: h, ...style }}
        title={alt}
      >
        <span>{alt.slice(0, 12)}</span>
      </div>
    );
  }
  return (
    <img
      className="jh-thumb"
      src={imgSrc(current)}
      alt={alt}
      loading="lazy"
      width={w}
      height={h}
      style={{ width: w, height: h, ...style }}
      onError={() => {
        if (fallback && current !== fallback) setCurrent(fallback);
        else setBroken(true);
      }}
    />
  );
}

export function ItemCard({
  item,
  hit,
  compact,
}: {
  item: ItemView;
  hit?: boolean;
  compact?: boolean;
}) {
  const [name, finish] = item.name.split('|').map((s) => s.trim());
  return (
    <div className={`jh-item ${compact ? 'jh-item-compact' : ''}`} title={item.name}>
      <div className="jh-item-bar" style={{ background: item.rarityColor ?? '#d1d5db' }} />
      {hit ? <span className="jh-hit">命中</span> : null}
      {item.statTrak ? <span className="jh-st">ST</span> : null}
      <Tooltip
        placement="right"
        mouseEnterDelay={0.4}
        title={
          compact ? null : (
            <div className="jh-item-tip">
              <Thumb
                src={item.image}
                fallback={item.fallbackImage}
                alt={item.name}
                size={{ w: 220, h: 165 }}
              />
              <div>{item.name}</div>
              {item.stickers.length ? <div>贴纸/挂件：{item.stickers.join('、')}</div> : null}
            </div>
          )
        }
      >
        <div className="jh-item-img">
          <Thumb
            src={item.image}
            fallback={item.fallbackImage}
            alt={item.name}
            size={compact ? { w: 56, h: 42 } : { w: 112, h: 84 }}
            style={compact ? { width: '100%', height: 'auto', aspectRatio: '4 / 3' } : undefined}
          />
        </div>
      </Tooltip>
      {compact ? null : (
        <>
          <div className="jh-item-name">{name}</div>
          <div className="jh-item-sub">{finish ?? item.firstType}</div>
          <div className="jh-item-meta">
            <span>{item.wear ? Number(item.wear).toFixed(4) : '—'}</span>
            <span className="jh-num">{item.price ? formatYuan(item.price) : '—'}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function RiskBar({
  children,
  kind = 'danger',
}: {
  children: ReactNode;
  kind?: 'danger' | 'warning';
}) {
  return (
    <div className={`jh-risk jh-risk-${kind}`} role="alert">
      <span aria-hidden>⚠</span>
      <div>{children}</div>
    </div>
  );
}

export function SourceTag({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <Tag color={color} style={{ marginInlineEnd: 4 }}>
      {children}
    </Tag>
  );
}

/** 虚拟滚动网格：按容器宽度计算列数，只渲染可见行。 */
export function VirtualGrid<T>({
  items,
  minColumnWidth,
  rowHeight,
  gap = 12,
  render,
  getKey,
  ariaLabel,
}: {
  items: T[];
  minColumnWidth: number;
  rowHeight: number;
  gap?: number;
  render: (item: T, index: number) => ReactNode;
  getKey: (item: T) => string;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [scrollTop, setScrollTop] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const columns = Math.max(1, Math.floor((size.width + gap) / (minColumnWidth + gap)));
  const rows = Math.ceil(items.length / columns);
  const stride = rowHeight + gap;
  const first = Math.max(0, Math.floor(scrollTop / stride) - 2);
  const last = Math.min(rows, Math.ceil((scrollTop + size.height) / stride) + 2);
  const visible: ReactNode[] = [];
  for (let row = first; row < last; row++) {
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col;
      const item = items[index];
      if (item === undefined) break;
      visible.push(
        <div
          key={getKey(item)}
          style={{
            position: 'absolute',
            top: row * stride,
            left: `calc(${(100 / columns) * col}% + ${(gap * col) / columns}px)`,
            width: `calc(${100 / columns}% - ${(gap * (columns - 1)) / columns}px)`,
            height: rowHeight,
          }}
        >
          {render(item, index)}
        </div>,
      );
    }
  }
  return (
    <section
      ref={ref}
      className="jh-virtual"
      aria-label={ariaLabel}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ position: 'relative', height: Math.max(0, rows * stride - gap) }}>
        {visible}
      </div>
    </section>
  );
}
