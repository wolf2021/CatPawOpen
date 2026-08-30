/**
 * 检测 danmu_api 是否有新版本（用于 CI 定时任务，配合 danmu:refresh）。
 *
 *   npm run danmu:check
 *
 * 退出码：0 = 检测完成；1 = 本地 splice 缺失/损坏。
 * 通过 GITHUB_OUTPUT 输出 local/remote/changed/reachable，供 workflow 判断。
 *
 * 可选环境变量：
 *   DANMU_API_REPO   仓库（默认 jieluojun/danmu-api）
 *   DANMU_API_BRANCH 分支（默认 main）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const splicePath = path.join(root, 'vendor', 'danmu-api', 'splice.cjs');
const md5Path = path.join(root, 'vendor', 'danmu-api', 'splice.cjs.md5');
const versionPath = path.join(root, 'vendor', 'danmu-api', 'version');

const REPO = process.env.DANMU_API_REPO || 'jieluojun/danmu-api';
const BRANCH = process.env.DANMU_API_BRANCH || 'main';
const REMOTE_VERSION_URL = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/danmu_api/configs/globals.js`;

function writeOutputs(obj) {
    if (!process.env.GITHUB_OUTPUT) return;
    const lines = Object.entries(obj).map(([k, v]) => `${k}=${v}`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

function localOk() {
    if (!fs.existsSync(splicePath) || !fs.existsSync(md5Path)) {
        return { ok: false, reason: 'missing vendor/danmu-api/splice.cjs or .md5' };
    }
    const pinned = (fs.readFileSync(md5Path, 'utf8') || '').trim().toLowerCase();
    const buf = fs.readFileSync(splicePath);
    if (buf.length < 500_000) {
        return { ok: false, reason: `local splice too small (${buf.length} bytes)` };
    }
    const actual = createHash('md5').update(buf).digest('hex');
    if (pinned && pinned !== actual) {
        return { ok: false, reason: `md5 mismatch file=${actual} pinned=${pinned}` };
    }
    const localVersion = fs.existsSync(versionPath) ? fs.readFileSync(versionPath, 'utf8').trim() : '';
    return { ok: true, local: localVersion, bytes: buf.length };
}

async function resolveRemoteVersion() {
    let text = '';
    for (const url of [REMOTE_VERSION_URL]) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            text = await res.text();
            break;
        } catch {
            /* try next */
        }
    }
    const m = text.match(/VERSION:\s*'([^']+)'/);
    return m ? m[1] : '';
}

function normalizeVersion(v) {
    const m = String(v || '').match(/\d+(?:\.\d+)+/);
    return m ? m[0] : '';
}

async function main() {
    const local = localOk();
    if (!local.ok) {
        console.error(`local danmu_api splice broken: ${local.reason}`);
        writeOutputs({ local: '', remote: '', changed: 'false', reachable: 'false' });
        process.exit(1);
    }

    console.log(`local danmu_api: v${local.local} (${(local.bytes / 1024 / 1024).toFixed(2)} MB)`);

    let remote = '';
    try {
        remote = await resolveRemoteVersion();
    } catch (e) {
        console.warn(`upstream unreachable: ${e.message}`);
    }

    if (!remote) {
        console.warn('could not resolve upstream danmu_api version; treating as unreachable');
        writeOutputs({ local: local.local, remote: '', changed: 'false', reachable: 'false' });
        process.exit(0);
    }

    const lv = normalizeVersion(local.local);
    const rv = normalizeVersion(remote);
    const changed = lv && rv && lv !== rv;
    console.log(`remote danmu_api: v${remote}`);
    writeOutputs({ local: local.local, remote, changed: changed ? 'true' : 'false', reachable: 'true' });

    if (!changed) {
        console.log('danmu_api: unchanged');
        process.exit(0);
    }
    console.log('danmu_api: UPDATED — CI will run danmu:refresh, build, and redeploy dist.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
