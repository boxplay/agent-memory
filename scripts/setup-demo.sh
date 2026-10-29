#!/usr/bin/env bash
# 一键载入示例数据：克隆仓库后体验页面与服务（不会自动覆盖真实数据）
set -euo pipefail
cd "$(dirname "$0")/.."

SAMPLE="memory-ingest/data-sample/cards.sample.jsonl"
TARGET="memory-ingest/data/cards.jsonl"

if [ ! -f "$SAMPLE" ]; then
  echo "找不到示例数据：$SAMPLE" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js >= 20" >&2
  exit 1
fi
if [ -f "$TARGET" ] && [ "${1:-}" != "--force" ]; then
  echo "已存在 ${TARGET}（可能是你的真实数据），未覆盖。"
  echo "确认要用示例数据覆盖时执行：bash scripts/setup-demo.sh --force"
  exit 1
fi

mkdir -p memory-ingest/data
cp "$SAMPLE" "$TARGET"
echo "已载入示例数据：$(wc -l < "${TARGET}" | tr -d ' ') 张虚构卡片（2026-10-22 ~ 2026-10-29）"

(
  cd memory-ingest
  node tools/build-graph.mjs
)

echo
echo "下一步："
echo "  cd memoryd && node bin/memoryd.mjs serve"
echo "  浏览器打开 http://127.0.0.1:7788/"
