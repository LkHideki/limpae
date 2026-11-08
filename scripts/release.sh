#!/usr/bin/env bash
# Builds a distributable Limpae-<version>.dmg in dist/.
#
# Without credentials the app is signed ad hoc: fine for testing, but Gatekeeper blocks it on other Macs. For a
# release that opens anywhere, set:
#   LIMPAE_DEVELOPER_ID    "Developer ID Application: Your Name (TEAMID)" (in the login keychain)
#   LIMPAE_NOTARY_PROFILE  a notarytool keychain profile, created once with
#                          xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <TEAMID>
# The script signs with the hardened runtime, notarizes, staples and verifies with Gatekeeper; any failure stops it.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="Limpae"
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' src-tauri/tauri.conf.json | head -n1)"
APP="target/release/bundle/macos/$APP_NAME.app"
OUT_DIR="dist"
DMG="$OUT_DIR/$APP_NAME-$VERSION.dmg"
ENTITLEMENTS="src-tauri/Entitlements.plist"
IDENTITY="${LIMPAE_DEVELOPER_ID:-}"
PROFILE="${LIMPAE_NOTARY_PROFILE:-}"

[ -n "$VERSION" ] || { echo "Could not read the version from tauri.conf.json." >&2; exit 1; }
if ! cargo tauri --version >/dev/null 2>&1; then
    echo "tauri-cli not found. Install it with: cargo install tauri-cli --version '^2' --locked" >&2
    exit 1
fi
if [ -n "$PROFILE" ] && [ -z "$IDENTITY" ]; then
    echo "LIMPAE_NOTARY_PROFILE needs LIMPAE_DEVELOPER_ID: Apple only notarizes Developer ID signatures." >&2
    exit 1
fi

cargo tauri build --bundles app

if [ -n "$IDENTITY" ]; then
    # Hardened runtime + secure timestamp are both required for notarization.
    codesign --force --deep --options runtime --timestamp --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
    codesign --verify --deep --strict --verbose=2 "$APP"
else
    echo "warning: no LIMPAE_DEVELOPER_ID; signing ad hoc. Other Macs will refuse to open this build." >&2
    codesign --force --deep --entitlements "$ENTITLEMENTS" --sign - "$APP"
fi

# A plain drag-to-install image: the app next to a link to /Applications.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"
mkdir -p "$OUT_DIR"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

if [ -n "$IDENTITY" ]; then
    codesign --force --timestamp --sign "$IDENTITY" "$DMG"
fi
if [ -n "$PROFILE" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
fi

(cd "$OUT_DIR" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")
echo "Built $DMG"
cat "$DMG.sha256"
