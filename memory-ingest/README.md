# memory-ingest · 本地会话 → 记忆数据（M1）

把本机的 DSH / Claude Code / Codex 会话，整理成统一的 `turns.jsonl`，作为后续抽记忆卡片的输入。

**只读**：不修改任何源会话数据。

## 命令

```bash
cd memory-ingest

# 1) 扫描本机所有会话（只读，生成清单）
node tools/scan.mjs

# 2) 归一化指定项目最近 N 天（默认 7 天）
node tools/normalize.mjs --project /Users/du/Documents/突如其来 --days 7
```

## 产物

| 文件 | 内容 |
|---|---|
| `data/inventory.json` | 全部来源清单：项目、文件、体积、时间范围 |
| `data/turns.jsonl` | 统一轮次流（每行一个 Turn） |
| `data/stats.json` | 统计：来源、按天、角色、丢弃原因 |
| `data/sample-turns.md` | 20 条人工核对样例 |

## Turn 结构

```json
{
  "id": "dsh:session-xxx:123",
  "source": "dsh",
  "project": "/Users/du/Documents/突如其来",
  "sessionId": "session-xxx",
  "ts": 1793256513477,
  "iso": "2026-10-29T06:48:33.477Z",
  "day": "2026-10-29",
  "role": "user",
  "text": "帮我构思一个 app…",
  "turn": 1,
  "seq": 8
}
```

## 已实现的清洗

DSH 会在会话里注入大量非用户内容，M1 实测并过滤了：

| 注入形态 | 处理 |
|---|---|
| `<system-reminder>…</system-reminder>` | 去掉标签块 |
| `Current runtime context. …` | 整条丢弃 |
| `Time sampled while preparing turn …` | 整条丢弃（实测 80 条） |
| `background job xxx … finished …` | 整条丢弃（实测 35 条） |
| `Team message from …` | 整条丢弃 |
| `# AGENTS.md` 工作区说明 | 整条丢弃 |
| assistant 的 `reasoning` | 只取 `type=text` |

## 来源适配

- **DSH**：`~/.dsh/sessions/<项目>/<会话>/session.v4.jsonl.zstd`，用 `zstd -dc` 流式读
- **Claude Code**：`~/.claude/projects/**/*.jsonl`
- **Codex**：`~/.codex/sessions/**/rollout-*.jsonl`

当前项目只命中了 DSH（Claude/Codex 的会话目录不在这个项目下），符合预期。

## 下一步（M2）

- 规则抽取候选：承诺 / 偏好 / 决定 / 更正
- 生成 `cards.jsonl` + `graph.json`，让球上出现真实记忆

## M2（规则抽取 + 构图）

```bash
node tools/extract-rules.mjs   # -> data/cards.jsonl + data/cards-review.md
node tools/build-graph.mjs     # -> memory/bundle.json + ../memory-galaxy/data.js
```

页面会优先加载 `memory-galaxy/data.js`（真实数据）；把它的内容改成
`window.__MEMORY__ = null;` 即可回退到 mock。

产出：60 张候选卡（decision 37 / event 21 / commitment 1 / preference 1），
3 天、79 节点、85 连线。人工核对清单在 `data/cards-review.md`。

## M3（LLM 抽取）

```bash
# 默认本机 Ollama（qwen2.5:3b），零成本
node tools/extract-llm.mjs --batch 8

# 可切 OpenAI 兼容接口（DeepSeek）
# node tools/extract-llm.mjs --provider openai --base-url https://api.deepseek.com \
#   --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
```

输出：`data/cards-llm.jsonl`，并与规则卡合并成 `data/cards.jsonl`；
人工核对清单：`data/cards-review-merged.md`。
本机实测：321 轮 → 39 批 → 28 张 LLM 卡，合并后 88 张。

## M4（后处理 + 评估）

```bash
node tools/postprocess.mjs   # 状态/时间修正、去重、合并日常种子
node tools/eval.mjs          # 金标评估（data/golden.json）
```

日常种子：`memory/daily-seed.json`（手动可编辑/删除）。

## 增量 / 自动化（M5）

```bash
# 手动增量（只对新增轮次调 LLM）
node tools/ingest.mjs --days 2 --provider deepseek \
  --api-key-file /Users/du/wwwdata/deepseek.txt

# 每日 03:10 自动跑（launchd）
cp memory/com.du.memory-ingest.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.du.memory-ingest.plist
```

状态：`data/llm-processed.json`、`data/ingest-state.json`。

## 体量探测

```bash
# 只归一化、不出卡，不会影响主数据集
node tools/normalize.mjs --projects /Users/du/wwwdata/zgi-console --days 7 --out-dir data-probe
```

实测 zgi-console 7 天：36 会话 / 544 轮 / 7260 条原始消息。

> 默认范围（2026-10-29 起）：`突如其来` + `其他` + `zgi-console`。

## 安全与密钥

```bash
# key 从环境变量文件读取（600 权限）
# ~/.config/memory-ingest/env 里写：export DEEPSEEK_API_KEY=...
source ~/.config/memory-ingest/env

# 脱敏（已固化进 ingest，也可手动跑）
node tools/redact.mjs --apply
node tools/scan-secrets.mjs
```

`data/`、`memory/bundle.json`、`graph.json` 含隐私，已在 `.gitignore` 排除。
