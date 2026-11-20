#!/usr/bin/env bash
# Packs the CLI, checks the tarball's file list, installs it into a temp directory and runs it on the demo fixture.
# Its six output files must be byte-identical to the repo's CLI run with the same arguments. The npm package ships no fixtures,
# so it labels any root as a real set: both runs use --dataset real.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
npm pack -w packages/cli --pack-destination "$tmp" --silent >/dev/null
tgz=$(ls "$tmp"/everyturn-*.tgz)
expected="LICENSE
README.md
assets/fonts/inter/Inter-Bold.ttf
assets/fonts/inter/Inter-Medium.ttf
assets/fonts/inter/Inter-Regular.ttf
assets/fonts/inter/Inter-SemiBold.ttf
assets/fonts/inter/OFL.txt
assets/fonts/jetbrains-mono/JetBrainsMonoNL-Medium.ttf
assets/fonts/jetbrains-mono/JetBrainsMonoNL-Regular.ttf
assets/fonts/jetbrains-mono/OFL.txt
dist/everyturn.js
package.json"
actual=$(tar -tzf "$tgz" | sed 's|^package/||' | sort)
if [ "$actual" != "$expected" ]; then echo "pack-check FAIL: unexpected tarball contents"; echo "$actual"; exit 1; fi
mkdir "$tmp/app"
(cd "$tmp/app" && npm init -y >/dev/null && npm install --no-audit --no-fund --silent "$tgz" >/dev/null)
version=$(cd "$tmp/app" && npx --no-install everyturn --version)
want=$(node -p 'require("./packages/cli/package.json").version')
[ "$version" = "$want" ] || { echo "pack-check FAIL: --version printed $version, expected $want"; exit 1; }
(cd "$tmp/app" && npx --no-install everyturn --help | grep -q '^Usage: everyturn') || { echo "pack-check FAIL: --help"; exit 1; }
fixture="$repo/fixtures/demo-repo"
(cd "$tmp/app" && npx --no-install everyturn "$fixture" --agent claude-code --dataset real --out "$tmp/pkg" >/dev/null 2>&1)
(cd "$repo" && node --import tsx packages/cli/src/index.ts "$fixture" --agent claude-code --dataset real --out "$tmp/src" >/dev/null 2>&1)
n=0
for f in everyturn.json everyturn-sources.html everyturn.png everyturn.svg everyturn.source.svg everyturn.html; do
  cmp -s "$tmp/pkg/$f" "$tmp/src/$f" || { echo "pack-check FAIL: $f differs"; exit 1; }
  n=$((n + 1))
done
echo "pack-check PASS ($(basename "$tgz"), 12 files, --version $version, --help ok, $n outputs byte-identical)"
