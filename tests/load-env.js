/**
 * tests/load-env.js — 在测试模块求值前加载 .env（ESM import 按源码顺序求值，
 * 因此本文件必须是被测文件的第一个 import）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile?.(path.resolve(__dirname, '..', '.env')); } catch { /* no .env */ }
