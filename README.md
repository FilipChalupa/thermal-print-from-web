# kilomayo-print

Webová aplikace pro tisk obrázků na termální tiskárně Epson přes ESC/POS protokol.

## Stack

- **Frontend:** React + Vite (TypeScript)
- **Backend:** Hono (Node.js, TypeScript)
- **Tisk:** ESC/POS přes TCP, Floyd-Steinberg dithering pomocí skia-canvas

## Funkce

- Zadání IP adresy tiskárny
- Nahrání obrázku s náhledem
- Volitelný počet výtisků (výchozí 1), po každém výtisku automatický cut

## Síťová tiskárna bez ovladačů (AirPrint / IPP Everywhere)

Kromě webu se aplikace v lokální síti tváří jako **běžná tiskárna**, takže jde tisknout z jakékoli aplikace přes `Cmd/Ctrl+P` — bez instalace ovladače na Windows, macOS i Linuxu.

Jak to funguje:

- Server se ohlašuje přes **mDNS/Bonjour** (`_ipp._tcp`, včetně AirPrint subtypu `_universal`), takže ho OS sám najde a nabídne přidání.
- Implementuje **IPP** server (RFC 8011 + IPP Everywhere): `Get-Printer-Attributes`, `Validate-Job`, `Print-Job`, `Create-Job`/`Send-Document`, `Get-Jobs`, `Cancel-Job`.
- OS pošle stránku jako **PWG Raster** (`image/pwg-raster`) nebo **Apple Raster / URF** (`image/urf`). Ta se dekóduje, přeškáluje na šířku tiskárny (576 dotů / 80 mm role, 203 dpi), Floyd–Steinberg dither a odešle jako ESC/POS na fyzickou tiskárnu.

Cíl (IP fyzické termální tiskárny) se nastaví jednou ve webovém UI (pole *IP adresa tiskárny*) — uloží se do konfigurace serveru a použije se pro všechny síťové tisky. Pole IP navíc **automaticky napovídá** tiskárny nalezené v síti (mDNS `_pdl-datastream._tcp` + sken portu 9100 po lokálním /24); rozsah skenu lze přebít přes `THERMAL_DISCOVERY_HOSTS`. Konfigurace se ukládá do `~/.thermal-print-config.json` (lze změnit přes `THERMAL_CONFIG_PATH`).

Relevantní proměnné prostředí:

- `IPP_PORT` — port IPP serveru (výchozí `6310`; do sítě se stejně ohlašuje přes mDNS, takže na konkrétní hodnotě nezáleží)
- `PRINTER_IP`, `PRINTER_NAME` — výchozí cílová IP a jméno tiskárny v síti

> Při prvním spuštění může Windows/macOS firewall vyžádat povolení příchozích spojení (IPP port + mDNS). IPP server naslouchá na `0.0.0.0`, samotné webové UI zůstává jen na loopbacku.

## Požadavky

- Node.js 22+
- Epson termální tiskárna dostupná na síti (port 9100)

## Vývoj

```bash
npm ci          # nainstaluje devDependencies (concurrently)
npm run dev          # spustí backend (port 3000) + frontend (port 5173)
```

## Desktopová aplikace (Electron)

Stejný backend i frontend zabalené do okna pro Windows/macOS. Server uvnitř aplikace poslouchá pouze na `127.0.0.1` s náhodným volným portem — zvenku není dostupný a nekoliduje s ničím na portu 3000.

```bash
npm --prefix desktop install
npm run desktop          # build + spuštění okna (vývoj)
npm run desktop:dist     # build instalátoru (.dmg / .exe) přes electron-builder
```

Instalátor pro danou platformu je potřeba buildit na ní (macOS `.dmg` na Macu, Windows `.exe` na Windows) — nebo nechat na GitHub Actions, viz níže.

### Release

Nová verze ke stažení se vydává přes git tag:

```bash
npm version patch   # nebo minor / major — bumpne verzi, commitne a vytvoří tag vX.Y.Z
git push --follow-tags
```

Push tagu `v*` spustí workflow [release.yml](.github/workflows/release.yml), které na macOS a Windows runnerech buildne instalátory a vytvoří GitHub release s `.dmg` (Apple Silicon) a `.exe` ke stažení. Verze v `desktop/package.json` se při `npm version` synchronizuje automaticky.

Instalátory nejsou podepsané vývojářským certifikátem.

Na macOS je proto doporučená instalace přes [install-mac.sh](install-mac.sh) — curl nepřidává quarantine atribut, takže Gatekeeper nic neblokuje:

```bash
curl -fsSL https://raw.githubusercontent.com/FilipChalupa/thermal-print-from-web/main/install-mac.sh | bash
```

Ručně stažený `.dmg` macOS odmítne otevřít („is damaged“), dokud se quarantine neodstraní: `xattr -cr "/Applications/Thermal Print.app"`.

Windows zobrazí SmartScreen varování (More info → Run anyway). Plné odstranění obou varování vyžaduje Apple Developer účet (podpis + notarizace) resp. Windows code signing certifikát.

## Deploy (Coolify)

Repozitář obsahuje samostatné `Dockerfile` pro backend i frontend.

Při deployi přes Coolify nastav u každého resource **Base Directory** na `/backend` resp. `/frontend`.

Frontend očekává URL backendu v environment variable:

```
VITE_BACKEND_URL=https://tvuj-backend.domena.cz
```
