#!/usr/bin/env bash
set -euo pipefail
# Run manually from the repo root after recording the changes in HEAD.
check_dir="$(mktemp -d)"
trap 'rm -rf "$check_dir"' EXIT
git clone --no-local . "$check_dir/repo"
cd "$check_dir/repo"
npm ci --ignore-scripts --prefer-offline
npm run gate
