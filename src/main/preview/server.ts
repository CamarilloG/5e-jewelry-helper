// 离线预览服务器（仅开发/验收用，不进入安装包）：在 Node 中运行真实主进程业务服务 + 虚拟平台，
// 通过 127.0.0.1 上的 HTTP 桥提供与 preload 相同的白名单方法，便于用浏览器做界面交互验收。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { MainEvent } from '../../shared/dto';
import { IPC_CHANNELS, type IpcChannel, ipcInputs } from '../../shared/ipc';
import { AppController, describeError } from '../controller';
import { nullLogger } from '../logger';
import type { UpdaterDriver } from '../services/update-service';
import { InlineDbClient } from '../storage/client';
import { FakePlatform } from './fake-platform';

const port = Number(process.env.PORT ?? 5178);
const rendererDir = path.resolve(__dirname, '../renderer');
const tmp = path.join(os.tmpdir(), 'jewelry-helper-preview');
fs.mkdirSync(tmp, { recursive: true });
const dbFile = process.env.PREVIEW_DB ?? ':memory:';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function main() {
  const fake = new FakePlatform();
  fake.favorites = [
    fake.accounts[0]?.accountNo,
    fake.accounts[3]?.accountNo,
    fake.accounts[5]?.accountNo,
  ].filter((x): x is string => !!x);
  fake.coupons = [
    {
      id: '501',
      couponType: 1,
      discountType: 2,
      discountValue: '100',
      thresholdAmount: 0,
      status: 1,
      validStartAt: String(Math.floor(Date.now() / 1000) - 3600),
      validEndAt: String(Math.floor(Date.now() / 1000) + 86_400),
    },
  ];
  const notifications: string[] = [];
  const updateDemo = { mode: 'latest' };
  const updater: UpdaterDriver = {
    check: async () => {
      if (updateDemo.mode === 'check-fail') throw new Error('net::ERR_INTERNET_DISCONNECTED');
      return updateDemo.mode === 'latest'
        ? null
        : { version: '9.9.9', notes: '预览用更新说明\n第二行内容' };
    },
    download: async (progress) => {
      for (const percent of [15, 40, 70, 100]) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (updateDemo.mode === 'download-fail' && percent > 40) {
          throw Object.assign(new Error('checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' });
        }
        progress(percent);
      }
    },
    quitAndInstall: () => {},
  };
  const db = await InlineDbClient.open(dbFile);
  const clients = new Set<http.ServerResponse>();
  const controller = new AppController({
    db,
    dbError: null,
    logger: nullLogger,
    transport: fake,
    reader: async () => ({ state: 'READ', credential: fake.validToken }),
    notifier: {
      supported: () => true,
      show: (spec) => {
        notifications.push(spec.xml);
        return true;
      },
    },
    images: null,
    loadPaymentImage: async (url) => url,
    appVersion: '1.0.0-preview',
    updater,
    shell: {
      openExternal: async () => {},
      chooseDirectory: async () => null,
      saveDiagnostics: async (name, content) => {
        const file = path.join(tmp, name);
        fs.writeFileSync(file, content, 'utf8');
        return file;
      },
      confirmQuit: () => {},
      installUpdate: () => notifications.push('update-install-requested'),
      showWindow: () => {},
    },
  });
  controller.subscribe((event: MainEvent) => {
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const res of clients) res.write(data);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/ipc/')) {
      const channel = decodeURIComponent(url.pathname.slice(5)) as IpcChannel;
      const body = await readBody(req);
      if (!IPC_CHANNELS.includes(channel))
        return json(res, { ok: false, error: { code: 'IPC_CHANNEL_REJECTED', message: '' } });
      const parsed = ipcInputs[channel].safeParse(body.length ? JSON.parse(body).input : undefined);
      if (!parsed.success)
        return json(res, {
          ok: false,
          error: { code: 'IPC_INVALID_INPUT', message: '参数不合法' },
        });
      try {
        const value = await controller.handle(channel, parsed.data as never);
        return json(res, { ok: true, value: value ?? null });
      } catch (error) {
        return json(res, { ok: false, error: describeError(error) });
      }
    }
    if (url.pathname.startsWith('/dev/')) {
      const action = url.pathname.slice(5);
      const no = url.searchParams.get('account') ?? '';
      if (action === 'update') {
        updateDemo.mode = url.searchParams.get('mode') ?? 'latest';
        return json(res, updateDemo.mode);
      }
      if (action === 'pay') return json(res, fake.pay());
      if (action === 'expire') return json(res, fake.expire());
      if (action === 'available') {
        fake.setStatus(no, 0);
        return json(res, true);
      }
      if (action === 'rented') {
        fake.setStatus(no, 1);
        return json(res, true);
      }
      if (action === 'round') {
        await controller.monitor.runRound();
        return json(res, true);
      }
      if (action === 'activate') {
        await controller.handleActivation(url.searchParams.get('url') ?? '');
        return json(res, true);
      }
      if (action === 'notifications') return json(res, notifications);
      if (action === 'stats')
        return json(res, {
          creates: fake.createCount,
          unlocks: fake.unlockCount,
          requests: fake.requests.length,
        });
      if (action === 'expire-auth') {
        fake.validToken = 'rotated';
        return json(res, true);
      }
      if (action === 'restore-auth') {
        fake.validToken = 'fake-credential';
        return json(res, true);
      }
      return json(res, null);
    }
    if (url.pathname === '/jhimg/') {
      const target = url.searchParams.get('u') ?? '';
      const label = decodeURIComponent(target.split('/').pop() ?? '')
        .replace(/\.png$/, '')
        .slice(0, 12);
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><rect width="128" height="96" fill="#eef0fb"/><path d="M64 22 L88 48 L64 74 L40 48 Z" fill="#c7c9f5"/><text x="64" y="90" font-size="10" text-anchor="middle" fill="#4F46E5" font-family="sans-serif">${escapeText(label)}</text></svg>`,
      );
      return;
    }
    const file = path.resolve(
      rendererDir,
      `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`,
    );
    if (!file.startsWith(rendererDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`离线预览: http://127.0.0.1:${port}/  （虚拟数据，不连接真实平台）`);
  });
  await controller.start();
}

function escapeText(text: string) {
  return text.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string,
  );
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json(res: http.ServerResponse, value: unknown) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

void main();
