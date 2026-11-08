// 分别对主进程、preload、renderer、共享契约和测试运行 tsc --noEmit。
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
const projects = ['shared', 'main', 'preload', 'renderer', 'tests'];
let failed = false;
for (const name of projects) {
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', `tsconfig.${name}.json`], {
    stdio: 'inherit',
  });
  console.log(`typecheck ${name}: ${result.status === 0 ? 'ok' : 'failed'}`);
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
