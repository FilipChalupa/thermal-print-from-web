# kilomayo-print

Webová aplikace pro tisk obrázků na termální tiskárně Epson přes ESC/POS protokol.

## Stack

- **Frontend:** React + Vite (TypeScript)
- **Backend:** Hono (Node.js, TypeScript)
- **Tisk:** ESC/POS přes TCP, Floyd-Steinberg dithering pomocí skia-canvas

## Funkce

- **Web tisk obrázků** — nahrání/drag&drop/clipboard, náhled, rotace a řazení, počet výtisků, po každém automatický cut
- **Síťová tiskárna bez ovladačů** (AirPrint / IPP Everywhere) — tisk z libovolné aplikace přes `Cmd/Ctrl+P` (viz níže)
- **Auto-discovery** tiskáren v síti (mDNS + sken portu 9100) s našeptáváním a ověřením, že jde o ESC/POS tiskárnu
- **Testovací lístek** na jednu nebo všechny nalezené tiskárny
- **Šířka papíru** 80 mm (576 bodů) / 58 mm (384 bodů)
- **Úpravy obrazu** — dithering (Floyd–Steinberg / Atkinson / Ordered / práh) + jas a kontrast
- **Fronta tisku** — serializace na tiskárnu a opakování, když je krátce offline
- **Stav tiskárny** — online / offline / došel papír / otevřené víko (přes ESC/POS `DLE EOT`), promítnuto i do IPP
- **Historie úloh** s možností přetisku
- **Více síťových tiskáren** — každá jako samostatná AirPrint fronta mířící na jinou fyzickou tiskárnu

## Síťová tiskárna bez ovladačů (AirPrint / IPP Everywhere)

Kromě webu se aplikace v lokální síti tváří jako **běžná tiskárna**, takže jde tisknout z jakékoli aplikace přes `Cmd/Ctrl+P` — bez instalace ovladače na Windows, macOS i Linuxu.

Jak to funguje:

- Server se ohlašuje přes **mDNS/Bonjour** (`_ipp._tcp`, včetně AirPrint subtypu `_universal`), takže ho OS sám najde a nabídne přidání.
- Implementuje **IPP** server (RFC 8011 + IPP Everywhere): `Get-Printer-Attributes`, `Validate-Job`, `Print-Job`, `Create-Job`/`Send-Document`, `Get-Jobs`, `Cancel-Job`.
- OS pošle stránku jako **PWG Raster** (`image/pwg-raster`) nebo **Apple Raster / URF** (`image/urf`). Ta se dekóduje, přeškáluje na šířku tiskárny (576 dotů / 80 mm role, 203 dpi), Floyd–Steinberg dither a odešle jako ESC/POS na fyzickou tiskárnu.

- OS pošle stránku i jako **PDF** (`application/pdf`) — vyrenderuje se přes MuPDF.

### Tiskárny a hvězdička

Ve webu spravuješ **jeden seznam tiskáren** — každá je pojmenovaná, má svou IP a v síti se ohlašuje jako **samostatná AirPrint / IPP Everywhere tiskárna** (na cestě `ipp/print/<id>`). Tiskárny se **automaticky napovídají** z discovery (mDNS `_pdl-datastream._tcp` + sken portu 9100 po lokálním /24; rozsah lze přebít přes `THERMAL_DISCOVERY_HOSTS`) — stačí kliknout „přidat", nebo zadat IP ručně.

- **Hvězdička ★ = výchozí tiskárna.** Ta dostane kanonickou cestu `ipp/print` a je cílem i webového tlačítka *Tisknout*. Při prvním spuštění se první nalezená přidá a označí jako výchozí automaticky (zero-config).
- Ostatní tiskárny v seznamu fungují jako další AirPrint fronty, každá na svou fyzickou IP.

Konfigurace se ukládá do `~/.thermal-print-config.json` (přebitelné přes `THERMAL_CONFIG_PATH`); starší formát (jedna `printerIp` + `virtualPrinters`) se při načtení automaticky převede na nový seznam.

### Proměnné prostředí

| Proměnná | Význam |
| --- | --- |
| `PORT` | Port webového UI / REST (výchozí `3000`) |
| `IPP_PORT` | Port IPP serveru (výchozí `6310`; ohlašuje se přes mDNS, na hodnotě nezáleží) |
| `PRINTER_IP`, `PRINTER_NAME` | Výchozí cílová IP a jméno hlavní tiskárny v síti |
| `PAPER_WIDTH_DOTS` | Výchozí šířka tisku: `576` (80 mm) nebo `384` (58 mm) |
| `THERMAL_CONFIG_PATH` | Cesta ke konfiguračnímu souboru |
| `THERMAL_DISCOVERY_HOSTS` | Ruční seznam IP pro sken (místo autodetekce podsítě) |
| `WEBHOOK_URL` | Když je nastaveno, při selhání tisku se sem POSTne upozornění |
| `PRINT_QUEUE_MAX_WAIT_MS`, `PRINT_QUEUE_RETRY_GAP_MS` | Okno opakování fronty pro offline tiskárnu |

Stav a diagnostika je na `GET /health` (běží IPP/mDNS, dostupnost a stav tiskárny, počty úloh, seznam ohlašovaných tiskáren).

> Při prvním spuštění může Windows/macOS firewall vyžádat povolení příchozích spojení (IPP port + mDNS). IPP server naslouchá na `0.0.0.0`, samotné webové UI zůstává jen na loopbacku.

## Požadavky

- Node.js 22+
- Epson termální tiskárna dostupná na síti (port 9100)

## Vývoj

```bash
npm ci          # nainstaluje devDependencies (concurrently)
npm run dev          # spustí backend (port 3000) + frontend (port 5173)
```

## Testy

Backend má sadu testů (vitest) pokrývající IPP kodek, PWG/URF dekodér, PDF rendering, dithering, frontu tisku, přetisk, IPP atributy/stav a discovery:

```bash
npm test --prefix backend
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

### Deploy včetně síťové tiskárny (driverless tisk)

Web (HTTP) funguje odkudkoli, ale **driverless tisk (AirPrint / IPP Everywhere) funguje jen z hostitele na stejné LAN** jako tiskárna a zařízení, ze kterých tiskneš — mDNS discovery jede přes UDP multicast, který neprojde přes internet ani mezi podsítěmi.

Navíc je potřeba **host networking** — v běžné Docker bridge síti se multicast na LAN nedostane. Nasaď proto službu s `network_mode: host` (v Coolify přes **Docker Compose** resource, kde si nastavíš host síť; konfiguraci nezapomeň perzistovat volume na `THERMAL_CONFIG_PATH`, aby zůstala vybraná tiskárna a UUID i po redeployi).

Na hostiteli povol na LAN příchozí provoz:

- **UDP 5353** (mDNS/Bonjour discovery)
- **TCP `IPP_PORT`** (výchozí 6310, IPP)

Web port (`PORT`, výchozí 3000) řeší Coolify proxy pro doménu jako obvykle.

> **Pozor na `avahi-daemon`:** pokud na hostiteli běží (typicky desktopové Linuxy), drží UDP 5353 a mDNS advertising může kolidovat. Na serveru většinou neběží; pokud ano, buď ho vypni, nebo počítej s možnou kolizí (hlídej logy `mDNS advertising error`).

Po nasazení otevři web, v selectu se objeví nalezené tiskárny — jednu zahvězdičkuj jako cíl systémového tisku (nebo se první nalezená zvolí automaticky). Pak na klientech přidej tiskárnu (macOS AirPrint / Windows IPP Everywhere) — objeví se sama.
