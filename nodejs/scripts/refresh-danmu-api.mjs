/**
 * 拉取最新版 danmu_api，重新打包成「自包含 splice bundle」并固化到 vendor/danmu-api/。
 *
 *   npm run danmu:refresh
 *
 * 可选环境变量：
 *   DANMU_API_REPO   danmu_api 仓库（默认 jieluojun/danmu-api）
 *   DANMU_API_BRANCH 分支（默认 main）
 *
 * 步骤：
 *   1. git clone 最新 danmu_api 源码（浅克隆）
 *   2. npm install 其依赖
 *   3. 用其自带 esbuild 打包 worker.js 的 handleRequest 为自包含 CJS（IIFE，挂到
 *      globalThis.__danmuApiHandleRequest）
 *   4. 复制到 vendor/danmu-api/splice.cjs 并更新 md5
 *
 * 说明：日常 npm run build 只使用本地固化的 splice.cjs（不访问外网）；
 *       本脚本仅在需要「拉取最新版」时手动/定时执行，失败不覆盖本地固化文件。
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'vendor', 'danmu-api');
const splicePath = path.join(vendorDir, 'splice.cjs');
const md5Path = path.join(vendorDir, 'splice.cjs.md5');

const REPO = process.env.DANMU_API_REPO || 'jieluojun/danmu-api';
const BRANCH = process.env.DANMU_API_BRANCH || 'main';
const CLONE_URL = `https://github.com/${REPO}.git`;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'danmu-api-'));
const SRC_DIR = path.join(WORK_DIR, 'danmu-api');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
  if (r.status !== 0) {
    throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
  }
  return r;
}

const ENTRY_SHIM = `// 由 refresh-danmu-api.mjs 生成：导出 handleRequest 并挂到全局
import { handleRequest } from './danmu_api/worker.js';
globalThis.__danmuApiHandleRequest = handleRequest;
`;

const BUILD_MJS = `import * as esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['entry-shim.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  minify: true,
  // redis 仅被 local-redis-util 的 \`await import('redis')\` 使用（本地 Redis 小众功能），
  // 外层有 try/catch 兜底 —— external 后运行时会 graceful 降级，体积显著减小。
  external: ['redis'],
  outfile: 'splice.cjs',
  legalComments: 'inline',
  banner: { js: '(() => {' },
  footer: { js: '})();' },
  logLevel: 'warning',
});
await esbuild.stop();
`;

function extractVersion(dir) {
  try {
    const p = path.join(dir, 'danmu_api', 'configs', 'globals.js');
    const m = fs.readFileSync(p, 'utf8').match(/VERSION:\s*'([^']+)'/);
    return m ? m[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  console.log(`[danmu:refresh] 拉取最新 danmu_api: ${REPO}#${BRANCH}`);
  console.log(`[danmu:refresh] 克隆 ${CLONE_URL} ...`);
  run('git', ['clone', '--depth', '1', '--branch', BRANCH, CLONE_URL, SRC_DIR]);

  const version = extractVersion(SRC_DIR);
  console.log(`[danmu:refresh] 源码版本 = ${version}`);

  console.log(`[danmu:refresh] npm install ...`);
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: SRC_DIR });

  fs.writeFileSync(path.join(SRC_DIR, 'entry-shim.mjs'), ENTRY_SHIM);
  fs.writeFileSync(path.join(SRC_DIR, 'build.mjs'), BUILD_MJS);

  console.log(`[danmu:refresh] esbuild 打包 ...`);
  run('node', ['build.mjs'], { cwd: SRC_DIR });

  const splice = fs.readFileSync(path.join(SRC_DIR, 'splice.cjs'));
  if (splice.length < 500_000) {
    throw new Error(`[danmu:refresh] splice.cjs 过小 (${splice.length} bytes)，疑似打包失败`);
  }
  const md5 = createHash('md5').update(splice).digest('hex');

  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(splicePath, splice);
  fs.writeFileSync(md5Path, md5);
  fs.writeFileSync(path.join(vendorDir, 'version'), version);

  console.log(
    `[danmu:refresh] 完成: vendor/danmu-api/splice.cjs ` +
    `(${(splice.length / 1024 / 1024).toFixed(2)} MB, v${version}, md5=${md5})`
  );
  console.log('[danmu:refresh] 提交 vendor/danmu-api/ 后运行 npm run build 即生效');
}

main()
  .catch((e) => {
    console.error('[danmu:refresh] 失败（本地固化文件未被覆盖）:', e.message);
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.rmSync(WORK_DIR, { recursive: true, force: true });
    } catch {}
  });
