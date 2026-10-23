/**
 * server/routes/fonts.js — 本机字体清单
 *
 * 浏览器侧的 Local Font Access API 只在 Chromium 系可用，而且在部分
 * 内嵌/受限环境里会返回空数组。这个接口从服务端所在机器读取系统字体，
 * 作为同机访问时的兜底；读取结果按进程缓存，字体变化后重启即可。
 *
 *   GET /api/fonts -> { fonts: string[], source: 'windows'|'macos'|'linux'|'unsupported' }
 */
import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const fontsRouter = Router();

let cache = null;
let pending = null;

function normalize(names) {
  const out = new Set();
  for (const raw of names) {
    let name = String(raw || '').trim();
    if (!name) continue;
    // 去掉「(TrueType)」「(OpenType)」这类后缀，以及字体文件路径。
    name = name.replace(/\s*\((TrueType|OpenType)\)\s*$/i, '').trim();
    if (!name || name.length > 80) continue;
    if (/^[A-Za-z]:\\/.test(name) || name.startsWith('/')) continue;
    out.add(name);
  }
  return [...out].sort(new Intl.Collator(['zh-Hans-CN', 'en'], {
    sensitivity: 'base', numeric: true,
  }).compare);
}

async function listWindows() {
  // PowerShell 默认按控制台代码页输出，中文族名会乱码；显式切到 UTF-8。
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Drawing',
    '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }',
  ].join('; ');
  const { stdout } = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return stdout.split(/\r?\n/);
}

async function listFontconfig() {
  const { stdout } = await run('fc-list', [':', 'family'], {
    timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).flatMap((line) => line.split(','));
}

async function listMac() {
  const { stdout } = await run('system_profiler', ['SPFontsDataType'], {
    timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/)
    .map((line) => line.match(/^\s{8,}(.+):\s*$/)?.[1])
    .filter(Boolean);
}

async function loadFonts() {
  try {
    if (process.platform === 'win32') {
      return { fonts: normalize(await listWindows()), source: 'windows' };
    }
    if (process.platform === 'darwin') {
      try {
        return { fonts: normalize(await listFontconfig()), source: 'macos' };
      } catch {
        return { fonts: normalize(await listMac()), source: 'macos' };
      }
    }
    return { fonts: normalize(await listFontconfig()), source: 'linux' };
  } catch (err) {
    return { fonts: [], source: 'unsupported', error: err.message };
  }
}

fontsRouter.get('/fonts', async (req, res) => {
  if (!cache) {
    if (!pending) {
      pending = loadFonts()
        .then((result) => { cache = result; return result; })
        .finally(() => { pending = null; });
    }
    cache = await pending;
  }
  res.json(cache);
});
