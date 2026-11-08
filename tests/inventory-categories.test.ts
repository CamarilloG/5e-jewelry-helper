import { describe, expect, it } from 'vitest';
import { inventoryCategoryKey, inventoryCategoryTabs } from '../src/shared/catalog';

describe('详情库存分类页签', () => {
  it('只列实际存在的类别，已知大类顺序固定并使用展示名', () => {
    const tabs = inventoryCategoryTabs([
      { firstType: '手枪' },
      { firstType: '匕首' },
      { firstType: '手枪' },
      { firstType: '手套' },
    ]);
    expect(tabs).toEqual([
      { key: '匕首', label: '刀', count: 1 },
      { key: '手套', label: '手套', count: 1 },
      { key: '手枪', label: '手枪', count: 2 },
    ]);
  });

  it('缺失类型归入「其他」，未知类别排在已知大类之后', () => {
    const items = [
      { firstType: '' },
      { firstType: null },
      { firstType: '探员' },
      { firstType: '步枪' },
    ];
    expect(inventoryCategoryKey('  ')).toBe('其他');
    expect(inventoryCategoryTabs(items).map((t) => [t.key, t.count])).toEqual([
      ['步枪', 1],
      ['其他', 2],
      ['探员', 1],
    ]);
  });
});
