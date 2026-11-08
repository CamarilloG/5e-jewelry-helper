import { describe, expect, it } from 'vitest';
import type { InventoryItem } from '../src/main/platform/schemas';
import { selectFillItems } from '../src/main/services/views';
import { type ItemView, resultDisplayItems } from '../src/shared/dto';

const item = (key: string, price: string | null) => ({ key, price }) as ItemView;

describe('结果卡片饰品位', () => {
  it('命中优先，空位按估价从高到低补齐，且不重复', () => {
    const hits = [item('h1', '10')];
    const display = [item('d1', '50'), item('h1', '10'), item('d2', '900'), item('d3', '200')];
    expect(resultDisplayItems(hits, display, 3).map((i) => i.key)).toEqual(['h1', 'd2', 'd3']);
  });

  it('命中数达到上限时不补位，估价缺失排在最后', () => {
    expect(
      resultDisplayItems([item('a', '1'), item('b', '2')], [item('c', '99')], 2).map((i) => i.key),
    ).toEqual(['a', 'b']);
    expect(resultDisplayItems([], [item('x', null), item('y', '5')], 2).map((i) => i.key)).toEqual([
      'y',
      'x',
    ]);
  });

  it('主进程补位排除命中项，按估价降序且不超过上限', () => {
    const inv = [
      ['hit', '9999'],
      ['low', '1'],
      ['none', null],
      ['top', '800'],
      ['mid', '50'],
    ].map(([key, price]) => ({ key, price, stickers: [] }) as unknown as InventoryItem);
    expect(selectFillItems(inv, new Set(['hit']), 3).map((i) => i.key)).toEqual([
      'top',
      'mid',
      'low',
    ]);
  });
});
