#!/data/data/com.termux/files/usr/bin/bash
# 把 dsh-session-sync 装进 web profile。默认只做备份+改写，不动运行中的进程。
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
[ -d "$PROFILE_DIR" ] || { echo "找不到 profile: $PROFILE_DIR"; exit 1; }

cp "$PROFILE_DIR/package.json" "$PROFILE_DIR/package.json.bak-session-sync"
node - "$PROFILE_DIR" "$PLUGIN_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const [profileDir, pluginDir] = process.argv.slice(2);
const file = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dependencies = pkg.dependencies ?? {};
pkg.dependencies['dsh-session-sync'] = 'link:' + pluginDir;
pkg.dsh = pkg.dsh ?? {};
pkg.dsh.profile = pkg.dsh.profile ?? {};
const bundles = (pkg.dsh.profile.bundles ?? []).filter((name) => name !== 'dsh-session-sync');
bundles.push('dsh-session-sync');
pkg.dsh.profile.bundles = bundles;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('profile/package.json updated');
NODE

mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE_DIR/node_modules/dsh-session-sync"
echo "已链接 $PLUGIN_DIR -> $PROFILE_DIR/node_modules/dsh-session-sync"
echo "重启 DSH Web 后，设置里会出现「会话同步」。"
