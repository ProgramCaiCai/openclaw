#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/openclaw"

cd "$ROOT"

ALREADY_INSTALLED=false
[ -x "$BIN" ] && ALREADY_INSTALLED=true

echo "==> Installing dependencies..."
pnpm install --frozen-lockfile

echo "==> Building..."
pnpm build

if [ "$ALREADY_INSTALLED" = true ]; then
  echo "==> Already installed, skipping onboard."
  echo "Done. openclaw updated."
else
  mkdir -p "$BIN_DIR"
  cat > "$BIN" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "$ROOT/dist/entry.js" "\$@"
EOF
  chmod +x "$BIN"
  echo "==> Installed to $BIN"
  echo "==> Running onboard..."
  "$BIN" onboard
fi
