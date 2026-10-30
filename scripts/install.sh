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
    echo "tauri-cli não encontrado. Instale com: cargo install tauri-cli --version '^2' --locked" >&2
    exit 1
fi

cargo tauri build --bundles app

# A running copy keeps the old binary mapped; ask it to quit before replacing.
pkill -x limpae 2>/dev/null && sleep 1 || true

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
ditto "$SRC" "$DEST"

"$LSREGISTER" -f "$DEST"
mdimport "$DEST"

for _ in $(seq 1 30); do
    if mdfind "kMDItemCFBundleIdentifier == '$BUNDLE_ID'" | grep -qx "$DEST"; then
        echo "Instalado em $DEST e indexado pelo Spotlight."
        exit 0
    fi
    sleep 1
done

echo "Instalado em $DEST, mas o Spotlight ainda não indexou (verifique 'mdutil -s /')." >&2
exit 2
