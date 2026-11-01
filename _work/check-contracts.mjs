#!/usr/bin/env node
/**
 * check-contracts.mjs — 契约文档 ↔ 代码的机械对账
 *
 * 目的：docs/CONTRACTS.md 是接口的唯一契约，但它靠人写。一次审计（2026-11-01）发现
 * 68 处不一致，说明「靠记忆同步」不可持续。这个脚本只做**能机械判定**的四件事：
 *
 *   1. HTTP 路由：server/routes/*.js 注册的 method+path ↔ 文档里出现的 method+path
 *   2. SSE 事件：代码 emit({ type: 'x' }) ↔ 文档里出现的 {type:'x'}
 *   3. patch kind：代码 addPatch(..., kind: 'x') ↔ 文档里出现的 kind='x'
 *   4. 建表：store.js 的 CREATE TABLE IF NOT EXISTS x ↔ 文档里出现的裸 `x`
 *   5. 测试套件：tests/run-all.js 的 ORDER ↔ tests/test-*.js 实际文件
 *
 * 它**不检查**语义（参数名、返回值形状、字段含义）——那些只能靠人读。它保证的是
 * 「新增/删除一个接口、事件、patch 类型、表、测试套件时，文档不会悄悄落后一版」。
 *
 * 用法：node _work/check-contracts.mjs [--verbose]
 * 退出码：0 = 一致；1 = 有差异（CI/提交前可当闸门）。
 *
 * 允许的例外写在 EXCEPTIONS 里，每条都要写明理由——**不要为了让它绿而放宽规则**。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DOC = 'docs/CONTRACTS.md';
const verbose = process.argv.includes('--verbose');

/** 有意不写进契约的东西：key 形如 'routes:POST /api/x' / 'sse:x' / 'patch:x' / 'table:x'。 */
const EXCEPTIONS = {
  // 静态资源与 SPA 兜底由 express.static / staticRouter 处理，属于部署细节，不进接口契约。
  'routes:GET /assets': 'static',
  'routes:GET /*': 'static',
};

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 路径参数名不参与对账：`/patches/:patchId/apply` 与 `/patches/:id/apply` 是同一条路由。 */
const normalizeRoute = (route) =>
  route
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p')
    .replace(/\?.*$/, '')
    .replace(/[.,;:）)。，；：】]+$/, '');
const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'data') continue;
      walk(rel, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      out.push(rel);
    }
  }
  return out;
};

const doc = read(DOC);
const serverFiles = walk('server');

// ── 1. HTTP 路由 ────────────────────────────────────────────────────────────
// 代码：router.get('/x') / openaiRouter.post('/v1/chat/completions')
const codeRoutes = new Set();
for (const file of serverFiles) {
  if (!file.startsWith('server/routes/')) continue;
  const src = read(file);
  const re = /\b(\w*[Rr]outer)\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const verb = m[2].toUpperCase();
    let route = m[3];
    // openaiRouter 自带 /v1 前缀；其余 router 都挂在 app.use('/api', …) 上。
    if (!route.startsWith('/v1') && !route.startsWith('/api')) route = '/api' + route;
    codeRoutes.add(`${verb} ${normalizeRoute(route)}`);
  }
}
// 文档：表格行 `| \`GET /api/x\` | …` 与代码块行 `GET    /api/x` 都能命中。
const docRoutes = new Set();
{
  const re = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/(?:api|v1)\/[^\s`'"|,)]*)((?:[）)。，；：]+)?)/g;
  let m;
  while ((m = re.exec(doc))) docRoutes.add(`${m[1]} ${normalizeRoute(m[2] + (m[3] || ''))}`);
}

// ── 2. SSE 事件 ────────────────────────────────────────────────────────────
const codeSse = new Set();
for (const file of serverFiles) {
  const src = read(file);
  // 事件既可能 emit() 也可能在路由里 send()（SSE 封装不同），两种都算；
  // type 也可能是三元（`d.type === 'reasoning' ? 'reasoning' : 'narrative'`），取表达式里所有字符串字面量。
  const re = /(?:emit|send)\(\{[\s\S]{0,200}?type:\s*([^,\n}]+)/g;
  let m;
  while ((m = re.exec(src))) {
    for (const w of m[1].matchAll(/'(\w+)'/g)) codeSse.add(w[1]);
  }
}
const docSse = new Set();
{
  const re = /\{type:\s*'(\w+)'/g;
  let m;
  while ((m = re.exec(doc))) docSse.add(m[1]);
}

// ── 3. patch kind ──────────────────────────────────────────────────────────
const codePatch = new Set();
for (const file of serverFiles) {
  const src = read(file);
  const re = /addPatch\([\s\S]{0,300}?kind:\s*'(\w+)'/g;
  let m;
  while ((m = re.exec(src))) codePatch.add(m[1]);
}
const docPatch = new Set();
{
  // 只认 `### patch 类型（patches.kind）` 表格的第一列，避免把 changes.kind / turn.kind 混进来。
  const start = doc.indexOf('### patch 类型');
  const end = start < 0 ? -1 : doc.indexOf('\n### ', start + 5);
  const section = start < 0 ? '' : doc.slice(start, end < 0 ? doc.length : end);
  const re = /^\|\s*`(\w+)`/gm;
  let m;
  while ((m = re.exec(section))) docPatch.add(m[1]);
}

// ── 4. 建表 ────────────────────────────────────────────────────────────────
const codeTables = new Set();
{
  const src = read('server/memory/store.js');
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)/g;
  let m;
  while ((m = re.exec(src))) codeTables.add(m[1]);
}
const docTables = new Set();
const JS_WORDS = new Set([
  'import', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for',
  'while', 'switch', 'case', 'catch', 'throw', 'new', 'await', 'async', 'class', 'try',
]);
{
  // 建表清单只在代码块里：`turns { 列, … }` 或 `world_state(session_id, …)` / `relation_events(...同 …)`。
  // 只看围栏代码块，避免正文里的 `el(`、`row(...)` 之类被当成表名。
  const blocks = [...doc.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((x) => x[1]);
  for (const block of blocks) {
    const re = /^([a-z_]+)\s*(?:\(\s*(?:[a-z_]+|\.\.\.)|[({]\s*[a-z_]+)/gm;
    let m;
    while ((m = re.exec(block))) {
      // 代码块里的 `import { x }` / `if (a)` 不是建表语句，按 JS 关键字排掉。
      if (!JS_WORDS.has(m[1])) docTables.add(m[1]);
    }
  }
}

// ── 5. 测试套件 ────────────────────────────────────────────────────────────
const testFiles = new Set(
  fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => /^test-.*\.js$/.test(f)),
);
const orderSrc = read('tests/run-all.js');
const orderBlock = orderSrc.match(/const ORDER = \[([\s\S]*?)\]/)?.[1] || '';
const order = new Set(
  [...orderBlock.matchAll(/'([^']+\.js)'/g)].map((m) => m[1]),
);

// ── 汇总 ────────────────────────────────────────────────────────────────────
const diff = (label, codeSet, docSet) => {
  const missing = [...codeSet].filter((x) => !docSet.has(x) && !EXCEPTIONS[`${label}:${x}`]).sort();
  const stale = [...docSet].filter((x) => !codeSet.has(x) && !EXCEPTIONS[`${label}:${x}`]).sort();
  const ok = missing.length === 0 && stale.length === 0;
  console.log(`\n${ok ? '✓' : '✗'} ${label}：代码 ${codeSet.size} / 文档 ${docSet.size}`);
  if (missing.length) console.log(`  文档缺（代码有）：${missing.join('\n                  ')}`);
  if (stale.length) console.log(`  文档过期（代码无）：${stale.join('\n                  ')}`);
  if (verbose && ok) console.log(`  ${[...codeSet].sort().join(', ')}`);
  return ok;
};

let ok = true;
ok = diff('routes', codeRoutes, docRoutes) && ok;
ok = diff('sse', codeSse, docSse) && ok;
ok = diff('patch', codePatch, docPatch) && ok;
ok = diff('table', codeTables, docTables) && ok;

{
  const missing = [...testFiles].filter((f) => !order.has(f)).sort();
  const stale = [...order].filter((f) => !testFiles.has(f)).sort();
  const good = missing.length === 0 && stale.length === 0;
  console.log(`\n${good ? '✓' : '✗'} 测试套件：文件 ${testFiles.size} / run-all ${order.size}`);
  if (missing.length) console.log(`  run-all 缺：${missing.join(', ')}`);
  if (stale.length) console.log(`  run-all 过期：${stale.join(', ')}`);
  ok = ok && good;
}

console.log(ok ? '\n✓ 契约与代码一致' : '\n✗ 契约与代码有差异（见上）');
process.exit(ok ? 0 : 1);
