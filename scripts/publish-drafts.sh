#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
DRAFTS_DIR="$ROOT_DIR/content/drafts"
POSTS_DIR="$ROOT_DIR/content/posts"

if [ ! -d "$DRAFTS_DIR" ]; then
  echo "文件夹不存在: $DRAFTS_DIR"
  exit 1
fi

count=0
for file in "$DRAFTS_DIR"/*.md "$DRAFTS_DIR"/*.markdown "$DRAFTS_DIR"/*; do
  [ -e "$file" ] || continue
  [ -f "$file" ] || continue

  basename="$(basename "$file")"
  echo "发布: $basename"
  mv "$file" "$POSTS_DIR/"
  ((count++))
done

if [ $count -eq 0 ]; then
  echo "没有找到待发布的文件"
else
  echo "已发布 $count 个文件到 $POSTS_DIR"
fi
