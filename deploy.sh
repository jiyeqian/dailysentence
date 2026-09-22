#!/usr/bin/env bash
#
# 生成最小部署载荷 —— 只打包运行时必需的文件。
#
# 本脚本不上传。上传只能由对话里的发布工具完成（它没有 exclude 参数），
# 用法是把工具的 directory 指向本脚本产出的 .deploy/app。
#
# 载荷 = server.js + package.json + public/  （约 0.8MB）
# 不含：data/（避免覆盖线上存档）、shots/（52MB 截图）、fixtures/、
#       README.md、parse-check.js / ui-check.js / inspect.js
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$ROOT/.deploy/app"
URL="https://dailysentence.app.workbuddy.host"

rm -rf "$ROOT/.deploy"
mkdir -p "$STAGE"

cp    "$ROOT/app/server.js"    "$STAGE/"
cp    "$ROOT/app/package.json" "$STAGE/"
cp -R "$ROOT/app/public"       "$STAGE/public"
find  "$STAGE" -name '.DS_Store' -delete

echo "payload $(du -sh "$STAGE" | cut -f1) → $STAGE"

# --verify：部署后跑一次，确认线上存档没丢（不带 data 上传的安全前提是沙箱复用）
if [[ "${1:-}" == "--verify" ]]; then
  days="$(curl -s -m 20 "$URL/api/archive" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);console.log((j.days||[]).length)}catch(e){console.log("ERR")}})')"
  echo "archive days = $days"
  if [[ "$days" == "ERR" || "$days" == "0" ]]; then
    echo "⚠️ 存档异常，检查沙箱是否被重建"
    exit 1
  fi
fi
