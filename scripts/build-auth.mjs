// npm run build:auth：用固定依赖与 PyInstaller 冻结解析器为独立 EXE（native/auth-reader/dist/auth-reader.exe）。
import fs from 'node:fs';
import path from 'node:path';
import { ensureVenv, root, sh } from './auth-env.mjs';

const python = ensureVenv({ build: true });
const work = path.join(root, '.build', 'auth');
fs.mkdirSync(work, { recursive: true });
sh(python, [
  '-X',
  'utf8',
  '-m',
  'PyInstaller',
  '--noconfirm',
  '--clean',
  '--onefile',
  '--console',
  '--name',
  'auth-reader',
  '--distpath',
  path.join(root, 'native', 'auth-reader', 'dist'),
  '--workpath',
  work,
  '--specpath',
  work,
  path.join(root, 'native', 'auth-reader', 'reader.py'),
]);
const exe = path.join(root, 'native', 'auth-reader', 'dist', 'auth-reader.exe');
if (!fs.existsSync(exe)) {
  console.error('未生成 auth-reader.exe');
  process.exit(1);
}
console.log(`auth-reader.exe ${fs.statSync(exe).size} bytes`);
