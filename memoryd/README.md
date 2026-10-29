# memoryd · 本地记忆服务（W1 只读 + W2 写回）

> 面向使用者的总说明见仓库根 [README.md](../README.md)；本文是接口/接入/安全/测试的技术参考。

把 `memory-ingest` 产出的记忆卡片变成 agent 可查、可写的本地服务：

- **HTTP/JSON（读）**：`/health` `/today` `/profile` `/recall` `/context` `/graph`，顺带托管 `memory-galaxy` 双球页面
- **页面（W2b）**：由 memoryd 托管时 `/graph` 与 `/data.js` 自动合并 agent 卡；双球页顶栏新增"写入记录"面板与"待确认"审核入口，左侧首屏新增"今日"卡片（到期/逾期/未完成待办/今日要点，可点定位，60s 刷新）；列表行 hover 可完成/忘记；搜索接 `/recall`（离线回退本地子串）；顶栏「筛选」支持项目/分类/类型/时间；底部时间轴 scrubber（日期高亮、←/→、Enter 定位）；节点形状编码（承诺=环、事实=圆、事件=方、决定=菱形）；顶部状态条显示 memoryd 异常/数据过期；含 1280/900 响应式与 `prefers-reduced-motion`
- **HTTP/JSON（写，W2）**：`POST /inbox` `/consolidate` `/feedback` `/review/:id/approve|reject`；读队列 `/inbox/recent` `/review` `/writes/recent`
- **MCP stdio**：读 `memory_recall` / `memory_today` / `memory_profile` / `memory_context`；写 `memory_note` / `memory_feedback`
- **注入器**：`build_context(budget=2000)`，persona + 画像 + 今天 + 相关记忆，受字符/token 双闸约束
- **W3 运维**：提醒队列（默认只入队，可选系统通知）、launchd 常驻（默认 dry-run）、`npm pack` 自测（不发布）、JSONL export/import

约束：零依赖（Node 20+ ESM，无 npm install）、不调用任何 LLM（不需要 API key）、默认只绑 `127.0.0.1`。
**写入不碰基座文件**：全部落在 `memoryd/data/` 的 overlay（可整层删除回滚）；基座 `cards.jsonl` 只在 03:10 由原管线重写。
写接口是本机信任模型（无鉴权），`source.agent` 只用于隔离/审计，不作为安全边界。

## 快速开始

```bash
cd /Users/du/Documents/突如其来/memoryd

node bin/memoryd.mjs doctor      # 自检：数据/权限/计数/预算/新鲜度/overlay
node bin/memoryd.mjs serve       # HTTP 服务 http://127.0.0.1:7788/（含双球页面 + 后台 consolidator）
node bin/memoryd.mjs mcp         # MCP stdio（给 DSH / Claude Code 用）
node bin/memoryd.mjs context --q "我在可视化上有什么偏好？" --budget 2000
node bin/memoryd.mjs context --q 体检 --json

# W2 写入
node bin/memoryd.mjs inbox --kind commitment --text "下周三前把报告发给 du" --agent manual
node bin/memoryd.mjs consolidate
node bin/memoryd.mjs feedback --action done --target ac_xxx

# W3 运维
node bin/memoryd.mjs remind --dry-run          # 看今天会提醒什么（不写、不通知）
node bin/memoryd.mjs remind --notify           # 跑一次提醒 + 系统通知（首次需授权）
node bin/memoryd.mjs install                   # 只打印 launchd plist
node bin/memoryd.mjs install --yes             # 安装并启动常驻服务（写 ~/Library/LaunchAgents）
node bin/memoryd.mjs status                    # launchd + /health 状态
node bin/memoryd.mjs export --no-base --out /tmp/memoryd-overlay.jsonl   # 只导 overlay
node bin/memoryd.mjs import /tmp/memoryd-overlay.jsonl --yes             # 导入（默认 dry-run）

curl -s '127.0.0.1:7788/recall?q=还有哪些待办&k=5' | python3 -m json.tool
curl -s '127.0.0.1:7788/today' | python3 -m json.tool
curl -s -X POST 127.0.0.1:7788/inbox -H 'Content-Type: application/json' \
  -d '{"kind":"commitment","text":"下周三前把报告发给 du","source":{"agent":"manual"}}'
```

选项：`--port` `--host` `--root` `--budget` `--k` `--q` `--date` `--json` `--kind` `--text` `--agent` `--action` `--target` `--consolidate-ms` `--max-per-day` `--max-per-minute` `--max-text-chars` `--out` `--no-base` `--yes` `--now` `--notify` `--dry-run` `--remind-ms` `--quiet-start` `--quiet-end` `--max-notify`；
环境变量 `MEMORYD_PORT` / `MEMORYD_HOST` / `MEMORYD_ROOT` / `MEMORYD_CONSOLIDATE_MS` / `MEMORYD_MAX_PER_DAY` / `MEMORYD_MAX_PER_MINUTE` / `MEMORYD_MAX_TEXT_CHARS` / `MEMORYD_REMIND_MS` / `MEMORYD_NOTIFY` / `MEMORYD_QUIET_START` / `MEMORYD_QUIET_END` / `MEMORYD_MAX_NOTIFY`。

## 数据源

| 文件 | 用途 |
|---|---|
| `memory-ingest/data/cards.jsonl` | 卡片（622 张，03:10 由现管线重写） |
| `memory-ingest/memory/bundle.json` | 页面 bundle（= `graph.json`），`/graph` 原样返回 |
| `memory-galaxy/` | 静态托管；页面仍从 `<script src="data.js">` 加载，但由 memoryd 托管时 `/data.js` 返回**合并后的页面数据** |

请求前节流检查文件 mtime/size（500ms），变了就重建内存索引；**解析失败保留旧索引**，`/health` 里 `status=degraded`、`lastError` 会说明。数据超过 26h 未更新时 `/health`、`/today` 标 `stale`。

### W2 写入层（overlay，全部在 `memoryd/data/`，已 gitignore、700/600）

| 文件 | 用途 |
|---|---|
| `inbox/YYYY-MM-DD.jsonl` | 原始 note（append-only，含 agent/会话/时间） |
| `cards-agent.jsonl` | consolidator 生成的 agent 卡（id `ac_*`，字段对齐基座卡） |
| `review.jsonl` | 待确认/已决策（correction / 低置信 / 疑似重复） |
| `feedback.jsonl` | done / forget / undo / pin（append-only） |
| `state.json` | 幂等表、每日计数、consolidator 游标/元信息 |
| `consolidator.lock/` | 单实例锁（运行时，自动清理） |

读视图 = 基座 cards + `cards-agent` − 墓碑（按 card_id / note_id），基座卡与 agent 卡同 `type+文本` 时**基座优先**。
`/recall` `/today` `/context` `/graph` `/data.js` 用合并视图（`include_agent=0` 可只看基座）；`/profile` 仍只反映基座（画像不自动改）。

## HTTP 接口

统一信封：成功 `{"ok":true,"data":…}`；失败 `{"ok":false,"error":{"code","message"}}`。
只支持 `GET/HEAD`（其它 405）；无 CORS 头；Host 必须是 `127.0.0.1`/`localhost`（否则 403）。

| 接口 | 参数 | 说明 |
|---|---|---|
| `/health` | — | 计数、数据新鲜度、索引耗时；数据不可用 503 |
| `/today` | `date` `limit` | 到期/逾期/未完成待办/今日要点 + 计数 |
| `/profile` | — | persona、画像、主题/实体计数、统计 |
| `/recall` | `q` `from` `to` `topic` `entity` `type` `cat` `k` `include_source` | 混合检索，返回 `total/items/understood/tookMs` |
| `/context` | `q` `budget` `date` | 注入文本 + `chars/estTokens/sections` |
| `/graph` | `include_agent=0?` | 无 agent 卡且无卡片级写回（done/pin/forget）时与 `bundle.json` 逐字节一致；否则返回合并 bundle（含 overlay 状态，agent 卡带 `agent:true`），`include_agent=0` 强制基座；带 ETag/304 |
| `/data.js` | `include_agent=0?` | 由 memoryd 动态生成的页面数据（`window.__MEMORY__ = …`）：无 agent 卡且无卡片级写回时与磁盘 `data.js` 完全一致；否则为合并 bundle（页面回显完成/置顶/忘记） |
| `/reminders` | `date?` | 提醒队列（digest / overdue / due_today）与计数；由 serve 定时器或 `memoryd remind` 生成 |
| `/` 及静态 | — | `memory-galaxy/` 文件，禁目录列表/禁越界 |

### 写接口（W2，仅 POST，返回 `{"ok":true,"data":…}`）

| 接口 | 请求体 | 说明 |
|---|---|---|
| `POST /inbox` | `{kind,text,source:{agent,session?},ts?,idempotency_key?}` | 校验+脱敏+幂等+限流 → 追加 inbox，202 返回 `note_id/deduped`；高危凭据 400 `SECRET_REJECTED`，超限 429 |
| `POST /consolidate` | `{}` | 立即跑一次整理（单实例锁；定时器默认 2 分钟） |
| `POST /feedback` | `{action:"done"\|"forget"\|"undo"\|"pin", target:"c_/ac_/n_", agent?}` | 完成承诺/遗忘卡/撤销笔记/置顶 |
| `POST /review/:id/approve` | `{}` | 批准 → 生成 `ac_*` 卡 |
| `POST /review/:id/reject` | `{}` | 拒绝 → 记 undo，之后重跑不复活 |
| `GET /inbox/recent?limit=20` | — | 最近写入及状态（consolidated/review/noop/undone） |
| `GET /review?status=pending\|all` | — | 待确认队列 |
| `GET /writes/recent?limit=20` | — | 最近 agent 卡（含 hidden/done/pinned） |

`/today` 口径：`due` = `due_at==date` 且 pending；`overdue` = `due_at<date` 且 pending；`pending` = 无 due 的 pending 承诺按创建时间倒序；`highlights` = 当天卡片按 decision/preference/correction 优先。注意 `due_at` 在未来的承诺不落入这三块（既不 due 也不 overdue、也不是"无 due"）。

## 检索行为（`/recall`、`memory_recall`）

1. **日期解析**：今天/昨天/前天/明天、`YYYY-MM-DD`、`M月D日`、本周/上周、最近 N 天 → `from/to`
2. **意图映射**：偏好→preference；待办/没做完/答应→commitment+pending；决定/拍板→decision；更正→correction；是什么→fact
3. **主题/实体自动识别**：查询命中 15 个主题或 8 个实体名时自动过滤
4. **关键词**：剩余内容词切 CJK bigram + 拉丁词，BM25-lite + 短语加分
5. **相关性门槛**：内容词按 idf 加权 + 命中连续片段长度/查询长度取最大值，<35% 视为不相关；只命中一个常见词或长句里的一个短词都不算（加空格也绕不过去）
6. **降级**：纯意图查询（如只有"待办"）→ 在该类型内按时间倒序；有日期/主题/实体这类强结构线索时，内容词没命中也在结构内回退（**所以"昨天火星计划"会返回当天的卡，这是规则内行为**）；只有"偏好"这类意图且关键词 0 命中 → 返回空（不拿无关卡片冒充，避免编造）
7. **参数校验**：`from/to/date` 必须是真实存在的日历日（`2026-02-30`、`2026-13-01` → 400），不是只对格式
8. 过滤条件对不上时逐级放宽（先丢 status、再丢 type…），但只在确实有记录时给结果

## MCP 接入

服务端固定回 `protocolVersion=2025-06-18`（legacy 语义，DSH 内置 SDK 与 Claude Code 均支持），工具在客户端里显示为 `mcp__<serverName>__<tool>`。

### Claude Code

```bash
cd /Users/du/Documents/突如其来
claude mcp add -s project memoryd -- node /Users/du/Documents/突如其来/memoryd/bin/memoryd.mjs mcp
claude mcp list        # 首次会显示 Pending approval，需要进交互式 claude 点一次批准
```

### DSH（`@deepseek-ai/dsh-mcp-client`）

追加到 `~/.dsh/cordis.patch.yml`（全 profile）或 `~/.dsh/profiles/<name>/cordis.patch.yml`，**不要覆盖已有内容**：

```yaml
- insert:
    - id: mcp-memoryd
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: node
        args: ['/Users/du/Documents/突如其来/memoryd/bin/memoryd.mjs', 'mcp']
        cwd: /Users/du/Documents/突如其来
```

改完重启 DSH；模型工具列表里应出现 `mcp__memory__memory_recall` 等 7 个工具（`memory_recall/today/profile/context/reminders/note/feedback`）。服务器 `instructions` 会提示模型"涉及过往偏好/决定/待办时先查记忆；用户明确要求记住时调用 memory_note"。

> **本机现状（2026-10-29）**：已接入 `~/.dsh/profiles/desktop/cordis.patch.yml`（desktop profile，热加载生效）；`command` 使用 node 绝对路径（nvm），升级 node 后需同步修改。备份文件在同一目录 `cordis.patch.yml.bak-*`。

## 注入预算

`build_context(budget=2000)` 分四段：persona(600) + 画像(400) + 今天(300) + 相关记忆(700)，**字符上限 + 估算 token 双闸**：
- 估算器：CJK 1 字≈1 token，其它 0.25；不引入 tokenizer、不把内容发到远端计数
- 超预算时按"相关记忆 → 今天 → 画像"顺序从尾部删行/截断
- 实测典型值 500–1000 字 / 350–650 估算 token

## 安全

- 基座只读：`cards.jsonl`/`bundle.json` 从不写入；写操作只落 `memoryd/data/` overlay（700/600），删 overlay 即回滚
- 只绑 `127.0.0.1`，Host 白名单，防 DNS rebinding；不发 CORS 头
- 写接口无鉴权（本机信任模型）；`source.agent` 只做隔离/审计，可被伪造，**不当作安全边界**
- 脱敏：`sk-`/Bearer/密码/token 类直接 400 拒绝且不落盘；邮箱/内网 IP/手机替换为 `[已脱敏]`；规则单一来源在 `memoryd/src/redact-rules.mjs`（`memory-ingest/tools/redact.mjs` 反向引用，行为逐字节验证一致）
- 提醒：默认只写队列；`--notify` 才调 macOS `osascript`（首次需系统授权）；静默 22–08、每日上限 5 条、同卡当天一次
- 导出：JSONL 文件 600、默认放 `memoryd/data/`（gitignore）；导出前做凭据扫描，命中则拒绝；导入只增不改、默认 dry-run
- 日志只记 method/path/状态/耗时，**不记查询词、笔记与卡片正文**
- 不读 `~/.config/memory-ingest/env`，不调用 DeepSeek；W1/W2 都不需要任何密钥
- note 是数据不是指令：recall 只返回纯文本，注入器只拼固定段落；MCP 工具描述限定"只记用户明确要求的事"
- 静态托管有路径穿越防护（只服务 `memory-galaxy/` 内文件）

## 测试与验收

```bash
node test/smoke.mjs        # 52 项：接口 schema、只读 sha256、405/403/穿越、日期解析与合法性、无关问题返回空（含空格绕过）、小预算不谎报
node test/eval-recall.mjs  # 20 问召回（真实数据，≥80%），报告写 data/eval-report.json
node test/bench.mjs        # HTTP 混合 200 次，p95<200ms，报告写 data/bench.json
node test/mcp-smoke.mjs    # MCP 握手/6 工具/错误路径（临时 root）
node test/write-smoke.mjs  # W2：写入/幂等/consolidator/review/撤销/护栏/脱敏/并发/重启/共存（临时 root）
node test/ui-check.mjs     # W2b：页面标记/内联脚本语法//data.js 与 /graph 合并/ETag（临时 root）
node test/ops-smoke.mjs    # W3：提醒/launchd dry-run/npm pack/export-import（临时 root；不装服务、不弹通知、不发包）
```

W1 验收见 `REPORT-W1.md`，W2 见 `REPORT-W2.md`，W2b 见 `REPORT-W2b.md`，W3 见 `REPORT-W3.md`。
打包：`memoryd/package.json` 已就绪（零依赖、`files` 白名单、`private:true`），`npm pack` 可自测，**未发布**；解包后需 `--root`/`MEMORYD_ROOT` 指向含 `memory-ingest/` 的仓库根。

评测题目运行时从本地数据生成（7 时间 + 4 偏好 + 2 待办 + 2 决定 + 4 实体 + 1 关键词，另含 1 条负样本），只落盘 id/日期/计数，不落盘卡片正文。

## 已知限制 / 下一步

- 页面"写入记录"面板 W2b 已做（`/graph`/`/data.js` 合并 + 撤销/忘记）；但**浏览器渲染与交互需人工复测**：`serve` 后打开 `http://127.0.0.1:7788/` → 点"写入记录"→ 撤销 → 刷新后卡片消失
- 6 张 `manual-seed` 卡的 id 是 `seed_*`，`/feedback` 只接受 `c_/ac_/n_` 前缀，页面写按钮对它们禁用并提示「种子卡暂不支持写回」
- 用 `file://` 直接打开 `memory-galaxy/index.html` 时仍是基座数据，写入面板只给提示（没有服务可调用）
- review 已有页面入口：顶栏「待确认 N」→ 弹窗批准/拒绝（走 `GET /review` + `POST /review/:id/approve|reject`）；暂无批量操作/筛选
- inbox 未做 90 天归档；分钟级限流在内存里（重启清零），每日计数已持久化
- consolidator 崩溃窗口最多重处理最后一条（确定性 `ac_` id + 幂等保证不重复）
- launchd 默认未安装（`install --yes` 才写 `~/Library/LaunchAgents`）；本机 node 在 nvm 下，升级 node 后需重跑 `install --yes`
- 系统通知需 macOS 授权；未授权时 `--notify` 静默失败（队列照写）；提醒数据稀疏，初期大多只有摘要
- 打包只自测未发布；inbox 未做 90 天归档
- `memory-ingest` 现在依赖同仓 `memoryd/src/*-rules.mjs`（打包需要），单独拷走 `memory-ingest/` 会跑不起来
- 中文用 bigram 近似（无分词依赖），语义检索靠意图+主题+BM25，不走向量
- 安全偏好导致的行为：文本含英文 `token` 字样会被判为高危凭据拒绝入库（宁可错拒）
- 已知局限举例：`记忆系统` 因「记忆」是停用词、只剩「系统」，会命中一张只含「系统」的无关卡（`total=1`）；要修需加主题同义词表（W3）
- 小预算（如 `budget=200`）可能把「相关记忆」整段裁掉，此时文本会写「（预算不足，省略 N 条相关记忆）」并保留 `hits`，不会谎报"无匹配"
- 页面写回（完成/置顶/忘记）为局部更新、不整页刷新；审核批准/撤销仍整页刷新（新增 agent 卡需重建节点）
- 页面「筛选」只作用于卡片/承诺节点，日/主题/实体/画像等结构节点不参与过滤
- 页面搜索优先 `/recall`；`file://` 或接口失败时回退本地子串（无向量语义检索）
- 页面默认「柔光」曝光 0.7（顶部按钮可切回 1.0 原色，偏好存 `localStorage.galaxy.exposure`）；仍觉得亮可在控制台把该值调到 0.3–0.45 后刷新
- 页面交互：画布拖拽只旋转球体，平移用下方方向拖动器；点击优先命中正面节点（按深度加权），背面节点更暗更小；选中节点与关联节点有高亮环 + 更亮标签
- P2 未做：首次引导、完整软刷新（fetch `/graph` 重建节点）；形状编码暂无独立图例
- 前端仍是 `data.js` 静态加载；"页面改 fetch `/graph`"留作 W1b 可选
