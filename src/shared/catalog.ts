// 随包发布的版本化分类词典（接口与数据规范 §3）。
// first：按平台 firstType 精确归一化比较；weapon：按市场名称的武器前缀精确归一化比较。
// keyword：平台单关键词搜索使用的中文词，必须是该类所有饰品名称都包含的子串；无法保证时为 null，
// 此时该行不提供候选，由其他行或租期浏览提供候选（见业务流程 §3）。

export const CATALOG_VERSION = '2026.11.07-1';

export interface CategoryEntry {
  id: string;
  label: string;
  group: string;
  kind: 'first' | 'weapon';
  keyword: string | null;
}

const weapon = (group: string, labels: string[]): CategoryEntry[] =>
  labels.map((label) => ({ id: `w:${label}`, label, group, kind: 'weapon', keyword: label }));

const first = (label: string): CategoryEntry => ({
  id: `f:${label}`,
  label,
  group: '大类',
  kind: 'first',
  keyword: null,
});

export const CATEGORIES: CategoryEntry[] = [
  first('匕首'),
  first('手套'),
  first('步枪'),
  first('手枪'),
  first('微型冲锋枪'),
  first('霰弹枪'),
  first('机枪'),
  ...weapon('刀具', [
    '爪子刀',
    '蝴蝶刀',
    'M9 刺刀',
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
  ...weapon('手套', [
    '运动手套',
    '驾驶手套',
    '裹手',
    '摩托手套',
    '专业手套',
    '血猎手套',
    '九头蛇手套',
    '狂牙手套',
  ]),
  ...weapon('步枪', ['AK-47', 'M4A4', 'M4A1 消音型', 'AUG', 'SG 553', '法玛斯', '加利尔 AR']),
  ...weapon('狙击', ['AWP', 'SSG 08', 'SCAR-20', 'G3SG1']),
  ...weapon('手枪', [
    '格洛克 18 型',
    'USP 消音版',
    'P2000',
    'P250',
    'FN57',
    'Tec-9',
    'CZ75 自动手枪',
    '沙漠之鹰',
    'R8 左轮手枪',
    '双持贝瑞塔',
  ]),
  ...weapon('微冲', ['MAC-10', 'MP9', 'MP7', 'MP5-SD', 'UMP-45', 'P90', 'PP-野牛']),
  ...weapon('霰弹/机枪', ['新星', 'XM1014', '截短霰弹枪', 'MAG-7', 'M249', '内格夫']),
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((entry) => [entry.id, entry]));

/** 名称输入联想用的常见皮肤名称。 */
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
