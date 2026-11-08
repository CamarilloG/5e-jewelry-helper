// 随包发布的版本化饰品分类词典（接口与数据规范 §3、§8 R6、§10 R10）。
// 三层：大类（按平台 firstType 精确归一化比较）→ 子类（按市场名称武器前缀精确归一化比较，含别名）
// → 皮肤（名称包含匹配，自由输入 + 常见联想，不在本词典内）。
// 每个子类保存平台关键词与三类独立实测证据（queryable / precision / coverage）。

export const CATALOG_VERSION = '2026.11.08-2';

export type KeywordQueryableEvidence = 'verified' | 'zero_result' | 'unverified';
export type KeywordPrecisionEvidence = 'verified' | 'wide_match' | 'unverified';
export type KeywordCoverageEvidence = 'verified' | 'partial' | 'unverified';

export interface KeywordEvidence {
  queryable: KeywordQueryableEvidence;
  precision: KeywordPrecisionEvidence;
  coverage: KeywordCoverageEvidence;
  verifiedAt: string | null;
  ruleVersion: string;
  sampleScope: string;
  referenceFile: string;
  fallbackAliases?: readonly string[];
}

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
  /** 大类展开关键词并集（如 `f:手套` = `['手套', '裹手']`） */
  expandedKeywords?: readonly string[];
  /** 关键词三类独立实测证据（A1 / R02） */
  evidence: KeywordEvidence;
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

const REF_DOC = 'docs/验证记录.md#搜索关键词语义实测';

const verifiedFull = (
  sampleScope: string,
  fallbackAliases?: readonly string[],
): KeywordEvidence => ({
  queryable: 'verified',
  precision: 'verified',
  coverage: 'verified',
  verifiedAt: '2026-11-08',
  ruleVersion: CATALOG_VERSION,
  sampleScope,
  referenceFile: REF_DOC,
  ...(fallbackAliases ? { fallbackAliases } : {}),
});

const verifiedPartial = (
  sampleScope: string,
  opts: {
    precision?: KeywordPrecisionEvidence;
    coverage?: KeywordCoverageEvidence;
    fallbackAliases?: readonly string[];
  } = {},
): KeywordEvidence => ({
  queryable: 'verified',
  precision: opts.precision ?? 'unverified',
  coverage: opts.coverage ?? 'unverified',
  verifiedAt: '2026-11-08',
  ruleVersion: CATALOG_VERSION,
  sampleScope,
  referenceFile: REF_DOC,
  ...(opts.fallbackAliases ? { fallbackAliases: opts.fallbackAliases } : {}),
});

const unverifiedEvidence = (fallbackAliases?: readonly string[]): KeywordEvidence => ({
  queryable: 'unverified',
  precision: 'unverified',
  coverage: 'unverified',
  verifiedAt: null,
  ruleVersion: CATALOG_VERSION,
  sampleScope: 'not_probed',
  referenceFile: REF_DOC,
  ...(fallbackAliases ? { fallbackAliases } : {}),
});

type WeaponSpec =
  | string
  | {
      label: string;
      aliases?: string[];
      keyword?: string;
      evidence?: KeywordEvidence;
    };

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
      evidence: s.evidence ?? unverifiedEvidence(),
    };
  });

export const CATEGORIES: CategoryEntry[] = [
  ...CATEGORY_GROUPS.map((g): CategoryEntry => {
    if (g.id === 'f:手套') {
      return {
        id: g.id,
        label: g.label,
        groupId: g.id,
        kind: 'first',
        names: [],
        keyword: null,
        expandedKeywords: ['手套', '裹手'],
        evidence: verifiedFull('search(手套=1180,裹手=244)+7_subtypes_union+inv_sample=6/6', [
          '运动手套',
          '驾驶手套',
          '裹手',
          '摩托手套',
          '专业手套',
          '血猎手套',
          '九头蛇手套',
          '狂牙手套',
        ]),
      };
    }
    return {
      id: g.id,
      label: g.label,
      groupId: g.id,
      kind: 'first',
      names: [],
      keyword: null,
      evidence: unverifiedEvidence(),
    };
  }),
  ...weapons('f:匕首', [
    { label: '爪子刀', evidence: verifiedFull('search_total=331,inv_sample=3/3') },
    { label: '蝴蝶刀', evidence: verifiedFull('search_total=505,inv_sample=7/7') },
    {
      label: 'M9 刺刀',
      keyword: 'M9',
      evidence: verifiedFull('search_total=333(M9刺刀=334),inv_sample=3/3', ['M9刺刀']),
    },
    {
      label: '刺刀',
      evidence: verifiedPartial('search_total=533,wide_matches_M9刺刀', {
        precision: 'wide_match',
        coverage: 'verified',
      }),
    },
    { label: '折叠刀', evidence: verifiedPartial('search_total=315,display_prefix=32/100') },
    '穿肠刀',
    { label: '猎杀者匕首', evidence: verifiedPartial('search_total=194,display_prefix=41/100') },
    { label: '弯刀', evidence: verifiedPartial('search_total=298,display_prefix=34/100') },
    '鲍伊猎刀',
    '暗影双匕',
    '折刀',
    { label: '短剑', evidence: verifiedPartial('search_total=163,display_prefix=85/100') },
    { label: '熊刀', evidence: verifiedPartial('search_total=169,display_prefix=71/100') },
    { label: '锯齿爪刀', evidence: verifiedFull('search_total=153,inv_sample=3/3,recall=3/3') },
    { label: '海豹短刀', evidence: verifiedPartial('search_total=65,display_prefix=48/65') },
    '求生匕首',
    { label: '流浪者匕首', evidence: verifiedPartial('search_total=117,display_prefix=77/100') },
    { label: '骷髅匕首', evidence: verifiedPartial('search_total=84,display_prefix=77/84') },
    '系绳匕首',
    { label: '廓尔喀刀', evidence: verifiedPartial('search_total=34,display_prefix=23/34') },
  ]),
  ...weapons('f:手套', [
    { label: '运动手套', evidence: verifiedFull('search_total=243,inv_sample_verified') },
    { label: '驾驶手套', evidence: verifiedFull('search_total=242,inv_sample_verified') },
    { label: '裹手', evidence: verifiedFull('search_total=244,inv_sample=3/3') },
    { label: '摩托手套', evidence: verifiedFull('search_total=265,inv_sample_verified') },
    { label: '专业手套', evidence: verifiedFull('search_total=231,inv_sample_verified') },
    { label: '血猎手套', evidence: verifiedFull('search_total=51,inv_sample_verified') },
    { label: '九头蛇手套', evidence: verifiedFull('search_total=152,inv_sample_verified') },
    { label: '狂牙手套', evidence: verifiedFull('search_total=75,inv_sample_verified') },
  ]),
  ...weapons('f:步枪', [
    {
      label: 'AK-47',
      aliases: ['AK47'],
      keyword: 'AK',
      evidence: verifiedFull('search_total=1827(AK-47=1862),inv_sample=3/3', ['AK-47']),
    },
    { label: 'M4A4', evidence: verifiedPartial('search_total=1266,display_prefix=55/100') },
    {
      label: 'M4A1 消音版',
      aliases: ['M4A1 消音型'],
      keyword: 'M4A1',
      evidence: verifiedFull('search_total=210(M4A1消音版=0),inv_sample=3/3'),
    },
    { label: 'AUG', evidence: verifiedPartial('search_total=727,display_prefix=6/100') },
    {
      label: 'SG 553',
      keyword: '553',
      evidence: verifiedPartial('search_total=643(SG553=654)', { fallbackAliases: ['SG553'] }),
    },
    { label: '法玛斯', evidence: verifiedPartial('search_total=685') },
    {
      label: '加利尔 AR',
      keyword: '加利尔AR',
      evidence: verifiedPartial(
        'search_total=28(加利尔=0),inv_sample=3/3_precision,partial_recall=3/13',
        {
          precision: 'verified',
          coverage: 'partial',
        },
      ),
    },
  ]),
  ...weapons('f:狙击步枪', [
    { label: 'AWP', evidence: verifiedPartial('search_total=1759,display_prefix=84/100') },
    {
      label: 'SSG 08',
      keyword: 'SSG',
      evidence: verifiedPartial('search_total=779(SSG08=779)', { fallbackAliases: ['SSG08'] }),
    },
    'SCAR-20',
    'G3SG1',
  ]),
  ...weapons('f:手枪', [
    {
      label: '格洛克 18 型',
      keyword: '格洛克18型',
      evidence: verifiedFull('search_total=144(格洛克=0,格洛克 18 型=0),inv_sample=3/3'),
    },
    {
      label: 'USP 消音版',
      keyword: 'USP',
      evidence: verifiedFull('search_total=193(USP消音版=193),inv_sample=3/3', ['USP消音版']),
    },
    'P2000',
    'P250',
    'FN57',
    'Tec-9',
    {
      label: 'CZ75 自动手枪',
      keyword: 'CZ75',
      evidence: verifiedPartial('search_total=11(CZ75自动手枪=0)'),
    },
    { label: '沙漠之鹰', evidence: verifiedPartial('search_total=1393,display_prefix=18/100') },
    {
      label: 'R8 左轮手枪',
      keyword: 'R8',
      evidence: verifiedPartial('search_total=10(R8左轮手枪=10)', {
        fallbackAliases: ['R8左轮手枪'],
      }),
    },
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

const BY_NAME_OR_LABEL = new Map<string, string>();
for (const g of CATEGORY_GROUPS) {
  BY_NAME_OR_LABEL.set(g.firstType, g.id);
  BY_NAME_OR_LABEL.set(g.label, g.id);
}
for (const entry of CATEGORIES) {
  BY_NAME_OR_LABEL.set(entry.label, entry.id);
  BY_NAME_OR_LABEL.set(entry.label.replace(/\s+/g, ''), entry.id);
  for (const n of entry.names) {
    BY_NAME_OR_LABEL.set(n, entry.id);
    BY_NAME_OR_LABEL.set(n.replace(/\s+/g, ''), entry.id);
  }
}

export function canonicalCategoryId(id: string): string {
  return LEGACY_CATEGORY_IDS[id] ?? id;
}

export function normalizeCategoryCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const canonical = canonicalCategoryId(trimmed);
  if (CATEGORY_BY_ID.has(canonical)) return canonical;
  return BY_NAME_OR_LABEL.get(trimmed) ?? BY_NAME_OR_LABEL.get(trimmed.replace(/\s+/g, '')) ?? null;
}

export function getCategoryDef(idOrRaw: string): CategoryEntry | null {
  const code = normalizeCategoryCode(idOrRaw);
  return code ? (CATEGORY_BY_ID.get(code) ?? null) : null;
}

/** 条件分类的显示名：大类显示「任意手套」，子类显示子类名。 */
export function categoryDisplay(id: string): string {
  const entry = CATEGORY_BY_ID.get(canonicalCategoryId(id));
  if (!entry) return id.slice(2);
  return entry.kind === 'first' ? `任意${entry.label}` : entry.label;
}

// 运行时降级集合（A3：若后续打开详情或补读库存发现某认证关键词误命中，降级为未认证）
const downgradedIds = new Set<string>();
const downgradedKeywords = new Set<string>();

export function downgradeCategoryEvidence(idOrKeyword: string): void {
  const canonical = canonicalCategoryId(idOrKeyword);
  if (CATEGORY_BY_ID.has(canonical)) {
    downgradedIds.add(canonical);
    const entry = CATEGORY_BY_ID.get(canonical);
    if (entry?.keyword) downgradedKeywords.add(entry.keyword);
    for (const kw of entry?.expandedKeywords ?? []) downgradedKeywords.add(kw);
  } else {
    downgradedKeywords.add(idOrKeyword);
    for (const entry of CATEGORIES) {
      if (entry.keyword === idOrKeyword || entry.expandedKeywords?.includes(idOrKeyword)) {
        downgradedIds.add(entry.id);
      }
    }
  }
}

export function resetDowngradedEvidence(): void {
  downgradedIds.clear();
  downgradedKeywords.clear();
}

export function isCategoryDowngraded(id: string): boolean {
  const entry = CATEGORY_BY_ID.get(canonicalCategoryId(id));
  if (!entry) return true;
  if (downgradedIds.has(entry.id)) return true;
  if (entry.keyword && downgradedKeywords.has(entry.keyword)) return true;
  if (entry.expandedKeywords?.some((kw) => downgradedKeywords.has(kw))) return true;
  return false;
}

export function getCategoryEvidence(id: string): KeywordEvidence | null {
  const entry = CATEGORY_BY_ID.get(canonicalCategoryId(id));
  if (!entry) return null;
  if (isCategoryDowngraded(entry.id)) {
    return {
      ...entry.evidence,
      precision: 'unverified',
      coverage: 'unverified',
    };
  }
  return entry.evidence;
}

export function categorySupportsFastPath(id: string): boolean {
  const ev = getCategoryEvidence(id);
  if (!ev) return false;
  return ev.queryable === 'verified' && ev.precision === 'verified' && ev.coverage === 'verified';
}

export function categorySupportsCoverage(id: string): boolean {
  const ev = getCategoryEvidence(id);
  if (!ev) return false;
  return ev.queryable === 'verified' && ev.coverage === 'verified';
}

export function expandGroupCategoryIds(groupId: string): string[] {
  const canonical = canonicalCategoryId(groupId);
  const entry = CATEGORY_BY_ID.get(canonical);
  if (!entry) return [];
  if (entry.kind === 'weapon') return [entry.id];
  return CATEGORIES.filter((c) => c.kind === 'weapon' && c.groupId === entry.id).map((c) => c.id);
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
