/**
 * Static hosting for the web client + SPA fallback.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const staticRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

staticRouter.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) return next();
  const rel = req.path === '/' ? 'index.html' : decodeURIComponent(req.path.replace(/^\/+/, ''));
  const filePath = path.join(WEB_DIR, rel);
  // prevent path traversal
  if (!filePath.startsWith(WEB_DIR)) return next();
  // 前端无构建、直接改源码即生效，所以不缓存（否则改了 CSS/JS 还要手动强刷）
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    // SPA fallback
    fs.stat(path.join(WEB_DIR, 'index.html'), (e2, s2) => {
      if (e2 || !s2.isFile()) return next();
      res.setHeader('Content-Type', MIME['.html']);
      fs.createReadStream(path.join(WEB_DIR, 'index.html')).pipe(res);
    });
  });
});
