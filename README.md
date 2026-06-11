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
