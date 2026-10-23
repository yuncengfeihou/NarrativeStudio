/**
 * AI Roleplay Studio — server entry point.
 */
import './load-env.js';   // 必须第一个 import：先加载 .env，再求值 config
import express from 'express';
import { config, assertConfig } from './config.js';
import { openaiRouter } from './routes/openai.js';
import { sessionsRouter } from './routes/sessions.js';
import { worldsRouter } from './routes/worlds.js';
import { presetsRouter } from './routes/presets.js';
import { staticRouter } from './routes/static.js';
import { getDb } from './memory/store.js';

try {
  assertConfig();
} catch (err) {
  console.error(`\n[启动失败] ${err.message}\n`);
  console.error('请设置环境变量 STEPFUN_API_KEY，或创建 .env 文件（参考 .env.example）。\n');
  process.exit(1);
}

// 触发建表（幂等）
getDb();

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: true, limit: '32mb' }));

app.use((req, res, next) => {
  if (req.signal) return next();
  const ac = new AbortController();
  Object.defineProperty(req, 'signal', { value: ac.signal, configurable: true });
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (process.env.QUIET === '1') return;
    const ms = Date.now() - start;
    if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

app.use('/api', worldsRouter);
app.use('/api', sessionsRouter);
app.use('/api', presetsRouter);
app.use(openaiRouter);
app.use(staticRouter);

app.use('/api', (req, res) => res.status(404).json({ error: { message: 'not found' } }));
app.use('/v1', (req, res) => {
  res.status(404).json({ error: { message: `unknown route: ${req.method} ${req.originalUrl}`, type: 'invalid_request_error', code: 'not_found' } });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return res.end();
  res.status(err.status || 500).json({
    error: { message: err.message || 'internal server error', type: 'server_error', code: err.code || null },
  });
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.stack || reason);
});

app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║           AI Roleplay Studio — 已启动                     ║
  ╠══════════════════════════════════════════════════════════╣
  ║  Web 客户端      http://${shown}:${config.port}
  ║  OpenAI 兼容 API http://${shown}:${config.port}/v1
  ║    模型: ${config.upstream.model}
  ║    上游: ${config.upstream.baseUrl}
  ║  上下文软目标    ${config.context.softTokens.toLocaleString()} tokens
  ║  上下文硬上限    ${config.context.maxTokens.toLocaleString()} tokens
  ╚══════════════════════════════════════════════════════════╝
  `);
});
