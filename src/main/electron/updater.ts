// electron-updater 驱动：只提供检查、下载和安装；不自动下载，不在退出时静默安装。
import { autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { UpdaterDriver } from '../services/update-service';

const MAX_NOTES_LENGTH = 2000;

/** Release 说明可能是 HTML，界面只按纯文本显示。 */
function plainNotes(notes: UpdateInfo['releaseNotes']): string | null {
  const text = Array.isArray(notes)
    ? notes.map((n) => n.note ?? '').join('\n')
    : typeof notes === 'string'
      ? notes
      : '';
  const plain = text
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return plain ? plain.slice(0, MAX_NOTES_LENGTH) : null;
}

export function createElectronUpdater(): UpdaterDriver {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableDifferentialDownload = true;
  // 更新器日志可能含下载地址，失败原因由更新服务按错误码记录
  autoUpdater.logger = null;
  // 没有 error 监听时 EventEmitter 会抛出未捕获异常；失败已由 Promise 返回
  autoUpdater.on('error', () => {});

  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) return null;
      return {
        version: result.updateInfo.version,
        notes: plainNotes(result.updateInfo.releaseNotes),
      };
    },
    async download(onProgress) {
      const listener = (progress: ProgressInfo) => onProgress(progress.percent);
      autoUpdater.on('download-progress', listener);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off('download-progress', listener);
      }
    },
    quitAndInstall() {
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
