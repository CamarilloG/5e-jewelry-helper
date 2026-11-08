// 测试夹具：虚拟平台 + 内存数据库 + 虚拟登录态；不读取真实客户端、不连接真实平台。

import type { CredentialReader } from '../src/main/auth/reader-process';
import { AppController } from '../src/main/controller';
import { nullLogger } from '../src/main/logger';
import { FakePlatform, generateAccounts } from '../src/main/preview/fake-platform';
import { InlineDbClient } from '../src/main/storage/client';

export interface Harness {
  fake: FakePlatform;
  db: InlineDbClient;
  controller: AppController;
  toasts: string[];
  reader: { outcome: Awaited<ReturnType<CredentialReader>> };
  close(): Promise<void>;
}

export function fakeJwt(expSeconds: number): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: expSeconds, sub: 'virtual' })}.sig`;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout = 4000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeout) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function createHarness(
  opts: { accounts?: number; start?: boolean; db?: InlineDbClient; fake?: FakePlatform } = {},
): Promise<Harness> {
  const fake = opts.fake ?? new FakePlatform(generateAccounts(opts.accounts ?? 24));
  const db = opts.db ?? (await InlineDbClient.open(':memory:'));
  const toasts: string[] = [];
  const reader: Harness['reader'] = { outcome: { state: 'READ', credential: fake.validToken } };
  const controller = new AppController({
    db,
    dbError: null,
    logger: nullLogger,
    transport: fake,
    reader: async () => reader.outcome,
    notifier: {
      supported: () => true,
      show: (spec) => {
        toasts.push(spec.xml);
        return true;
      },
    },
    images: null,
    loadPaymentImage: async (url) => url,
    appVersion: 'test',
    shell: {
      openExternal: async () => {},
      chooseDirectory: async () => null,
      saveDiagnostics: async () => null,
      confirmQuit: () => {},
      showWindow: () => {},
    },
  });
  controller.queue.setLimit(1_000_000);
  if (opts.start !== false) {
    await controller.start();
    controller.queue.setLimit(1_000_000);
    controller.monitor.halt();
  }
  return {
    fake,
    db,
    controller,
    toasts,
    reader,
    close: async () => {
      controller.monitor.halt();
      controller.queue.pause('test-end');
    },
  };
}
