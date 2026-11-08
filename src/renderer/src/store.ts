// 界面状态：导航、表单、视图，以及主进程状态的投影（不含业务规则）。
import { create } from 'zustand';
import type {
  CheckoutView,
  FavoritesView,
  FilterConditions,
  ScanView,
  SettingsView,
  StatusView,
} from '../../shared/dto';

export type Page = 'FILTER' | 'FAVORITES' | 'PRESETS' | 'SETTINGS';

export interface ConditionRow {
  id: number;
  /** 大类 / 子类 id，多选取任一 */
  categoryIds: string[];
  /** 皮肤名称，多选取任一 */
  names: string[];
}

export interface FilterForm {
  rows: ConditionRow[];
  rentKind: FilterConditions['rentKind'];
  priceMin: string;
  priceMax: string;
  couponOnly: boolean;
  /** 当前条件来自哪个方案；修改后显示“（已修改）” */
  presetId: string | null;
  presetName: string | null;
  presetSnapshot: string | null;
}

export interface DrawerState {
  accountNo: string;
  /** 从 P1 带条件进入时的命中饰品 key */
  hitKeys: string[] | null;
  focusInventory: boolean;
}

let rowSeq = 1;
export const newRow = (categoryIds: string[] = [], names: string[] = []): ConditionRow => ({
  id: rowSeq++,
  categoryIds,
  names,
});

export const emptyForm = (): FilterForm => ({
  rows: [newRow()],
  rentKind: 'HOUR',
  priceMin: '',
  priceMax: '',
  couponOnly: false,
  presetId: null,
  presetName: null,
  presetSnapshot: null,
});

export function formToConditions(form: FilterForm): FilterConditions {
  return {
    items: form.rows
      .map((r) => ({
        categoryIds: [...r.categoryIds],
        names: r.names.map((n) => n.trim()).filter(Boolean),
      }))
      .filter((r) => r.categoryIds.length > 0 || r.names.length > 0),
    rentKind: form.rentKind,
    priceMin: form.priceMin.trim() || null,
    priceMax: form.priceMax.trim() || null,
    couponOnly: form.couponOnly,
  };
}

export function conditionsToForm(
  c: FilterConditions,
  preset: { id: string; name: string } | null,
): FilterForm {
  const rows =
    c.items.length > 0 ? c.items.map((i) => newRow([...i.categoryIds], [...i.names])) : [newRow()];
  return {
    rows,
    rentKind: c.rentKind,
    priceMin: c.priceMin ?? '',
    priceMax: c.priceMax ?? '',
    couponOnly: c.couponOnly,
    presetId: preset?.id ?? null,
    presetName: preset?.name ?? null,
    presetSnapshot: preset ? JSON.stringify(c) : null,
  };
}

interface UiState {
  page: Page;
  status: StatusView | null;
  scan: ScanView | null;
  favorites: FavoritesView | null;
  checkout: CheckoutView | null;
  checkoutOpen: boolean;
  settings: SettingsView | null;
  form: FilterForm;
  drawer: DrawerState | null;
  favoriteFocus: string | null;
  favoriteFilter: 'ALL' | 'AVAILABLE' | 'RENTED' | 'OFF_SHELF' | 'UNKNOWN';
  presetEditor: { accountNo: string; continueCheckout: boolean } | null;
  settingsSection: string | null;
  presetsVersion: number;
  setPage(page: Page): void;
  set(partial: Partial<UiState>): void;
  setForm(update: (form: FilterForm) => FilterForm): void;
}

export const useUi = create<UiState>((set) => ({
  page: 'FILTER',
  status: null,
  scan: null,
  favorites: null,
  checkout: null,
  checkoutOpen: false,
  settings: null,
  form: emptyForm(),
  drawer: null,
  favoriteFocus: null,
  favoriteFilter: 'ALL',
  presetEditor: null,
  settingsSection: null,
  presetsVersion: 0,
  // 切换导航时保留 P1 条件与结果，关闭详情抽屉
  setPage: (page) => set({ page, drawer: null }),
  set: (partial) => set(partial),
  setForm: (update) => set((s) => ({ form: update(s.form) })),
}));
