/**
 * _work/deadcode-scan.mjs — 找出从未被其他文件引用的导出（排除入口文件）
 *
 *   node _work/deadcode-scan.mjs
 *
 * 静态文本匹配（import 语句 + 调用点），不解析 AST。
 * 入口文件（路由/视图/工具库）的导出是被框架或浏览器用，不算死代码。
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
for (const d of ['server', 'web/js', 'tests']) walk(path.join(ROOT, d));

const sources = files.map((f) => {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { /* skip */ }
  return { rel: path.relative(ROOT, f).replace(/\\/g, '/'), text };
});

const ENTRY = new Set([
  'server/index.js',
  'server/routes/worlds.js', 'server/routes/sessions.js', 'server/routes/presets.js',
  'server/routes/smith.js', 'server/routes/openai.js', 'server/routes/static.js',
  'web/js/api.js', 'web/js/app.js', 'web/js/util.js', 'web/js/icons.js',
  'web/js/store.js', 'web/js/ui-kit.js', 'web/js/markdown.js', 'web/js/export.js',
  'web/js/panels/memory.js', 'web/js/shell.js',
  'web/js/views/worlds.js', 'web/js/views/world.js', 'web/js/views/world-edit.js',
  'web/js/views/play.js', 'web/js/views/settings.js',
]);

const targets = [];
for (const { rel, text } of sources) {
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([\w$]+)/g)) targets.push({ rel, name: m[1] });
  for (const m of text.matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)) targets.push({ rel, name: m[1] });
}

const dead = [];
for (const t of targets) {
  if (ENTRY.has(t.rel)) continue;
  let used = 0;
  const re = new RegExp(`\\b${t.name}\\b`, 'g');
  for (const s of sources) {
    if (s.rel === t.rel) continue;
    used += (s.text.match(re) || []).length;
  }
  if (used === 0) dead.push(`${t.rel} :: ${t.name}`);
}

if (dead.length) {
  console.log('=== 从未被其他文件引用的导出 ===');
  dead.sort().forEach((d) => console.log(`  ${d}`));
  console.log(`\n共 ${dead.length} 个`);
} else {
  console.log('✓ 没有被引用的导出');
}
