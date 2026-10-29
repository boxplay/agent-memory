#!/bin/bash
# 每日增量摄取（launchd / cron 调用）
set -e
cd "$(dirname "$0")"

# DeepSeek key 从 600 权限的环境变量文件加载
[ -f "$HOME/.config/memory-ingest/env" ] && . "$HOME/.config/memory-ingest/env"

node tools/ingest.mjs --days 2 --provider deepseek \
  --projects "/Users/du/Documents/突如其来,/Users/du/Documents/其他,/Users/du/wwwdata/zgi-console"
