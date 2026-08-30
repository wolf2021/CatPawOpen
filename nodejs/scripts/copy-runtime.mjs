/**
 * 将 vendor/douer 复制到 dist/，并注入最新版 danmu_api 自包含 bundle。
 *
 * 流程（与旧版「保留死代码 + 追加」不同）：
 *   1. 读取 vendor/douer/index.js（上游 douer 引擎原始快照）
 *   2. strip-danmu-api.mjs —— AST 精确删除内嵌的旧 danmu_api 死代码，
 *      并把内置弹幕入口重写到 globalThis.__danmuApiHandleRequest
 *   3. 追加 vendor/danmu-api/splice.cjs（最新版 danmu_api 自包含 bundle）
 *   4. node --check 校验语法 + 校验桥接/导出存在，再写 dist/index.js + md5
 *
 * 上游 douer 更新可直接 vendor:refresh 后构建；弹幕 API 版本由
 * vendor/danmu-api/splice.cjs 决定（npm run danmu:refresh 拉取最新版）。
 */
import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { stripDeadCode } from './strip-danmu-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const vendorJs = path.join(root, 'vendor/douer/index.js');
const vendorMd5 = path.join(root, 'vendor/douer/index.js.md5');
const splicePath = path.join(root, 'vendor/danmu-api/splice.cjs');
const spliceMd5Path = path.join(root, 'vendor/danmu-api/splice.cjs.md5');
const distDir = path.join(root, 'dist');
const distJs = path.join(distDir, 'index.js');
const distMd5 = path.join(distDir, 'index.js.md5');

if (!fs.existsSync(vendorJs)) {
  console.error('Missing vendor/douer/index.js — run: npm run vendor:refresh');
  process.exit(1);
}
if (!fs.existsSync(splicePath)) {
  console.error('Missing vendor/danmu-api/splice.cjs — run: npm run danmu:refresh');
  process.exit(1);
}

// vendor 完整性核对
const pinned = fs.existsSync(vendorMd5) ? fs.readFileSync(vendorMd5, 'utf8').trim().toLowerCase() : '';
const vendorBuf = fs.readFileSync(vendorJs);
const vendorHash = createHash('md5').update(vendorBuf).digest('hex');
if (pinned && pinned !== vendorHash) {
  console.error(`vendor md5 mismatch: file=${vendorHash} pinned=${pinned}`);
  console.error('Run: npm run vendor:refresh');
  process.exit(1);
}

// splice 完整性核对
const splicePinned = fs.existsSync(spliceMd5Path)
  ? fs.readFileSync(spliceMd5Path, 'utf8').trim().toLowerCase()
  : '';
const spliceBuf = fs.readFileSync(splicePath);
const spliceHash = createHash('md5').update(spliceBuf).digest('hex');
if (splicePinned && splicePinned !== spliceHash) {
  console.error(`splice md5 mismatch: file=${spliceHash} pinned=${splicePinned}`);
  console.error('Run: npm run danmu:refresh');
  process.exit(1);
}

fs.mkdirSync(distDir, { recursive: true });

// 1) 删掉旧 danmu_api 死代码 + 重写弹幕入口
let { text: stripped, rewire: rw, stats } = stripDeadCode(vendorBuf.toString('utf8'));
if (!rw.patched) {
  console.error('strip: 弹幕入口未重写（可能已重写过或结构变化），中止以保护运行时。');
  process.exit(1);
}
if (!rw.envExposed) {
  console.error('strip: 未找到 exn 环境变量处理器锚点，无法暴露 __danmuApiEnvHandler，中止。');
  process.exit(1);
}

// 1.5) 运行时配置存储（旧内嵌弹幕全局对象）里残留的 VERSION 字段是活值（env 解析器按 "version" 读取），
//      把它同步为 splice 版本，避免对外暴露过期的旧版本号。
const versionPath = path.join(root, 'vendor/danmu-api/version');
const spliceVersion = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : '';
if (/^\d+\.\d+\.\d+/.test(spliceVersion)) {
  const verRe = /accessedEnvVars:\{\},VERSION:"[^"]*",MAX_LOGS/;
  if (verRe.test(stripped)) {
    stripped = stripped.replace(verRe, `accessedEnvVars:{},VERSION:"${spliceVersion}",MAX_LOGS`);
    console.log(`danmu_api version field: synced to ${spliceVersion}`);
  }
}
console.log(
  `danmu_api strip: rewired ${rw.oldFn} -> globalThis.__danmuApiHandleRequest; ` +
  `removed ${stats.removed}/${stats.total} stmts (${stats.removedDefs} defs, ` +
  `${(stats.removedBytes / 1024 / 1024).toFixed(2)} MB)`
);

// 2) 追加最新版 danmu_api splice
let distText = stripped;
if (!distText.endsWith('\n')) distText += '\n';
distText += '\n' + spliceBuf.toString('utf8').replace(/\s*$/, '\n') + '\n';

// 3) 校验
if (!distText.includes('globalThis.__danmuApiHandleRequest')) {
  console.error('verify failed: 桥接入口 globalThis.__danmuApiHandleRequest 缺失');
  process.exit(1);
}
if (!distText.includes('module.exports')) {
  console.error('verify failed: 运行时导出 module.exports 缺失');
  process.exit(1);
}
const chk = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
  input: distText,
  encoding: 'utf8',
});
if (chk.status !== 0) {
  console.error('verify failed: node --check 未通过');
  console.error(chk.stderr);
  process.exit(1);
}

const distBuf = Buffer.from(distText, 'utf8');
fs.writeFileSync(distJs, distBuf);
fs.writeFileSync(distMd5, createHash('md5').update(distBuf).digest('hex'));

console.log(
  `runtime built: vendor douer ${(vendorBuf.length / 1024 / 1024).toFixed(2)} MB ` +
  `→ stripped ${(stats.outBytes / 1024 / 1024).toFixed(2)} MB + splice ${(spliceBuf.length / 1024 / 1024).toFixed(2)} MB ` +
  `→ dist/index.js ${(distBuf.length / 1024 / 1024).toFixed(2)} MB (md5=${createHash('md5').update(distBuf).digest('hex')})`
);
