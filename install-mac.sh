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

if [ "$(uname -m)" != "arm64" ]; then
	echo "Tato aplikace je k dispozici jen pro Apple Silicon (arm64), tvůj Mac je $(uname -m)." >&2
	exit 1
fi

# Stabilní URL bez GitHub API (to má přísný rate limit pro nepřihlášené)
ZIP_URL="https://github.com/$REPO/releases/latest/download/Thermal-Print-arm64-mac.zip"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Stahuji ${ZIP_URL##*/}…"
if ! curl -fL --progress-bar -o "$TMP/app.zip" "$ZIP_URL"; then
	echo "Stažení selhalo — poslední release zřejmě neobsahuje macOS build." >&2
	exit 1
fi
ditto -xk "$TMP/app.zip" "$TMP/extracted"

if [ ! -d "$TMP/extracted/$APP_NAME.app" ]; then
	echo "Archiv neobsahuje $APP_NAME.app." >&2
	exit 1
fi

rm -rf "/Applications/$APP_NAME.app"
mv "$TMP/extracted/$APP_NAME.app" /Applications/

echo "Nainstalováno do /Applications/$APP_NAME.app, spouštím…"
open "/Applications/$APP_NAME.app"
