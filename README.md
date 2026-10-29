# memoryd · 给 Agent 的本地长期记忆

把本机 Agent 会话（DeepSeek Harness / Claude Code / Codex）自动整理成结构化记忆卡，通过 **HTTP + MCP** 提供给 Agent 查询与写入；附带双球可视化、提醒、导出/导入。

**Local-first**：数据只在本机；服务只绑 `127.0.0.1`；默认不联网（只有在你自己开启 LLM 抽取时才会调用你配置的模型接口）。

> 状态：MVP（W1–W3 已完成）。接口/数据格式可能仍会调整。

---

## 特性

- **检索**：按日期、意图（偏好/决定/待办/更正）、主题、实体、关键词混合检索；中文无需分词依赖
- **写入（两段式）**：`note` 先落 inbox 立即返回，后台整理成卡片；可撤销、可完成、可置顶，重跑不复活
- **注入器**：`build_context(budget=2000)` 输出可直接放进上下文的摘要（字符/token 双闸）
- **提醒**：扫描到期/逾期 → 提醒队列；默认只入队，可选系统通知（macOS）
- **可视化**：零依赖单页双球（工作/日常），点节点看关联、搜索、时间线/承诺/主题列表
- **可迁移**：单文件 JSONL 导出/导入（只增不改）
- **零运行时依赖**：Node 标准库实现，不需要 `npm install`

---

## 架构

```
本机会话目录 ──memory-ingest──▶ cards.jsonl / bundle.json ──▶ memory-galaxy（页面）
                                      │
                                      ▼
                              memoryd（127.0.0.1:7788）
                               ├─ HTTP/JSON：/health /today /profile /recall /context /graph /reminders
                               ├─ 写接口：/inbox /consolidate /feedback /review
                               └─ MCP stdio：memory_recall / today / profile / context / reminders / note / feedback
                                      │
                                      ▼
                              DSH / Claude Code / 其他 MCP 客户端
```

目录：

```
.
├─ memory-ingest/   数据管线：扫描本机会话 → 归一化 → 抽取 → 去重/脱敏 → 构图
├─ memoryd/         本地记忆服务：HTTP + MCP + 写入 + 提醒 + 导入导出
├─ memory-galaxy/   双球可视化单页
├─ research/        设计文档（架构、服务形态、各阶段方案；开发用）
├─ README.md        本文件
└─ LICENSE（发布前补）
```

---

## 环境要求

- **Node.js ≥ 20**（开发环境为 24）
- **zstd** 命令行工具（仅解析 DSH 的 `.zstd` 会话时需要；macOS `brew install zstd`，Debian/Ubuntu `apt install zstd`）
- **macOS 或 Linux**；Windows 未验证
- 可选：**DeepSeek API Key** —— 仅用于 `memory-ingest` 的可选 LLM 抽取；`memoryd` 本身不调用任何模型
- 可选：**DSH / Claude Code** 等支持 MCP 的客户端
- macOS 专属：`launchd` 常驻、`osascript` 系统通知；其他平台用你自己的进程管理器（systemd/cron 等）跑 `memoryd serve`

---

## 安装

```bash
# 方式一：git clone（推荐）
git clone <你的仓库地址> memory-system
cd memory-system

# 方式二：下载 zip 解压后进入目录
# cd memory-system

node --version    # 需要 >= 20
# 无需 npm install：零运行时依赖
```

> `<你的仓库地址>` 发布后替换为实际 GitHub 地址。

---

## 第一步：生成记忆数据（memory-ingest）

`memory-ingest` 读取本机这几类 Agent 会话（存在哪个读哪个）：

| 来源 | 默认路径 |
|---|---|
| DSH | `~/.dsh/sessions/**/session.v4.jsonl.zstd` |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` |

### 1. 先跑通（不调用 LLM，零成本）

```bash
cd memory-ingest

node tools/scan.mjs          # 扫描本机会话 → data/inventory.json

# 把 --projects 换成你自己想纳入的目录（逗号分隔，可多个）
node tools/normalize.mjs --projects "$HOME/Documents" --days 7 --merge

node tools/extract-rules.mjs # 规则抽取（承诺/偏好/决定/更正/事件）
node tools/postprocess.mjs   # 状态/截止时间启发式 + 去重
node tools/redact.mjs            # 先 dry-run 看替换数量（不写文件）
node tools/redact.mjs --apply    # 确认后执行脱敏（内部先备份 cards-pre-redact.jsonl）
node tools/scan-secrets.mjs      # 敏感扫描，期望"命中: 0"
node tools/build-graph.mjs       # 生成 memory/bundle.json + memory-galaxy/data.js
```

### 2. 可选：接 LLM 提升召回

规则抽取偏保守，接 DeepSeek 能明显提升语义召回。Key 从环境变量或 600 权限文件读取，**不要写进仓库**：

```bash
cd memory-ingest
export DEEPSEEK_API_KEY=你的key          # 也可用 --api-key-file ~/.config/xxx/key

node tools/extract-llm.mjs \
  --provider openai --base-url https://api.deepseek.com --model deepseek-chat \
  --incremental --batch 10 --out data/cards-llm-deepseek.jsonl

node tools/postprocess.mjs && node tools/redact.mjs --apply && node tools/build-graph.mjs
```

或直接用串好的入口（先 `--skip-llm` 跑通，再去掉）：

```bash
node tools/ingest.mjs --projects "$HOME/Documents" --days 7 --provider deepseek --skip-llm
```

### 3. 每日自动增量（可选）

把上面的 `ingest.mjs` 放进 cron / launchd，每天跑一次即可；`memoryd` 会自动感知基座文件变化并热重载。

产物（默认被 `.gitignore` 排除，**不要提交**）：

```
memory-ingest/data/cards.jsonl
memory-ingest/memory/bundle.json
memory-galaxy/data.js
```

---

## 第二步：启动 memoryd

```bash
cd memoryd

node bin/memoryd.mjs doctor      # 自检：数据文件/权限/计数/依赖/overlay
node bin/memoryd.mjs serve       # 启动服务，默认 127.0.0.1:7788
```

浏览器打开 **http://127.0.0.1:7788/** 即为可视化页面。

常驻（macOS）：

```bash
node bin/memoryd.mjs install            # dry-run：只打印将写入的 launchd plist
node bin/memoryd.mjs install --yes      # 确认后写入 ~/Library/LaunchAgents 并启动
node bin/memoryd.mjs status             # 查看状态
node bin/memoryd.mjs uninstall --yes    # 停用并删除
```

> plist 里会写 **node 绝对路径**（launchd 不继承 shell PATH）。升级 Node 后需要改 plist 或重新 `install --yes`。
> Linux 用户请用 systemd/cron 等方式守护 `node bin/memoryd.mjs serve`。

---

## 第三步：接入 Agent（MCP）

MCP 走 stdio，命令为：

```bash
<node绝对路径> <仓库路径>/memoryd/bin/memoryd.mjs mcp
```

接入后 Agent 会看到 7 个工具（客户端里显示为 `mcp__memory__<tool>`）：
`memory_recall` `memory_today` `memory_profile` `memory_context` `memory_reminders` `memory_note` `memory_feedback`。

### DSH（`@deepseek-ai/dsh-mcp-client`）

把下面加到 `~/.dsh/cordis.patch.yml`（对本机所有 profile 生效）或 `~/.dsh/profiles/<name>/cordis.patch.yml`（单个 profile），然后重启 DSH：

```yaml
- insert:
    - id: mcp-memoryd
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: /absolute/path/to/node          # 用 `command -v node` 的绝对路径
        args: ['/absolute/path/to/memoryd/bin/memoryd.mjs', 'mcp']
        cwd: /absolute/path/to/memory-system
```

> DSH 会清洗名为 `KEY/PASSWORD/SECRET/TOKEN` 及 `DSH_*` 的环境变量；memoryd 不需要任何密钥。

### Claude Code

```bash
cd /absolute/path/to/memory-system
claude mcp add -s project memoryd -- node "$(pwd)/memoryd/bin/memoryd.mjs" mcp
claude mcp list        # 首次需进交互式 claude 批准一次
```

### 其他 MCP 客户端

| 字段 | 值 |
|---|---|
| 传输 | `stdio` |
| command | node 绝对路径 |
| args | `["…/memoryd/bin/memoryd.mjs", "mcp"]` |
| cwd | 仓库根（可选，建议设置） |

---

## 第四步：使用

### 浏览器页面

- 双球/点线关联、搜索（按 `/`）、点节点看详情
- 左上"列表视图"：时间线 / 承诺 / 主题
- 顶栏"写入记录"：查看 Agent 最近写入，可撤销/忘记（需由 memoryd 托管访问）
- 直接打开的 HTML 文件（`file://`）只显示基座数据，不能撤销写入

### 对 Agent 说话（推荐）

| 你说 | Agent 会调用 |
|---|---|
| "我上周做了什么？" / "某天做了什么？" | `memory_recall` |
| "我在某主题上有什么偏好/决定？" | `memory_recall`（意图 + 主题过滤） |
| "今天有什么到期/要做什么？" | `memory_today` + `memory_reminders` |
| "关于某项目/工具有哪些记录？" | `memory_recall`（实体过滤） |
| "记住：周五前把 X 发给 Y" | `memory_note`（≤500 字，异步整理） |
| "那条任务做完了 / 忘掉这条" | `memory_feedback done/forget/undo` |
| "把记忆摘要给我（≤2000 token）" | `memory_context` |

### 命令行 / HTTP

```bash
cd memoryd

# 检索 / 今日 / 画像 / 提醒
curl -sG 127.0.0.1:7788/recall --data-urlencode 'q=我在可视化上有什么偏好' --data 'k=5'
curl -s 127.0.0.1:7788/today
curl -s 127.0.0.1:7788/profile
curl -s 127.0.0.1:7788/reminders
curl -s 127.0.0.1:7788/graph        # 页面数据（有 Agent 写入时合并）

# 写一条记忆（密钥类会被拒收，邮箱/内网 IP/手机号自动替换）
node bin/memoryd.mjs inbox --kind commitment --text "周五前把报告发给对方" --agent manual
node bin/memoryd.mjs consolidate        # 立即整理（默认每 2 分钟自动跑）

# 反馈：done / forget / undo / pin
node bin/memoryd.mjs feedback --action done   --target c_xxx
node bin/memoryd.mjs feedback --action forget --target ac_xxx
node bin/memoryd.mjs feedback --action undo   --target n_xxx
```

HTTP 写接口：`POST /inbox`、`POST /consolidate`、`POST /feedback`、`POST /review/:id/approve|reject`；读接口另外还有 `GET /inbox/recent`、`GET /review`、`GET /writes/recent`。

### 写入 → 整理 → 撤销

1. 写入（Agent 的 `memory_note` / `POST /inbox` / CLI）先落 inbox，立即返回；
2. 后台每 2 分钟整理成卡片（也可手动 `consolidate`）；低置信/correction 进 review；
3. 撤销/忘记后立即从检索与页面消失，**重跑整理不会复活**；
4. 承诺可标记 `done`，`/today` 不再提醒。

### 提醒

- 后台每 30 分钟扫一次当天到期/逾期的承诺，写提醒队列（同卡当天只提醒一次）
- 默认**只写队列不弹通知**；`node bin/memoryd.mjs remind --notify` 手动弹一次
- 静默时段 22:00–08:00；每日通知上限 5 条（均可配置）
- macOS 首次使用通知需在系统设置里授权

### 备份 / 迁移

```bash
node bin/memoryd.mjs export --out ./memory-export.jsonl        # 含基座 + 写入层
node bin/memoryd.mjs export --no-base --out ./overlay.jsonl    # 只导出写入层
node bin/memoryd.mjs import ./memory-export.jsonl              # 默认 dry-run，先看计划
node bin/memoryd.mjs import ./memory-export.jsonl --yes        # 只增不改，只写 overlay
```

导出文件是明文真实记忆（权限 600），注意存放与分享范围。

---

## 配置

优先级：CLI 参数 > 环境变量 > 默认值。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEMORYD_HOST` | `127.0.0.1` | 监听地址（**不建议改**） |
| `MEMORYD_PORT` | `7788` | HTTP 端口 |
| `MEMORYD_ROOT` | 仓库根 | 数据根目录（需包含 `memory-ingest/`） |
| `MEMORYD_CONSOLIDATE_MS` | `120000` | 整理周期 |
| `MEMORYD_MAX_PER_DAY` | `200` | 每日写入上限 |
| `MEMORYD_MAX_PER_MINUTE` | `30` | 单 agent 每分钟写入上限 |
| `MEMORYD_MAX_TEXT_CHARS` | `500` | 单条 note 长度上限 |
| `MEMORYD_REMIND_MS` | `1800000` | 提醒扫描周期 |
| `MEMORYD_NOTIFY` | `0` | 设 `1` 开启后台系统通知（macOS） |
| `MEMORYD_QUIET_START` / `MEMORYD_QUIET_END` | `22` / `8` | 静默时段（小时） |
| `MEMORYD_MAX_NOTIFY` | `5` | 每日通知上限 |

CLI 参数同名：`--port --host --root --consolidate-ms --max-per-day --max-per-minute --max-text-chars --remind-ms --notify --quiet-start --quiet-end --max-notify`。

---

## 数据与隐私

| 层 | 位置 | 说明 |
|---|---|---|
| 基座（只读） | `memory-ingest/data/cards.jsonl`、`memory-ingest/memory/bundle.json` | 由 ingest 全量重建；memoryd 从不写入 |
| 写入层 overlay | `memoryd/data/`（`inbox/` `cards-agent.jsonl` `review.jsonl` `feedback.jsonl` `state.json` `reminders/`） | append-only；删掉即回滚到只读快照 |
| 页面数据 | `memory-galaxy/` | 由 memoryd 动态合并 Agent 卡后提供 |

- 默认只绑 `127.0.0.1`；**无鉴权**（本机信任模型），不要把服务暴露到 `0.0.0.0`
- 写入时高危凭据（`sk-`/Bearer/密码/token 类）直接拒绝、不落盘；PII（邮箱/内网 IP/手机号）替换为 `[已脱敏]`
- 日志只记 method/path/耗时，不记查询词和卡片正文
- 所有真实数据默认被 `.gitignore` 排除；**提交/发布前确认 `data/`、`bundle.json`、`graph.json` 未入库**
- 启用 LLM 抽取时，会话片段会发送到你配置的模型服务商；不需要 LLM 时 `memoryd` 全程离线

---

## 开发与测试

```bash
cd memoryd
npm test        # 依次跑：smoke / eval / bench / mcp / write / ui / ops
```

- 测试**依赖一份已生成的基座数据**（先完成上面的 ingest 步骤），否则 smoke/eval 等会因缺数据失败
- 单元/集成覆盖：接口 schema、只读 sha256、检索评测（20 问）、延迟 p95、MCP 协议、写入/撤销/幂等、页面合并、提醒/打包/导入导出
- 评测题由本地数据生成，只落盘 id/计数，不落盘卡片正文

打包自测（尚未发布到 npm）：

```bash
cd memoryd
npm pack --dry-run     # 检查进入包的文件（只含 bin/src/README）
npm pack               # 生成 memoryd-x.y.z.tgz
npm install -g ./memoryd-x.y.z.tgz
memoryd help
```

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `doctor` 报数据不可用 | 先跑 `memory-ingest` 生成 `data/cards.jsonl` 与 `memory/bundle.json` |
| Agent 看不到 `mcp__memory__*` 工具 | 检查 MCP 配置里的 node/入口是否绝对路径存在、cwd 是否正确；重启客户端 |
| 写入后搜不到 | 等 ≤2 分钟或手动 `consolidate`；用 `GET /inbox/recent` 看状态 |
| 通知不弹 | 默认关闭；`remind --notify` 手动；macOS 系统设置授权；静默时段/每日上限 |
| 提醒几乎为空 | 只有带 `due_at` 的 pending 承诺会提醒；可在 ingest/整理后补充截止时间 |
| 升级 Node 后服务起不来 | 改 launchd plist 与 MCP 配置里的 node 绝对路径，重新 `install --yes` |
| 端口被占用 | `serve --port 7790`（同时更新你的访问地址） |
| 想重置写入层 | 删除 `memoryd/data/` 下的 overlay 文件（先 `export` 备份） |

---

## 路线图

- review 队列 Web UI、inbox 归档、失败告警
- `npx memoryd` 正式发布、Docker 镜像、多平台支持（Windows）
- 检索质量：同义词/主题扩展、人工金标题库

## License

MIT（发布前补充 `LICENSE` 文件）。
