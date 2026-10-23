# _work — 素材处理与预设生成脚本

这些脚本用于把 `素材/` 下的小说原文转成可直接开局的剧本预设。
保留它们是为了**可重跑**：改了设定文案后重跑一次即可，不必手工编辑 JSON。

## 脚本

| 脚本 | 作用 |
|---|---|
| `scan.py` | 读取全部 124 章，统计人名/地名频次（确认哪些是主要角色） |
| `digest.py` | 逐章生成摘要（用于快速通读 27 万字） |
| `kw.py` | 抽取关键词上下文，核对专有名词写法 |
| `write_doc.py` | 生成 `素材/我在女尊世界捡破烂/_分析.md`（深度分析文档） |
| `build_preset.py` | 生成 `presets/nvzun-jianpolan.json`（可直接开局的预设） |
| `check-similarity.mjs` | 验证记忆去重的相似度阈值（线索合并是否正确） |

## 重跑

```bash
python _work/scan.py            # 人名频次
python _work/build_preset.py    # 重新生成预设 JSON
node  _work/check-similarity.mjs # 校验去重阈值
```

## 依赖

- Python 3（标准库即可；`scan.py` 会用 pandas 做频次统计）
- Node 22+（`check-similarity.mjs` 直接 import 服务端模块）

## 约定

- 所有输出使用 UTF-8 **无 BOM**（`open(..., encoding='utf-8', newline='\n')`）
- 专有名词必须与原文逐字一致，不得改写（改写会破坏世界观一致性）
