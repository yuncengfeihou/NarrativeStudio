/**
 * server/load-env.js — 在 config.js 等模块求值前加载 .env。
 * ESM 的 import 按源码顺序求值，因此本文件必须是被引入文件的第一个 import。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile?.(envPath);
  } catch (err) {
    console.warn(`[load-env] .env 加载失败: ${err.message}`);
  }
}
