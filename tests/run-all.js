#!/usr/bin/env node
/**
 * Runs every test suite in order, reports a summary.
 *
 *   node tests/run-all.js            # 全部
 *   node tests/run-all.js memory     # 只跑名字含 memory 的
 *
 * 单元测试（无网络）先跑；集成测试需要服务端已启动，
 * 检测不到服务时会跳过而不是失败。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

try { process.loadEnvFile?.(path.join(ROOT, '.env')); } catch { /* no .env */ }

const ORDER = ['test-world-card.js', 'test-memory.js', 'test-agents.js', 'test-context.js', 'test-fates.js', 'test-config.js', 'test-api.js'];

const only = process.argv[2];
const selected = only ? ORDER.filter((f) => f.includes(only)) : ORDER;

async function serverUp() {
  try {
    const res = await fetch(`${process.env.TEST_BASE_URL || 'http://localhost:3210'}/api/config`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch { return false; }
}

const up = await serverUp();
if (!up) console.log('⚠ 服务端未启动，将跳过集成测试（tests/test-api.js）');

let failed = 0;
let skipped = 0;

for (const file of selected) {
  if (file === 'test-api.js' && !up) { skipped++; continue; }
  console.log(`\n${'─'.repeat(60)}\n▶ ${file}\n${'─'.repeat(60)}`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env },
    });
    p.on('close', resolve);
  });
  if (code !== 0) { failed++; console.log(`✗ ${file} FAILED (exit ${code})`); }
}

console.log(`\n${'═'.repeat(60)}`);
const ran = selected.length - skipped;
if (failed === 0) {
  console.log(`ALL PASSED — ${ran} 个套件${skipped ? `，跳过 ${skipped} 个（需启动服务端）` : ''}`);
} else {
  console.log(`${failed}/${ran} 个套件失败`);
  process.exit(1);
}
