// Electron 主进程：单实例、安全窗口、白名单 IPC、托盘、协议激活与生命周期（技术选型 §3、§6，业务流程 §1）。
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  session,
  shell,
  Tray,
} from 'electron';
import type { MainEvent } from '../shared/dto';
import { IPC_CHANNELS, type IpcChannel, type IpcResult, ipcInputs } from '../shared/ipc';
import { createProcessReader, locateReader } from './auth/reader-process';
import { AppController, describeError, HELP_URL, RELEASES_URL, REPO_URL } from './controller';
import { findActivationArg, URI_SCHEME } from './domain/activation';
import {
  APP_ORIGIN,
  applySessionCsp,
  electronImageFetch,
  registerAppProtocol,
  registerImageProtocol,
  registerPrivilegedSchemes,
} from './electron/protocols';
import {
  ElectronNotifier,
  electronTransport,
  focusWindow,
  iconImage,
  loadPaymentImage,
  trayImage,
} from './electron/shell';
import { createElectronUpdater } from './electron/updater';
import { FileLogger } from './logger';
import { resolvePaths } from './paths';
import { ImageCache } from './services/image-cache';
import type { UpdaterDriver } from './services/update-service';
import { type DbClient, DbError, WorkerDbClient } from './storage/client';

export const APP_ID = 'io.github.camarillog.jewelryhelper';
export const TOAST_CLSID = '{3D5F7673-DF85-49BB-BDE9-563EA5F5BEBD}';
const ALLOWED_EXTERNAL = [RELEASES_URL, REPO_URL, HELP_URL];

const paths = resolvePaths();
app.setPath('userData', paths.electronDir);
app.setAppUserModelId(APP_ID);
app.setToastActivatorCLSID(TOAST_CLSID);
registerPrivilegedSchemes();

const devUrl = !app.isPackaged ? (process.env.ELECTRON_RENDERER_URL ?? null) : null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: AppController | null = null;
let dbClient: DbClient | null = null;
let quitting = false;
let quitInProgress = false;
const earlyActivations: string[] = [];

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusWindow(mainWindow);
    const url = findActivationArg(argv);
    if (url) dispatchActivation(url);
  });
  app
    .whenReady()
    .then(boot)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        '饰品驿站助手启动失败',
        error instanceof Error ? error.message : String(error),
      );
      app.exit(1);
    });
  app.on('window-all-closed', () => {
    // 托盘常驻：关闭窗口不退出
  });
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      requestQuit();
    }
  });
}

function dispatchActivation(url: string) {
  if (controller) void controller.handleActivation(url);
  else earlyActivations.push(url);
}

const rejectingDb: DbClient = {
  call: () => Promise.reject(new DbError('DbUnavailable', 'DB_UNAVAILABLE')),
  close: async () => {},
};

async function boot() {
  const logger = new FileLogger(paths.logDir);
  logger.info('app.start', { kind: app.isPackaged ? 'packaged' : 'dev' });
  hardenSession();
  if (!devUrl) registerAppProtocol(path.join(__dirname, '../renderer'));
  applySessionCsp(devUrl);
  const images = new ImageCache(paths.imageCacheDir, electronImageFetch);
  registerImageProtocol(images);

  let db: DbClient = rejectingDb;
  let dbError: string | null = null;
  // Worker 脚本从 app.asar.unpacked 加载（asar 内的脚本不能直接作为 Worker 入口）
  const workerFile = path
    .join(__dirname, 'dbWorker.js')
    .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const worker = new WorkerDbClient(workerFile, paths.dbFile, paths.backupDir);
  try {
    await worker.ready;
    db = worker;
    dbClient = worker;
  } catch (error) {
    dbError =
      error instanceof Error
        ? `本地数据库不可用：${error.message}。已阻止写入，数据未被清空。`
        : '本地数据库不可用';
    logger.error('db.open', { reason: error instanceof Error ? error.name : 'ERROR' });
  }

  if (app.isPackaged) ensureRegistration();
  const updater: UpdaterDriver | null = app.isPackaged ? createElectronUpdater() : null;

  controller = new AppController({
    db,
    dbError,
    logger,
    transport: electronTransport,
    reader: createProcessReader(
      locateReader({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appRoot: app.getAppPath(),
      }),
    ),
    notifier: new ElectronNotifier(),
    images,
    loadPaymentImage,
    appVersion: app.getVersion(),
    updater,
    readLogs: async () => readRecentLogs(paths.logDir),
    shell: {
      openExternal: async (url) => {
        if (ALLOWED_EXTERNAL.includes(url)) await shell.openExternal(url);
      },
      chooseDirectory: async (current) => {
        const result = await dialog.showOpenDialog(mainWindow as BrowserWindow, {
          title: '选择 5E 客户端 Local Storage\\leveldb 目录',
          defaultPath: fs.existsSync(current) ? current : undefined,
          properties: ['openDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      saveDiagnostics: async (name, content) => {
        const result = await dialog.showSaveDialog(mainWindow as BrowserWindow, {
          title: '导出诊断信息',
          defaultPath: name,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) return null;
        await fs.promises.writeFile(result.filePath, content, 'utf8');
        return result.filePath;
      },
      confirmQuit: () => void doQuit(),
      installUpdate: () => void doQuit(() => updater?.quitAndInstall()),
      showWindow: () => focusWindow(mainWindow),
    },
  });
  controller.subscribe(forwardEvent);
  registerIpc(controller);
  createWindow();
  createTray();
  powerMonitor.on('resume', () => controller?.resumeFromSleep());

  const initial = findActivationArg(process.argv);
  if (initial) earlyActivations.push(initial);
  await controller.start();
  for (const url of earlyActivations.splice(0)) await controller.handleActivation(url);
}

function hardenSession() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isTrustedUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function isTrustedUrl(url: string) {
  if (devUrl) return url.startsWith(new URL(devUrl).origin);
  return url.startsWith(`${APP_ORIGIN}/`);
}

/** 确保 URI 协议和开始菜单身份指向当前安装（覆盖升级后重新确认）。 */
function ensureRegistration() {
  try {
    app.setAsDefaultProtocolClient(URI_SCHEME);
    const link = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      '饰品驿站助手.lnk',
    );
    const options = {
      target: process.execPath,
      description: '饰品驿站助手',
      appUserModelId: APP_ID,
      toastActivatorClsid: TOAST_CLSID,
    };
    shell.writeShortcutLink(link, fs.existsSync(link) ? 'update' : 'create', options);
  } catch {
    // 注册失败时保留应用内提醒
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    title: '饰品驿站助手',
    backgroundColor: '#ffffff',
    icon: iconImage(256),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (quitting) return;
    const behavior = controller?.deviceSettings().closeBehavior ?? 'TRAY';
    event.preventDefault();
    if (behavior === 'QUIT') {
      requestQuit();
      return;
    }
    mainWindow?.hide();
    if (controller && !controller.deviceSettings().closeHintShown) {
      if (tray && !tray.isDestroyed()) {
        tray.displayBalloon({
          title: '饰品驿站助手',
          content: '已最小化到托盘，监测仍在运行',
          iconType: 'info',
        });
      }
      void controller.handle('app.firstCloseHintShown', undefined);
    }
  });
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

let lastTray = '';
function updateTray() {
  if (quitting || quitInProgress || !tray || tray.isDestroyed() || !controller) return;
  const status = controller.status();
  const m = status.monitor;
  const tone =
    status.auth.phase !== 'OK' || m.lastRoundError ? 'alert' : m.paused ? 'paused' : 'normal';
  const key = `${tone}:${m.badge}:${m.available}/${m.monitored}:${m.paused}`;
  if (key === lastTray) return;
  lastTray = key;
  tray.setImage(trayImage({ tone, badge: m.badge }));
  tray.setToolTip(
    m.paused
      ? '饰品驿站助手 · 监测已暂停'
      : `饰品驿站助手 · 监测中 ${m.available}/${m.monitored} 可租`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => focusWindow(mainWindow) },
      {
        label: m.enabled ? '暂停监测' : '恢复监测',
        enabled: status.auth.phase === 'OK',
        click: () => void controller?.handle('monitor.setEnabled', { enabled: !m.enabled }),
      },
      { type: 'separator' },
      { label: '退出', click: () => requestQuit() },
    ]),
  );
}

function createTray() {
  tray = new Tray(trayImage({ tone: 'paused', badge: 0 }));
  tray.setToolTip('饰品驿站助手');
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else focusWindow(mainWindow);
  });
  updateTray();
}

function forwardEvent(event: MainEvent) {
  if (quitting || quitInProgress) return;
  if (event.type === 'status') updateTray();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed())
    mainWindow.webContents.send(`event:${event.type}`, event.payload);
}

function registerIpc(ctrl: AppController) {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcResult<unknown>> => {
      // 校验来源窗口与帧
      if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
        return { ok: false, error: { code: 'IPC_SENDER_REJECTED', message: '拒绝的调用来源' } };
      }
      const frameUrl = event.senderFrame?.url ?? '';
      if (!isTrustedUrl(frameUrl)) {
        return { ok: false, error: { code: 'IPC_SENDER_REJECTED', message: '拒绝的调用来源' } };
      }
      const schema = ipcInputs[channel as IpcChannel];
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: { code: 'IPC_INVALID_INPUT', message: '参数不合法' } };
      }
      try {
        const value = await ctrl.handle(channel, parsed.data as never);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    });
  }
}

function requestQuit() {
  if (quitInProgress) return;
  if (controller?.checkout.busy()) {
    focusWindow(mainWindow);
    forwardEvent({ type: 'confirmQuit', payload: { hasAttempt: true } });
    return;
  }
  void doQuit();
}

async function doQuit(afterShutdown?: () => void) {
  if (quitInProgress) return;
  quitInProgress = true;
  try {
    await controller?.shutdown();
  } catch {
    // 退出时尽力保存
  }
  try {
    await dbClient?.close();
  } catch {
    // 忽略
  }
  quitting = true;
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
  if (afterShutdown) {
    afterShutdown();
    // 服务已停止；安装器启动失败时不留下没有窗口的进程
    setTimeout(() => app.exit(0), 8000);
    return;
  }
  app.quit();
}

async function readRecentLogs(dir: string): Promise<string> {
  try {
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.log')).sort();
    const last = files.slice(-2);
    const parts = await Promise.all(
      last.map((f) => fs.promises.readFile(path.join(dir, f), 'utf8')),
    );
    return parts.join('');
  } catch {
    return '';
  }
}
