// 解析器的 Python 构建环境：.venv-auth（Git 忽略），依赖使用精确清单并关闭自动依赖解析。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const venv = path.join(root, '.venv-auth');
export const venvPython = path.join(venv, 'Scripts', 'python.exe');
const authDir = path.join(root, 'native', 'auth-reader');

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) {
    console.error(`命令失败：${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

export function ensureVenv({ build = false } = {}) {
  if (!fs.existsSync(venvPython)) {
    const base = process.env.JH_PYTHON ?? 'python';
    sh(base, ['-m', 'venv', venv]);
  }
  const marker = path.join(venv, build ? '.deps-build' : '.deps-runtime');
  if (!fs.existsSync(marker)) {
    sh(venvPython, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-deps',
      '-r',
      path.join(authDir, 'requirements-runtime.txt'),
    ]);
    if (build) {
      sh(venvPython, [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '-r',
        path.join(authDir, 'requirements-build.txt'),
      ]);
    }
    fs.writeFileSync(marker, new Date().toISOString());
  }
  return venvPython;
}
