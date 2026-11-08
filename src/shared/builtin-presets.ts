// 随包内置的常用方案（业务流程 §8）。每个用户首次进入时写入一次，之后与自建方案相同，
// 可改名、覆盖、删除；删除后不再自动补回（按 key 记录已写入）。
import type { FilterConditions } from './dto';

export interface BuiltinFilterPreset {
  /** 稳定标识，用于记录是否已写入 */
  key: string;
  name: string;
  conditions: FilterConditions;
}

export const BUILTIN_FILTER_PRESETS: BuiltinFilterPreset[] = [
  {
    key: 'knives4-gloves-core-guns',
    name: '四刀 + 手套 + AK/M4A1/USP/格洛克',
    conditions: {
      items: [
        { categoryIds: ['w:蝴蝶刀', 'w:爪子刀', 'w:锯齿爪刀', 'w:M9 刺刀'], names: [] },
        { categoryIds: ['f:手套'], names: [] },
        { categoryIds: ['w:AK-47'], names: [] },
        { categoryIds: ['w:M4A1 消音版'], names: [] },
        { categoryIds: ['w:USP 消音版'], names: [] },
        { categoryIds: ['w:格洛克 18 型'], names: [] },
      ],
      rentKind: 'HOUR',
      priceMin: null,
      priceMax: null,
      couponOnly: false,
    },
  },
];
