#!/usr/bin/env node
/** Runs every test file in tests/ sequentially, reports a summary. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// Load .env into this process so child test processes inherit STEPFUN_API_KEY etc.
try { process.loadEnvFile?.(path.join(ROOT, '.env')); } catch { /* no .env */ }

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.js') && f !== 'run-all.js')
  .sort();

const only = process.argv[2];
const selected = only ? files.filter(f => f.includes(only)) : files;

let failed = 0;
for (const file of selected) {
  console.log(`\n${'─'.repeat(60)}\n▶ ${file}\n${'─'.repeat(60)}`);
  const code = await new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(__dirname, file)], {
      cwd: ROOT, stdio: 'inherit',
      env: { ...process.env, DB_PATH: path.join(ROOT, 'data', `test-${file}.db`) },
    });
    p.on('close', resolve);
  });
  if (code !== 0) { failed++; console.log(`✗ ${file} FAILED (exit ${code})`); }
}

console.log(`\n${'═'.repeat(60)}`);
if (failed === 0) console.log(`ALL TEST SUITES PASSED (${selected.length} suites)`);
else { console.log(`${failed}/${selected.length} SUITES FAILED`); process.exit(1); }
