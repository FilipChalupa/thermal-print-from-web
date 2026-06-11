#!/bin/bash
# Instalace Thermal Print na macOS jedním příkazem:
#
#   curl -fsSL https://raw.githubusercontent.com/FilipChalupa/thermal-print-from-web/main/install-mac.sh | bash
#
# Stažení přes curl (na rozdíl od prohlížeče) nepřidává quarantine atribut,
# takže Gatekeeper appku nezablokuje a není potřeba žádné xattr kouzlení.
set -euo pipefail

REPO="FilipChalupa/thermal-print-from-web"
APP_NAME="Thermal Print"

echo "Hledám poslední verzi…"
ZIP_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
	| grep -oE '"browser_download_url": *"[^"]+arm64-mac\.zip"' \
	| head -n 1 | grep -oE 'https://[^"]+')

if [ -z "$ZIP_URL" ]; then
	echo "V posledním release není macOS build (arm64-mac.zip)." >&2
	exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Stahuji ${ZIP_URL##*/}…"
curl -fL --progress-bar -o "$TMP/app.zip" "$ZIP_URL"
ditto -xk "$TMP/app.zip" "$TMP/extracted"

if [ ! -d "$TMP/extracted/$APP_NAME.app" ]; then
	echo "Archiv neobsahuje $APP_NAME.app." >&2
	exit 1
fi

rm -rf "/Applications/$APP_NAME.app"
mv "$TMP/extracted/$APP_NAME.app" /Applications/

echo "Nainstalováno do /Applications/$APP_NAME.app, spouštím…"
open "/Applications/$APP_NAME.app"
