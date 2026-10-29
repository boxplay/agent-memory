# 安全说明

- 本目录下的 `data/`、`memory/` 含从本地会话抽取的内容，**默认被 .gitignore 排除**，不要提交。
- 已执行脱敏：`node tools/redact.mjs --apply`，当前 `scan-secrets` 命中 0。
- 新增/修改抽取规则后，请重新跑 `scan-secrets` 与 `redact --apply`。
- DeepSeek key 不再放在项目里，改为环境变量文件 `~/.config/memory-ingest/env`（600 权限）。
- 开源发布前：清空 data/、memory/bundle.json、graph.json；不要带任何真实会话。
