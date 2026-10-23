/**
 * _work/check-imports.mjs — 校验每个 import 的名字在目标模块里真实存在
 *
 * 死代码扫描的盲区：`import { TONE } from './ui-kit.js'` 加上
 * `export { TONE }` 的转发，会让 TONE 看起来「有引用」而漏删。
 * 这个脚本直接解析 import 声明，去目标模块的导出列表里核对。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const files = [];

function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return; }
  for (const f of ents) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (f === 'node_modules' || f === '.git') continue;
      walk(p);
    } else if (/\.(js|mjs)$/.test(f)) files.push(p);
  }
}
for (const d of ['server', 'web/js', 'tests', '_work']) walk(path.join(ROOT, d));

const sources = files.map((f) => {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { /* skip */ }
  return { abs: f, rel: path.relative(ROOT, f).replace(/\\/g, '/'), text };
});

/** 剥掉块注释与行注释，避免匹配到文档里的示例代码。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1 ');
}

/** 收集一个模块导出的名字（含 re-export 转发）。 */
function exportsOf(raw) {
  const text = stripComments(raw);
  const names = new Set();
  // 覆盖 function / async function / function* / async function*
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) names.add(m[1]);
  // export const/let/var（$ 这类标识符也要收）
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  if (/export\s+default/.test(text)) names.add('default');
  return names;
}

const byRel = new Map(sources.map((s) => [s.rel, s]));

/** 把 './x.js' / '../x.js' 解析成仓库相对路径。 */
function resolveSpec(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.dirname(fromRel);
  let p = path.posix.normalize(path.posix.join(base, spec));
  if (!/\.(js|mjs)$/.test(p)) p += '.js';
  return p;
}

const problems = [];
for (const s of sources) {
  // import ... from '...' / export ... from '...'
  const re = /(?:import|export)\s+(?:([\w*${}, \n]+?)\s+from\s+)?['"]([^'"]+)['"]/g;
  const code = stripComments(s.text);
  let m;
  while ((m = re.exec(code))) {
    const clause = (m[1] || '').trim();
    const spec = m[2];
    const target = resolveSpec(s.rel, spec);
    if (!target) continue;
    const targetSrc = byRel.get(target);
    if (!targetSrc) { problems.push(`${s.rel}: 找不到模块 '${spec}'`); continue; }
    const avail = exportsOf(targetSrc.text);
    // 解出花括号里的名字
    const brace = clause.match(/\{([^}]*)\}/);
    if (!brace) continue;
    for (const part of brace[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!avail.has(name)) problems.push(`${s.rel}: '${name}' 不在 ${target} 的导出里`);
    }
  }
}

if (problems.length) {
  console.log('=== import 名称不存在 ===');
  problems.forEach((p) => console.log(`  ✗ ${p}`));
  console.log(`\n共 ${problems.length} 处`);
  process.exit(1);
} else {
  console.log('✓ 所有 import 名称都能在目标模块里找到');
}
