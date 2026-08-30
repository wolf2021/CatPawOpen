// strip-danmu-api.mjs — AST 精确死代码消除：从 douer 运行时里删掉内嵌的旧 danmu_api，
// 并把内置弹幕入口重写到 globalThis.__danmuApiHandleRequest（由 splice bundle 提供）。
//
// 语句模型（对顶层语句分类）：
//   def    : var X=… / function X / class X          —— 定义名字，按名字存活
//   dn     : dn(X, {...getters})                     —— esbuild 的 export 接线，随 X 存活
//   init   : C();  （0 参数裸调用）                    —— esbuild 的惰性模块初始化，随 C 的 def 存活
//   other  : 其余一切（副作用语句）                     —— 一律保留（保守：不删任何可能含副作用/引导逻辑的语句）
//
// 存活规则（不动点）：
//   - other 语句恒定存活，其引用名称为种子；
//   - 名字 n 存活 ⇒ n 的 def 存活 ⇒ def 内引用名称存活；
//   - 名字 n 存活 ⇒ 以 n 为目标的 dn/init 语句存活 ⇒ 其引用名称存活；
//   - 未存活的 def/dn/init 一律删除。
//
// 与旧版 patch-danmu-api.mjs（正则重写 + 追加，保留死代码）不同，本模块真正删除旧 danmu_api。
//
// 用法：
//   作为库：import { stripDeadCode, rewireDanmuBridge } from './strip-danmu-api.mjs'
//   作为 CLI：node strip-danmu-api.mjs <in> <out> [--why name...]
import fs from 'fs';
import * as acorn from 'acorn';

/** 把内置弹幕入口 rDt(c,u,"node",…) 重写到 globalThis.__danmuApiHandleRequest。 */
export function rewireDanmuBridge(src) {
  const re = /l=await ([A-Za-z0-9_$]+)\(c,u,"node",/;
  const m = src.match(re);
  if (!m) {
    throw new Error(
      '[strip-danmu-api] 未找到内置弹幕服务 handleRequest 调用点（douer 运行时结构可能已变化，需人工检查）'
    );
  }
  const oldFn = m[1];
  if (oldFn === '__danmuApiHandleRequest') return { text: src, patched: false, oldFn };
  return {
    text: src.replace(re, 'l=await globalThis.__danmuApiHandleRequest(c,u,"node",'),
    patched: true,
    oldFn,
  };
}

// ---------- 引用收集（跳过所有绑定位置；不做作用域消解 → 宁可多保留） ----------
function walkBinding(node, refs) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'Identifier': return;
    case 'ObjectPattern': for (const p of node.properties) walkBinding(p, refs); return;
    case 'ArrayPattern': for (const e of node.elements) walkBinding(e, refs); return;
    case 'AssignmentPattern': walkBinding(node.left, refs); walkRef(node.right, refs); return;
    case 'RestElement': walkBinding(node.argument, refs); return;
    case 'Property': if (node.computed) walkRef(node.key, refs); walkBinding(node.value, refs); return;
    case 'MemberExpression': walkRef(node, refs); return;
    default: walkRef(node, refs);
  }
}
function walkParams(params, refs) { for (const p of params) walkBinding(p, refs); }

// 只收集「读」位置（赋值目标 / 绑定 / 更新目标不算读）。用于判定某名字是否还有存活读者。
function walkRead(node, refs) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'Identifier': refs.add(node.name); return;
    case 'AssignmentExpression':
      // LHS 若是普通标识符属「写」；成员表达式则需读其 object/property
      if (node.left.type === 'Identifier') { walkRead(node.right, refs); return; }
      walkRead(node.left, refs); walkRead(node.right, refs); return;
    case 'UpdateExpression': walkRead(node.argument, refs); return;
    case 'VariableDeclarator': walkRead(node.init, refs); return;
    case 'FunctionDeclaration': case 'FunctionExpression':
      if (node.id) walkBinding(node.id, refs); walkParams(node.params, refs); walkRead(node.body, refs); return;
    case 'ArrowFunctionExpression': walkParams(node.params, refs); walkRead(node.body, refs); return;
    case 'ClassDeclaration': case 'ClassExpression':
      if (node.id) walkBinding(node.id, refs); walkRead(node.superClass, refs); walkRead(node.body, refs); return;
    case 'MemberExpression':
      walkRead(node.object, refs); if (node.computed) walkRead(node.property, refs); return;
    case 'Property':
      if (node.computed) walkRead(node.key, refs);
      else if (node.kind === 'init' && node.shorthand) walkRead(node.value, refs);
      else walkRead(node.value, refs);
      return;
    case 'MethodDefinition': case 'PropertyDefinition':
      if (node.computed) walkRead(node.key, refs); walkRead(node.value, refs); return;
    case 'LabeledStatement': walkRead(node.body, refs); return;
    case 'BreakStatement': case 'ContinueStatement': return;
    case 'MetaProperty': return;
    case 'AssignmentPattern': walkBinding(node.left, refs); walkRead(node.right, refs); return;
    case 'RestElement': walkBinding(node.argument, refs); return;
    case 'CatchClause': walkBinding(node.param, refs); walkRead(node.body, refs); return;
    case 'TemplateLiteral': for (const e of node.expressions) walkRead(e, refs); return;
    case 'TaggedTemplateExpression': walkRead(node.tag, refs); walkRead(node.quasi, refs); return;
    case 'ImportExpression': walkRead(node.source, refs); return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'range' || key === 'loc' || key === 'type') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) walkRead(c, refs); }
    else if (v && typeof v === 'object' && typeof v.type === 'string') walkRead(v, refs);
  }
}

function walkRef(node, refs) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'Identifier': refs.add(node.name); return;
    case 'VariableDeclarator': walkBinding(node.id, refs); walkRef(node.init, refs); return;
    case 'FunctionDeclaration': case 'FunctionExpression':
      if (node.id) walkBinding(node.id, refs); walkParams(node.params, refs); walkRef(node.body, refs); return;
    case 'ArrowFunctionExpression': walkParams(node.params, refs); walkRef(node.body, refs); return;
    case 'ClassDeclaration': case 'ClassExpression':
      if (node.id) walkBinding(node.id, refs); walkRef(node.superClass, refs); walkRef(node.body, refs); return;
    case 'MemberExpression':
      walkRef(node.object, refs); if (node.computed) walkRef(node.property, refs); return;
    case 'Property':
      if (node.computed) walkRef(node.key, refs);
      else if (node.kind === 'init' && node.shorthand) walkRef(node.value, refs);
      else walkRef(node.value, refs);
      return;
    case 'MethodDefinition': case 'PropertyDefinition':
      if (node.computed) walkRef(node.key, refs); walkRef(node.value, refs); return;
    case 'LabeledStatement': walkRef(node.body, refs); return;
    case 'BreakStatement': case 'ContinueStatement': return;
    case 'MetaProperty': return;
    case 'AssignmentPattern': walkBinding(node.left, refs); walkRef(node.right, refs); return;
    case 'RestElement': walkBinding(node.argument, refs); return;
    case 'CatchClause': walkBinding(node.param, refs); walkRef(node.body, refs); return;
    case 'TemplateLiteral': for (const e of node.expressions) walkRef(e, refs); return;
    case 'TaggedTemplateExpression': walkRef(node.tag, refs); walkRef(node.quasi, refs); return;
    case 'ImportExpression': walkRef(node.source, refs); return;
  }
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'range' || key === 'loc' || key === 'type') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) walkRef(c, refs); }
    else if (v && typeof v === 'object' && typeof v.type === 'string') walkRef(v, refs);
  }
}

// ---------- 语句分类 ----------
function collectPatternNames(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Identifier') { out.push(node.name); return; }
  if (node.type === 'ObjectPattern') { for (const p of node.properties) collectPatternNames(p.value, out); return; }
  if (node.type === 'ArrayPattern') { for (const e of node.elements) collectPatternNames(e, out); return; }
  if (node.type === 'AssignmentPattern') { collectPatternNames(node.left, out); return; }
  if (node.type === 'RestElement') { collectPatternNames(node.argument, out); return; }
}

function classify(stmt) {
  if (stmt.type === 'VariableDeclaration') {
    const names = [];
    for (const d of stmt.declarations) {
      if (d.id.type === 'Identifier') names.push(d.id.name);
      else collectPatternNames(d.id, names);
    }
    return { kind: 'def', names };
  }
  if (stmt.type === 'FunctionDeclaration') return { kind: 'def', names: stmt.id ? [stmt.id.name] : [] };
  if (stmt.type === 'ClassDeclaration') return { kind: 'def', names: stmt.id ? [stmt.id.name] : [] };
  if (stmt.type === 'ExpressionStatement') {
    const e = stmt.expression;
    if (e.type === 'CallExpression' && e.callee.type === 'Identifier') {
      const args = e.arguments;
      // dn(X, {…}) —— export 接线
      if (args.length >= 2 && args[0].type === 'Identifier' && args[1].type === 'ObjectExpression') {
        return { kind: 'dn', target: args[0].name };
      }
      // C(); —— 惰性初始化调用
      if (args.length === 0) {
        return { kind: 'init', target: e.callee.name };
      }
    }
    return { kind: 'other' };
  }
  return { kind: 'other' };
}

/**
 * 对 douer 运行时文本做死代码消除。
 * @param {string} src 原始运行时文本
 * @param {{rewire?: boolean}} opts rewire=true 时先把弹幕入口重写到全局入口
 * @returns {{text:string, rewire:{patched:boolean, oldFn:string|null}, stats:object}}
 */
export function stripDeadCode(src, { rewire = true } = {}) {
  const rw = rewire ? rewireDanmuBridge(src) : { text: src, patched: false, oldFn: null };
  const text0 = rw.text;

  const ast = acorn.parse(text0, {
    ecmaVersion: 'latest', sourceType: 'script', ranges: true, allowReturnOutsideFunction: true,
  });
  const stmts = ast.body;

  const infos = stmts.map(classify);
  const nameToStmt = new Map();     // 名字 -> def 语句下标
  const targetToStmts = new Map();  // 名字 -> [dn/init 语句下标]
  for (let i = 0; i < stmts.length; i++) {
    const inf = infos[i];
    if (inf.kind === 'def') {
      for (const n of inf.names) if (!nameToStmt.has(n)) nameToStmt.set(n, i);
    } else if (inf.kind === 'dn' || inf.kind === 'init') {
      if (!targetToStmts.has(inf.target)) targetToStmts.set(inf.target, []);
      targetToStmts.get(inf.target).push(i);
    }
  }

  const refSets = stmts.map((s) => { const r = new Set(); walkRef(s, r); return r; });

  // ---------- 存活分析 ----------
  const liveStmt = new Set();
  const liveName = new Set();
  const queue = [];

  for (let i = 0; i < stmts.length; i++) {
    if (infos[i].kind === 'other') {
      liveStmt.add(i);
      for (const n of refSets[i]) if (!liveName.has(n)) { liveName.add(n); queue.push(n); }
    }
  }

  while (queue.length) {
    const n = queue.pop();
    const si = nameToStmt.get(n);
    if (si !== undefined && !liveStmt.has(si)) {
      liveStmt.add(si);
      for (const m of refSets[si]) if (!liveName.has(m)) { liveName.add(m); queue.push(m); }
    }
    const tl = targetToStmts.get(n);
    if (tl) {
      for (const ti of tl) {
        if (liveStmt.has(ti)) continue;
        liveStmt.add(ti);
        for (const m of refSets[ti]) if (!liveName.has(m)) { liveName.add(m); queue.push(m); }
      }
    }
  }

  // ---------- 生成输出 ----------
  let out = '';
  let cursor = 0;
  let removedBytes = 0;
  let removedCount = 0;
  let removedDefs = 0;
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i];
    if (liveStmt.has(i)) {
      out += text0.slice(cursor, s.start);
      out += text0.slice(s.start, s.end);
      cursor = s.end;
    } else {
      removedBytes += s.end - s.start;
      removedCount++;
      if (infos[i].kind === 'def') removedDefs++;
      cursor = Math.max(cursor, s.end);
    }
  }
  out += text0.slice(cursor);

  const stats = {
    total: stmts.length,
    kept: liveStmt.size,
    removed: removedCount,
    removedDefs,
    removedBytes,
    inBytes: text0.length,
    outBytes: out.length,
  };

  // ---------- 死存储后处理 ----------
  // 共享压缩变量名的 def（如 var Hb,P,Lt=xe(()=>{x6t();Hb={旧全局}})）会因 Lt/P 存活而被整条保留，
  // 其中 Hb 只有被删代码（如 rDt）读取。这里删除「顶层声明、无任何存活读者」的裸赋值
  //   NAME = <对象字面量>   （仅限纯对象字面量 RHS，无副作用）
  // 以清除旧 danmu_api 全局单例等残留（例如 VERSION:"1.20.8"）。
  const declaredNames = new Set();
  for (let i = 0; i < stmts.length; i++) {
    if (infos[i].kind === 'def') for (const n of infos[i].names) declaredNames.add(n);
  }
  const readSets = stmts.map((s) => { const r = new Set(); walkRead(s, r); return r; });
  const liveReaders = new Set();
  for (let i = 0; i < stmts.length; i++) {
    if (liveStmt.has(i)) for (const n of readSets[i]) liveReaders.add(n);
  }
  const deadWriteNames = new Set();
  for (const n of declaredNames) if (!liveReaders.has(n)) deadWriteNames.add(n);

  if (deadWriteNames.size > 0) {
    const ast2 = acorn.parse(out, {
      ecmaVersion: 'latest', sourceType: 'script', ranges: true, allowReturnOutsideFunction: true,
    });
    const toRemove = [];
    const visit = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'ExpressionStatement') {
        const e = node.expression;
        if (
          e.type === 'AssignmentExpression' &&
          e.operator === '=' &&
          e.left.type === 'Identifier' &&
          deadWriteNames.has(e.left.name) &&
          e.right.type === 'ObjectExpression'
        ) {
          toRemove.push([node.start, node.end, e.left.name]);
          return;
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'start' || key === 'end' || key === 'range' || key === 'loc' || key === 'type') continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const c of v) visit(c); }
        else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v);
      }
    };
    visit(ast2);
    if (toRemove.length > 0) {
      toRemove.sort((a, b) => a[0] - b[0]);
      let out2 = '';
      let cur = 0;
      let deadStoreBytes = 0;
      for (const [s, e, name] of toRemove) {
        if (e <= cur) continue; // 重叠防御
        out2 += out.slice(cur, s);
        // 去掉该表达式语句残留的分号：吞掉其后的空白+分号
        let k = e;
        while (k < out.length && /[\s]/.test(out[k])) k++;
        if (out[k] === ';') k++;
        deadStoreBytes += k - s;
        cur = k;
      }
      out2 += out.slice(cur);
      out = out2;
      stats.deadStoreRemoved = toRemove.length;
      stats.deadStoreBytes = deadStoreBytes;
      stats.outBytes = out.length;
    }
  }

  return { text: out, rewire: rw, stats };
}

// ---------- CLI ----------
const entry = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
const self = import.meta.url.startsWith('file:') ? new URL(import.meta.url).pathname : '';
if (entry && self && entry === fs.realpathSync(self)) {
  const [inFile, outFile, ...flags] = process.argv.slice(2);
  if (!inFile || !outFile) {
    console.error('usage: node strip-danmu-api.mjs <in> <out> [--why name...]');
    process.exit(2);
  }
  const { text, rewire: rw, stats } = stripDeadCode(fs.readFileSync(inFile, 'utf8'));
  if (rw.patched) console.log(`rewire: ${rw.oldFn} -> globalThis.__danmuApiHandleRequest`);
  console.log(`total: ${stats.total}, kept: ${stats.kept}, removed: ${stats.removed} (${stats.removedDefs} defs)`);
  console.log(`removed bytes: ${(stats.removedBytes / 1024 / 1024).toFixed(2)} MB`);
  if (stats.deadStoreRemoved) {
    console.log(`dead stores removed: ${stats.deadStoreRemoved} (${(stats.deadStoreBytes / 1024).toFixed(2)} KB)`);
  }
  console.log(`out: ${(stats.outBytes / 1024 / 1024).toFixed(2)} MB (was ${(stats.inBytes / 1024 / 1024).toFixed(2)} MB)`);
  fs.writeFileSync(outFile, text);
  console.log(`wrote ${outFile}`);
}
