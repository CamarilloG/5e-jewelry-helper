// 生成第三方许可清单：打进安装包的 npm 运行时依赖（全部传递依赖）+ Electron + 解析器 Python 依赖。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'release-meta');
fs.mkdirSync(out, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tree = JSON.parse(
  execFileSync(npm, ['ls', '--omit=dev', '--all', '--json'], { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 64 << 20 }),
);
const seen = new Map();
const walk = (deps, dir) => {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (!info.version || info.missing) continue;
    const key = `${name}@${info.version}`;
    if (!seen.has(key)) seen.set(key, { name, version: info.version });
    walk(info.dependencies, dir);
  }
};
walk(tree.dependencies);
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
seen.set(`electron@${electronVersion}`, { name: 'electron', version: electronVersion });

const licenseText = (dir) => {
  if (!fs.existsSync(dir)) return null;
  const file = fs.readdirSync(dir).find((f) => /^(license|licence|copying)(\.|$)/i.test(f));
  return file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null;
};
const sections = [];
const summary = [];
for (const { name, version } of [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.join(root, 'node_modules', name);
  let license = 'UNKNOWN';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN');
  } catch {}
  summary.push(`${name}@${version}  ${license}`);
  sections.push(`==== ${name}@${version} (${license}) ====\n${licenseText(dir) ?? '(许可文本见上游项目)'}\n`);
}
if (fs.existsSync(path.join(root, 'node_modules/electron/dist/LICENSES.chromium.html'))) {
  sections.push('==== Chromium 及其组件 ====\n随 Electron 分发，完整许可见安装目录 LICENSES.chromium.html。\n');
}
// 解析器（PyInstaller 冻结）依赖
const site = path.join(root, '.venv-auth', 'Lib', 'site-packages');
const py = [];
if (fs.existsSync(site)) {
  for (const d of fs.readdirSync(site).filter((d) => d.endsWith('.dist-info'))) {
    const meta = fs.readFileSync(path.join(site, d, 'METADATA'), 'utf8');
    const name = meta.match(/^Name: (.+)$/m)?.[1];
    const version = meta.match(/^Version: (.+)$/m)?.[1];
    const lic = meta.match(/^License-Expression: (.+)$/m)?.[1] ?? meta.match(/^License: (.+)$/m)?.[1] ?? meta.match(/^Classifier: License :: (.+)$/m)?.[1] ?? 'UNKNOWN';
    if (!name || /^(pip|setuptools|wheel)$/i.test(name)) continue;
    const licFile = fs.readdirSync(path.join(site, d)).find((f) => /^licen[cs]e/i.test(f)) ?? (fs.existsSync(path.join(site, d, 'licenses')) ? 'licenses' : null);
    let text = '(许可文本见上游项目)';
    if (licFile) {
      const p = path.join(site, d, licFile);
      text = fs.statSync(p).isDirectory()
        ? fs.readdirSync(p).map((f) => fs.readFileSync(path.join(p, f), 'utf8')).join('\n')
        : fs.readFileSync(p, 'utf8');
    }
    py.push(`${name}@${version}  ${lic}`);
    sections.push(`==== [auth-reader] ${name}@${version} (${lic}) ====\n${text.trim()}\n`);
  }
}
sections.push('==== [auth-reader] CPython 3.11 运行时 (PSF-2.0) ====\n冻结解析器内含 CPython 运行时，遵循 Python Software Foundation License。\n');
const header = `饰品驿站助手 第三方许可清单\n生成时间：${new Date().toISOString()}\n\n[npm 运行时依赖与 Electron]\n${summary.join('\n')}\n\n[登录态解析器（PyInstaller 冻结）]\n${py.join('\n')}\nPyInstaller 引导程序依其 GPL 例外条款可随任意许可的程序分发。\n\n`;
fs.writeFileSync(path.join(out, 'THIRD_PARTY_LICENSES.txt'), header + sections.join('\n'));
const unknown = summary.filter((s) => s.endsWith('UNKNOWN'));
console.log(`许可清单：npm ${summary.length} 项，Python ${py.length} 项；未知许可 ${unknown.length} 项`);
if (unknown.length) console.log(unknown.join('\n'));
