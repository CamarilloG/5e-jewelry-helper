// 随包发布的版本化饰品分类词典（接口与数据规范 §3、§8 R6）。
// 三层：大类（按平台 firstType 精确归一化比较）→ 子类（按市场名称武器前缀精确归一化比较，含别名）
// → 皮肤（名称包含匹配，自由输入 + 常见联想，不在本词典内）。
// keyword：平台单关键词搜索用词，必须是该子类所有饰品名称都包含的子串（不含空格以兼容
// 「格洛克 18 型 / 格洛克18型」等写法差异）；可以比子类宽（候选更多，靠完整库存确认收窄），
// 不能比子类窄。大类没有这样的词，keyword 为 null。

export const CATALOG_VERSION = '2026.11.08-1';

export interface CategoryGroup {
  /** 稳定 id：`f:<firstType>`，存入方案 */
  id: string;
  /** 界面显示名 */
  label: string;
  /** 平台 firstType */
  firstType: string;
}

export interface CategoryEntry {
  id: string;
  label: string;
  /** 所属大类 id */
  groupId: string;
  kind: 'first' | 'weapon';
  /** weapon：武器前缀的全部已知写法（含 label） */
  names: string[];
  keyword: string | null;
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { id: 'f:匕首', label: '刀', firstType: '匕首' },
  { id: 'f:手套', label: '手套', firstType: '手套' },
  { id: 'f:步枪', label: '步枪', firstType: '步枪' },
  { id: 'f:狙击步枪', label: '狙击步枪', firstType: '狙击步枪' },
  { id: 'f:手枪', label: '手枪', firstType: '手枪' },
  { id: 'f:微型冲锋枪', label: '微型冲锋枪', firstType: '微型冲锋枪' },
  { id: 'f:霰弹枪', label: '霰弹枪', firstType: '霰弹枪' },
  { id: 'f:机枪', label: '机枪', firstType: '机枪' },
];

type WeaponSpec = string | { label: string; aliases?: string[]; keyword?: string };

const weapons = (groupId: string, specs: WeaponSpec[]): CategoryEntry[] =>
  specs.map((spec) => {
    const s = typeof spec === 'string' ? { label: spec } : spec;
    return {
      id: `w:${s.label}`,
      label: s.label,
      groupId,
      kind: 'weapon',
      names: [s.label, ...(s.aliases ?? [])],
      keyword: s.keyword ?? s.label.replace(/\s+/g, ''),
    };
  });

export const CATEGORIES: CategoryEntry[] = [
  ...CATEGORY_GROUPS.map(
    (g): CategoryEntry => ({
      id: g.id,
      label: g.label,
      groupId: g.id,
      kind: 'first',
      names: [],
      keyword: null,
    }),
  ),
  ...weapons('f:匕首', [
    '爪子刀',
    '蝴蝶刀',
    { label: 'M9 刺刀', keyword: 'M9' },
    '刺刀',
    '折叠刀',
    '穿肠刀',
    '猎杀者匕首',
    '弯刀',
    '鲍伊猎刀',
    '暗影双匕',
    '折刀',
    '短剑',
    '熊刀',
    '锯齿爪刀',
    '海豹短刀',
    '求生匕首',
    '流浪者匕首',
    '骷髅匕首',
    '系绳匕首',
    '廓尔喀刀',
  ]),
  ...weapons('f:手套', [
    '运动手套',
    '驾驶手套',
    '裹手',
    '摩托手套',
    '专业手套',
    '血猎手套',
    '九头蛇手套',
    '狂牙手套',
  ]),
  ...weapons('f:步枪', [
    { label: 'AK-47', aliases: ['AK47'], keyword: 'AK' },
    'M4A4',
    { label: 'M4A1 消音版', aliases: ['M4A1 消音型'], keyword: 'M4A1' },
    'AUG',
    { label: 'SG 553', keyword: '553' },
    '法玛斯',
    { label: '加利尔 AR', keyword: '加利尔' },
  ]),
  ...weapons('f:狙击步枪', ['AWP', { label: 'SSG 08', keyword: 'SSG' }, 'SCAR-20', 'G3SG1']),
  ...weapons('f:手枪', [
    { label: '格洛克 18 型', keyword: '格洛克' },
    { label: 'USP 消音版', keyword: 'USP' },
    'P2000',
    'P250',
    'FN57',
    'Tec-9',
    { label: 'CZ75 自动手枪', keyword: 'CZ75' },
    '沙漠之鹰',
    { label: 'R8 左轮手枪', keyword: 'R8' },
    '双持贝瑞塔',
  ]),
  ...weapons('f:微型冲锋枪', ['MAC-10', 'MP9', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-野牛']),
  ...weapons('f:霰弹枪', ['新星', 'XM1014', '截短霰弹枪', 'MAG-7']),
  ...weapons('f:机枪', ['M249', '内格夫']),
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((entry) => [entry.id, entry]));
export const GROUP_BY_ID = new Map(CATEGORY_GROUPS.map((g) => [g.id, g]));

/** 旧版本词典 id → 当前 id（方案里存过的旧 id 读取时换算）。 */
export const LEGACY_CATEGORY_IDS: Record<string, string> = {
  'w:M4A1 消音型': 'w:M4A1 消音版',
};

export function canonicalCategoryId(id: string): string {
  return LEGACY_CATEGORY_IDS[id] ?? id;
}

/** 条件分类的显示名：大类显示「任意手套」，子类显示子类名。 */
export function categoryDisplay(id: string): string {
  const entry = CATEGORY_BY_ID.get(canonicalCategoryId(id));
  if (!entry) return id.slice(2);
  return entry.kind === 'first' ? `任意${entry.label}` : entry.label;
}

/** 皮肤输入联想用的常见皮肤名称。 */
export const SKIN_SUGGESTIONS = [
  '多普勒',
  '伽玛多普勒',
  '渐变大理石',
  '渐变之色',
  '致命紫罗兰',
  '虎牙',
  '传说',
  '自动化',
  '深红之网',
  '屠夫',
  '表面淬火',
  '枯焦之色',
  '蓝钢',
  '森林 DDPAT',
  '狩猎网格',
  '都市伪装',
  '噩梦之夜',
  '潘多拉之盒',
  '深红和服',
  '翠绿之网',
  '红宝石',
  '蓝宝石',
  '黑珍珠',
  '绿宝石',
  '火神',
  '二西莫夫',
  '野荷',
  '皇后',
  '龙王',
  '暴怒野兽',
];
