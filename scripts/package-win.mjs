// npm run package:win：检查解析器构建产物 → 生成许可清单 → electron-vite 构建 → NSIS x64 打包 → SHA-256 清单。不上传发布。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
const exe = path.join(root, 'native', 'auth-reader', 'dist', 'auth-reader.exe');
if (!fs.existsSync(exe)) {
  console.error('缺少 native/auth-reader/dist/auth-reader.exe，请先运行 npm run build:auth');
  process.exit(1);
}
run('node', ['scripts/make-icons.mjs']);
run('node', ['scripts/collect-licenses.mjs']);
run('npx', ['electron-vite', 'build']);
run('npx', ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never']);
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dir = path.join(root, 'release', version);
const lines = [];
for (const f of fs.readdirSync(dir).filter((f) => /\.(exe|blockmap)$/.test(f))) {
  const hash = createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  lines.push(`${hash}  ${f}`);
}
fs.copyFileSync(path.join(root, 'release-meta', 'THIRD_PARTY_LICENSES.txt'), path.join(dir, 'THIRD_PARTY_LICENSES.txt'));
fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
