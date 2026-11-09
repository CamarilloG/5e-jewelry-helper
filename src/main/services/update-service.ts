// 在线更新：启动时自动检查、用户手动检查、手动下载、手动安装；出码进行中禁止安装。
// 只做版本与下载状态管理，不带平台凭证，也不占用平台请求额度。
import type { UpdateInstallResult, UpdateView } from '../../shared/dto';
import type { Logger } from '../logger';

export const STARTUP_CHECK_DELAY_MS = 10_000;

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

export interface UpdaterDriver {
  /** 有新版本时返回其信息，已是最新时返回 null */
  check(): Promise<UpdateInfo | null>;
  download(onProgress: (percent: number) => void): Promise<void>;
  quitAndInstall(): void;
}

export interface UpdateServiceDeps {
  driver: UpdaterDriver | null;
  currentVersion: string;
  isBusy: () => boolean;
  requestInstall: () => void;
  onChange: (view: UpdateView) => void;
  logger: Logger;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'ERROR';
}

/** 把更新器的英文错误转成用户能看懂的提示；原始信息可能含地址，不展示也不写日志。 */
export function updateErrorMessage(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : '';
  if (code === 'ERR_CHECKSUM_MISMATCH' || /checksum mismatch/i.test(message)) {
    return '更新包校验失败，已拒绝安装，请重新下载';
  }
  if (
    code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' ||
    code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ||
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    /\b404\b/.test(message)
  ) {
    return '暂未找到可用的版本信息，请稍后再试或打开发布页查看';
  }
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONN|EAI_AGAIN|socket hang up|timeout/i.test(message)) {
    return '无法连接更新服务器，请检查网络后重试，或打开发布页手动下载';
  }
  return '更新失败，请稍后重试，或打开发布页手动下载';
}

export class UpdateService {
  private state: UpdateView;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: UpdateServiceDeps) {
    this.state = {
      supported: deps.driver != null,
      phase: 'IDLE',
      currentVersion: deps.currentVersion,
      version: null,
      notes: null,
      percent: null,
      error: null,
      errorDuring: null,
    };
  }

  view(): UpdateView {
    return this.state;
  }

  scheduleStartupCheck(delayMs = STARTUP_CHECK_DELAY_MS) {
    if (!this.deps.driver || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check(false);
    }, delayMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async check(manual: boolean): Promise<UpdateView> {
    const { driver } = this.deps;
    const { phase } = this.state;
    if (!driver || phase === 'CHECKING' || phase === 'DOWNLOADING' || phase === 'DOWNLOADED') {
      return this.state;
    }
    this.set({ phase: 'CHECKING', error: null, errorDuring: null });
    try {
      const info = await driver.check();
      if (info) {
        this.set({ phase: 'AVAILABLE', version: info.version, notes: info.notes, percent: null });
      } else {
        this.set({ phase: 'LATEST', version: null, notes: null, percent: null });
      }
    } catch (error) {
      this.deps.logger.error('update.check', { reason: errorCode(error) });
      // 启动时的自动检查失败不打扰用户
      if (manual) {
        this.set({ phase: 'ERROR', error: updateErrorMessage(error), errorDuring: 'CHECK' });
      } else {
        this.set({ phase: 'IDLE' });
      }
    }
    return this.state;
  }

  async download(): Promise<UpdateView> {
    const { driver } = this.deps;
    const canDownload =
      this.state.phase === 'AVAILABLE' ||
      (this.state.phase === 'ERROR' && this.state.errorDuring === 'DOWNLOAD');
    if (!driver || !canDownload) return this.state;
    this.set({ phase: 'DOWNLOADING', percent: 0, error: null, errorDuring: null });
    try {
      await driver.download((value) => {
        const percent = Math.min(100, Math.max(0, Math.floor(value)));
        if (this.state.phase === 'DOWNLOADING' && percent !== this.state.percent) {
          this.set({ percent });
        }
      });
      this.set({ phase: 'DOWNLOADED', percent: 100 });
    } catch (error) {
      this.deps.logger.error('update.download', { reason: errorCode(error) });
      this.set({
        phase: 'ERROR',
        percent: null,
        error: updateErrorMessage(error),
        errorDuring: 'DOWNLOAD',
      });
    }
    return this.state;
  }

  install(): UpdateInstallResult {
    if (this.state.phase !== 'DOWNLOADED') return { ok: false, reason: '更新尚未下载完成' };
    if (this.deps.isBusy()) {
      return { ok: false, reason: '有进行中的出码或待处理订单，完成后才能安装更新' };
    }
    this.deps.requestInstall();
    return { ok: true };
  }

  private set(patch: Partial<UpdateView>) {
    this.state = { ...this.state, ...patch };
    this.deps.onChange(this.state);
  }
}
