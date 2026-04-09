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

## Deploy (Coolify)

Repozitář obsahuje samostatné `Dockerfile` pro backend i frontend.

Při deployi přes Coolify nastav u každého resource **Base Directory** na `/backend` resp. `/frontend`.

Frontend očekává URL backendu v environment variable:

```
VITE_BACKEND_URL=https://tvuj-backend.domena.cz
```
