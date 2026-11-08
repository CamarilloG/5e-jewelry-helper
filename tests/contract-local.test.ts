// 本机契约回归：若存在被 Git 忽略的 .validation/api 真实响应，验证 schema 能完整解析（只断言结构，不输出内容）。
// CI 与其他机器上没有该目录时自动跳过。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authInfoSchema,
  channelDataSchema,
  couponDataSchema,
  createDataSchema,
  durationSchema,
  envelopeSchema,
  favoritesDataSchema,
  globalConfigSchema,
  inventoryDataSchema,
  normalizeAccount,
  orderDetailsSchema,
  orderListSchema,
  payStatusSchema,
  rawAccountSchema,
  searchDataSchema,
} from '../src/main/platform/schemas';

const dir = path.resolve(__dirname, '../.validation/api');
const has = fs.existsSync(dir);
const load = (name: string) =>
  envelopeSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))).data;

describe.skipIf(!has)('本机真实响应契约（.validation，Git 忽略）', () => {
  const cases: [string, { safeParse(v: unknown): { success: boolean } }][] = [
    ['account-info.json', rawAccountSchema],
    ['auth-info.json', authInfoSchema],
    ['config.json', globalConfigSchema],
    ['channels.json', channelDataSchema],
    ['checkout-create.json', createDataSchema],
    ['checkout-duration.json', durationSchema],
    ['checkout-status.json', payStatusSchema],
    ['coupons.json', couponDataSchema],
    ['contract-search.json', searchDataSchema],
    ['inventory.json', inventoryDataSchema],
    ['favorites-all.json', favoritesDataSchema],
    ['orders.json', orderListSchema],
    ['paid-order-details.json', orderDetailsSchema],
  ];
  for (const [file, schema] of cases) {
    it(`${file} 符合契约`, () => {
      if (!fs.existsSync(path.join(dir, file))) return;
      expect(schema.safeParse(load(file)).success).toBe(true);
    });
  }
  it('收藏列表条目带状态字段，可判定状态', () => {
    const data = favoritesDataSchema.parse(load('favorites-all.json'));
    for (const raw of data.list) expect(normalizeAccount(raw).statusKnown).toBe(true);
  });
});
