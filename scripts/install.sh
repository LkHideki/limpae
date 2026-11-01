#!/usr/bin/env bash
# Builds Limpae and installs it into ~/Applications, registering it with
# LaunchServices and Spotlight so it shows up in Spotlight and Launchpad.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Limpae"
BUNDLE_ID="br.com.limpae"
DEST_DIR="$HOME/Applications"
DEST="$DEST_DIR/$APP_NAME.app"
SRC="target/release/bundle/macos/$APP_NAME.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

if ! cargo tauri --version >/dev/null 2>&1; then
    echo "tauri-cli not found. Install it with: cargo install tauri-cli --version '^2' --locked" >&2
    exit 1
fi

cargo tauri build --bundles app

# The bundle is signed ad hoc, and macOS ties privacy grants (Full Disk Access) to an ad-hoc signature's hash,
# so every rebuild would need a new grant. If a local code-signing identity exists, re-sign with it: the
# designated requirement becomes "bundle id + certificate", which survives rebuilds. Override with
# LIMPAE_SIGN_IDENTITY; the default name matches the README's instructions.
SIGN_IDENTITY="${LIMPAE_SIGN_IDENTITY:-Limpae Local}"
if security find-identity -p codesigning | grep -q "\"$SIGN_IDENTITY\""; then
    codesign --force --deep --sign "$SIGN_IDENTITY" --entitlements src-tauri/Entitlements.plist "$SRC"
    echo "Signed with \"$SIGN_IDENTITY\"."
fi

# A running copy keeps the old binary mapped; ask it to quit before replacing.
pkill -x limpae 2>/dev/null && sleep 1 || true

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
ditto "$SRC" "$DEST"

"$LSREGISTER" -f "$DEST"
mdimport "$DEST"

for _ in $(seq 1 30); do
    if mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'" | grep -qx "$DEST"; then
        echo "Installed at $DEST and indexed by Spotlight."
        exit 0
    fi
    sleep 1
done

echo "Installed at $DEST, but Spotlight has not indexed it yet (check 'mdutil -s /')." >&2
exit 2
