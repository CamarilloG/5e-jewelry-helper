// 应用与托盘图标的程序化绘制（无第三方品牌元素）：靛蓝圆角方块 + 白色菱形；托盘可叠加状态点和可租数角标。
// 纯函数，返回 RGBA 像素；同时被打包脚本用于生成安装器图标。

export type IconTone = 'normal' | 'paused' | 'alert';

const COLORS = {
  normal: [0x4f, 0x46, 0xe5],
  paused: [0x9c, 0xa3, 0xaf],
  badge: [0xef, 0x44, 0x44],
  alert: [0xf5, 0x9e, 0x0b],
} as const;

// 3×5 点阵数字与 “+”
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

function blend(
  px: Uint8Array,
  size: number,
  x: number,
  y: number,
  rgb: readonly number[],
  a: number,
) {
  if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
  const i = (y * size + x) * 4;
  const srcA = Math.min(1, a);
  const dstA = (px[i + 3] ?? 0) / 255;
  const outA = srcA + dstA * (1 - srcA);
  for (let c = 0; c < 3; c++) {
    const dst = px[i + c] ?? 0;
    px[i + c] = Math.round(((rgb[c] ?? 0) * srcA + dst * dstA * (1 - srcA)) / (outA || 1));
  }
  px[i + 3] = Math.round(outA * 255);
}

/** 以 4×4 超采样计算覆盖率。 */
function fill(
  px: Uint8Array,
  size: number,
  rgb: readonly number[],
  inside: (x: number, y: number) => boolean,
) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
      if (hit) blend(px, size, x, y, rgb, hit / 16);
    }
  }
}

export function renderIcon(
  size: number,
  options: { tone?: IconTone; badge?: number; dot?: boolean } = {},
): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const tone = options.tone ?? 'normal';
  const base = tone === 'paused' ? COLORS.paused : COLORS.normal;
  const r = size * 0.22;
  const m = size * 0.04;
  fill(px, size, base, (x, y) => {
    const cx = Math.min(Math.max(x, m + r), size - m - r);
    const cy = Math.min(Math.max(y, m + r), size - m - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  });
  const c = size / 2;
  const outer = size * 0.3;
  const inner = size * 0.15;
  fill(px, size, [255, 255, 255], (x, y) => {
    const d = Math.abs(x - c) + Math.abs(y - c);
    return d <= outer && d >= inner;
  });
  if (options.dot || tone === 'alert') {
    const rr = size * 0.2;
    fill(
      px,
      size,
      COLORS.alert,
      (x, y) => (x - (size - rr)) ** 2 + (y - (size - rr)) ** 2 <= rr * rr,
    );
  }
  const badge = options.badge ?? 0;
  if (badge > 0) {
    const text = badge > 9 ? '9+' : String(badge);
    const br = size * 0.3;
    const bx = size - br;
    const by = br;
    fill(px, size, COLORS.badge, (x, y) => (x - bx) ** 2 + (y - by) ** 2 <= br * br);
    const scale = Math.max(1, Math.floor(size / 16));
    const width = text.length * 3 * scale + (text.length - 1) * scale;
    const height = 5 * scale;
    const ox = Math.round(bx - width / 2);
    const oy = Math.round(by - height / 2);
    [...text].forEach((ch, idx) => {
      const glyph = GLYPHS[ch];
      if (!glyph) return;
      glyph.forEach((row, gy) => {
        [...row].forEach((bit, gx) => {
          if (bit !== '1') return;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++)
              blend(
                px,
                size,
                ox + idx * 4 * scale + gx * scale + dx,
                oy + gy * scale + dy,
                [255, 255, 255],
                1,
              );
        });
      });
    });
  }
  return px;
}

/** RGBA → BGRA（Electron nativeImage.createFromBitmap 所需）。 */
export function toBgra(rgba: Uint8Array): Buffer {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2] ?? 0;
    out[i + 1] = rgba[i + 1] ?? 0;
    out[i + 2] = rgba[i] ?? 0;
    out[i + 3] = rgba[i + 3] ?? 0;
  }
  return out;
}
