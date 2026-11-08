// npm run test:auth：在隔离环境中运行人工 LevelDB 样例（无真实用户目录）。
import path from 'node:path';
import { ensureVenv, root, sh } from './auth-env.mjs';

const python = ensureVenv();
sh(python, [
  '-X',
  'utf8',
  '-m',
  'unittest',
  'discover',
  '-s',
  path.join(root, 'native', 'auth-reader'),
  '-p',
  'test_*.py',
  '-v',
]);
