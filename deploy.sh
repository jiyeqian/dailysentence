#!/usr/bin/env bash
#
# 按 commit 生成最小部署载荷 —— 只打包运行时必需的文件。
#
# 本脚本不上传。上传只能由对话里的发布工具完成（它没有 exclude 参数），
# 用法是把工具的 directory 指向本脚本产出的 .deploy/app。
#
# 用的是 git archive <commit>，不是当前工作区 → 部署的一定是提交过、测试过的版本，
# 并发会话改到一半的文件不会混进来。
#
# 用法：
#   bash deploy.sh              # 部署 HEAD
#   bash deploy.sh b9de0b4      # 部署指定 commit（也用来回滚）
#   bash deploy.sh --verify     # 部署后跑，确认线上存档没丢
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGE="$ROOT/.deploy"
APP="$STAGE/app"
URL="https://dailysentence.app.workbuddy.host"

cd "$ROOT"

# ---- --verify：部署后跑一次，确认线上存档没丢 ----
# （不带 data/ 上传的安全前提是沙箱复用；沙箱真被重建时这是唯一能当场发现的办法）
if [[ "${1:-}" == "--verify" ]]; then
  days="$(curl -s -m 20 "$URL/api/archive" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);console.log((j.days||[]).length)}catch(e){console.log("ERR")}})')"
  echo "archive days = $days"
  if [[ "$days" == "ERR" || "$days" == "0" ]]; then
    echo "⚠️ 存档异常，检查沙箱是否被重建"
    exit 1
  fi
  exit 0
fi

# ---- 解析 commit ----
REF="${1:-HEAD}"
if ! SHA="$(git rev-parse --verify --quiet "${REF}^{commit}")"; then
  echo "❌ 找不到 commit：$REF"
  exit 1
fi
echo "commit $(git rev-parse --short "$SHA")  $(git log -1 --format=%s "$SHA")"

if git rev-parse --verify --quiet origin/main >/dev/null; then
  ahead="$(git rev-list --count origin/main.."$SHA")"
  behind="$(git rev-list --count "$SHA"..origin/main)"
  if   [[ "$ahead" != "0" && "$behind" != "0" ]]; then rel="与本地记录的 origin/main 已分叉（领先 $ahead / 落后 $behind）"
  elif [[ "$ahead" != "0" ]]; then rel="比本地记录的 origin/main 领先 $ahead 个提交"
  elif [[ "$behind" != "0" ]]; then rel="比本地记录的 origin/main 落后 $behind 个提交"
  else rel="与本地记录的 origin/main 一致"
  fi
  echo "       $rel"
fi

# ---- 打包 ----
rm -rf "$STAGE"
mkdir -p "$STAGE"
git archive "$SHA" app/server.js app/package.json app/public | tar -x -C "$STAGE"

# ---- 完整性闸门 ----
# git archive 对不存在的路径是静默跳过的：老 commit 的文件结构可能不同，
# 少了 index.html 会「部署成功但页面白屏」，所以必须当场挡住。
for f in server.js public/index.html; do
  if [[ ! -f "$APP/$f" ]]; then
    echo "❌ 载荷缺少 $f（$SHORT 上可能还没这个文件）"
    exit 1
  fi
done

# ---- 未提交改动的提示 ----
dirty="$(git status --porcelain -- app/server.js app/package.json app/public)"
if [[ -n "$dirty" ]]; then
  echo "⚠️  工作区有 $(printf '%s\n' "$dirty" | wc -l | tr -d ' ') 处未提交改动，不包含在本次部署："
  printf '%s\n' "$dirty" | sed 's/^/    /'
fi

echo "payload $(du -sh "$APP" | cut -f1) → $APP"
