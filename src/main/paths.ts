// 本地目录布局：业务数据 %LOCALAPPDATA%\JewelryHelper\data，缓存与日志各自独立子目录（技术选型 §5）。
import os from 'node:os';
import path from 'node:path';

export interface AppPaths {
  root: string;
  dataDir: string;
  dbFile: string;
  backupDir: string;
  imageCacheDir: string;
  logDir: string;
  electronDir: string;
}

export function resolvePaths(root?: string): AppPaths {
  const base =
    root ??
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'JewelryHelper',
    );
  const dataDir = path.join(base, 'data');
  return {
    root: base,
    dataDir,
    dbFile: path.join(dataDir, 'app.db'),
    backupDir: path.join(dataDir, 'backups'),
    imageCacheDir: path.join(base, 'cache', 'images'),
    logDir: path.join(base, 'logs'),
    electronDir: path.join(base, 'electron'),
  };
}

export function defaultClientDataDir(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, '5E对战平台', 'Local Storage', 'leveldb');
}
