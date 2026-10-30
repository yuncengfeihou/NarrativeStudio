/**
 * server/routes/craft.js — 演绎工艺取值表的读写
 *
 *   GET    /api/craft           当前生效的完整配置（含每条正文与默认值）
 *   PUT    /api/craft           整体保存（先校验后落盘；空体 = 恢复内置）
 *   DELETE /api/craft           删除自定义，回到内置表
 *
 * 与 `GET /api/config` 的 `craft` 段分工：
 *   /api/config  只给「选择器」要的骨架（value/label/desc），演绎页抽屉用
 *   /api/craft   给「编辑器」要的全部（正文 text/tail/branch + where），设置页用
 * 两者都从 `craft.js` 的同一份当前表派生，没有第二份清单。
 */
import express from 'express';
import { craftConfigView, craftCatalog } from '../world/craft.js';
import { saveCraftConfig, resetCraftConfig } from '../world/craft-store.js';

export const craftRouter = express.Router();

craftRouter.get('/craft', (req, res) => {
  res.json({ craft: craftConfigView(), catalog: craftCatalog() });
});

craftRouter.put('/craft', (req, res) => {
  const result = saveCraftConfig(req.body);
  if (!result.ok) {
    return res.status(400).json({
      error: { message: result.error },
      problems: result.problems,
    });
  }
  res.json({ craft: result.view, catalog: craftCatalog() });
});

craftRouter.delete('/craft', (req, res) => {
  resetCraftConfig();
  res.json({ craft: craftConfigView(), catalog: craftCatalog() });
});
