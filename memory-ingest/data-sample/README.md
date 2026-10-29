# 示例数据（Mock）

- `cards.sample.jsonl`：56 张**虚构**记忆卡，字段与真实的 `memory-ingest/data/cards.jsonl` 完全一致
  （id/type/cat/text/quote/created_at/day/due_at/status/confidence/topics/entities/source）。
- 覆盖 2026-10-22 ~ 2026-10-29，含事件/决定/偏好/事实/更正/承诺，以及「今天到期 / 逾期 / 未来 / 无截止」的示例承诺。
- 用途：克隆仓库后无需真实会话数据，也能体验 `memoryd` 接口与 `memory-galaxy` 页面。

## 用法

```bash
bash scripts/setup-demo.sh          # 复制到 memory-ingest/data/cards.jsonl 并生成 bundle/data.js
cd memoryd && node bin/memoryd.mjs serve
# 打开 http://127.0.0.1:7788/
```

- 脚本不会覆盖已存在的真实数据；确认要覆盖时加 `--force`。
- 想恢复「无数据」状态：删除 `memory-ingest/data/cards.jsonl` 与 `memory-ingest/memory/bundle.json` 即可（这两个路径已在 `.gitignore` 中）。
- 这些数据是演示用的，不含任何真实个人信息；页面中的「今天」按运行当天计算，示例承诺日期固定，可能与运行日期不匹配。
