#!/usr/bin/env bash
# build-frontend.sh — Vite build + build-timestamp injection for wrangler deploy.
# Called by wrangler.toml [build].command so any deploy path (manual OR
# Cloudflare GitHub integration) always bundles the Preact app into public/app/.
set -euo pipefail

echo "[build] Running Vite build..."
npm --prefix frontend run build

echo "[build] Injecting build timestamp into HTML entry points..."
node -e "
const fs = require('fs');
const t = Date.now();
['index','portal','pay','quote'].forEach(n => {
  const f = 'public/app/' + n + '.html';
  const s = fs.readFileSync(f, 'utf8').replace(/<!--build:[0-9]+-->/, '');
  fs.writeFileSync(f, s.replace('</head>', '<!--build:' + t + '--></head>'));
  console.log('[build] Stamped', f, 'with', t);
});
"
echo "[build] Frontend build complete."
