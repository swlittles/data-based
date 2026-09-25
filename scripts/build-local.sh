#!/usr/bin/env bash
# Signed release build for this machine only (no CI). Produces the same .dmg
# and updater artifacts as the Release workflow, in a few minutes.
# Needs the signing key from RELEASING.md in ~/.tauri.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="$HOME/.tauri/mongo-bongo.key"
PASS="$HOME/.tauri/mongo-bongo.key.password"
if [[ ! -f "$KEY" || ! -f "$PASS" ]]; then
  echo "Missing $KEY or $PASS - see RELEASING.md" >&2
  exit 1
fi

export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PASS")"
npm run tauri build -- "$@"

echo
echo "Bundles:"
find src-tauri/target/release/bundle -maxdepth 2 \( -name "*.dmg" -o -name "*.app" -o -name "*.msi" -o -name "*.exe" -o -name "*.AppImage" -o -name "*.deb" \) -print
