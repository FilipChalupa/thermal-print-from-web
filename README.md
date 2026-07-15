# kilomayo-print

Web application for printing images on Epson thermal printers over the ESC/POS protocol.

## Stack

- **Frontend:** React + Vite (TypeScript)
- **Backend:** Hono (Node.js, TypeScript)
- **Printing:** ESC/POS over TCP, Floyd–Steinberg dithering via skia-canvas

## Features

- **Web image printing** — upload/drag & drop/clipboard, preview, rotation and reordering, copy count, automatic cut after each print
- **Driverless network printer** (AirPrint / IPP Everywhere) — print from any application via `Cmd/Ctrl+P` (see below)
- **Auto-discovery** of printers on the network (mDNS + port 9100 scan) with suggestions and verification that the device really is an ESC/POS printer
- **Test receipt** to a single printer or all discovered printers
- **Paper width** 80 mm (576 dots) / 58 mm (384 dots)
- **Image adjustments** — dithering (Floyd–Steinberg / Atkinson / Ordered / threshold) + brightness and contrast
- **Print queue** — serialization per printer and retries when the printer is briefly offline (with a live thumbnail preview)
- **Printer status** — online / offline / out of paper / cover open (via ESC/POS `DLE EOT`), also reflected in IPP
- **Job history** — preview of the printed image (thumbnail → zoom → PNG download) and reprint
- **No wasted paper** — for system printing the content is automatically cropped to its bounding box (no meters of blank paper) and the roll is advertised as variable-length media
- **Multiple network printers** — each one is a separate AirPrint queue targeting a different physical printer

## Driverless network printer (AirPrint / IPP Everywhere)

Besides the web UI, the application presents itself on the local network as a **regular printer**, so you can print from any application via `Cmd/Ctrl+P` — no driver installation on Windows, macOS or Linux.

How it works:

- The server announces itself via **mDNS/Bonjour** (`_ipp._tcp`, including the AirPrint subtype `_universal`), so the OS finds it on its own and offers to add it.
- It implements an **IPP** server (RFC 8011 + IPP Everywhere): `Get-Printer-Attributes`, `Validate-Job`, `Print-Job`, `Create-Job`/`Send-Document`, `Get-Jobs`, `Cancel-Job`.
- The OS sends the page as **PWG Raster** (`image/pwg-raster`) or **Apple Raster / URF** (`image/urf`). It is decoded, **cropped to its content** (the OS lays it out on a fixed page, i.e. lots of white margin — a waste on a continuous roll), rescaled to the printer width (576 dots / 80 mm roll, 203 dpi), Floyd–Steinberg dithered and sent as ESC/POS. The roll is additionally advertised as **variable-length** media (a range), so the client ideally lays the page out at the height of the content right away.

- The OS can also send the page as **PDF** (`application/pdf`) — rendered via MuPDF.

### Printers and the star

In the web UI you manage **a single list of printers** — each one has a name, its own IP, and announces itself on the network as a **standalone AirPrint / IPP Everywhere printer** (at the path `ipp/print/<id>`). Printers are **suggested automatically** from discovery (mDNS `_pdl-datastream._tcp` + a port 9100 scan of the local /24; the range can be overridden via `THERMAL_DISCOVERY_HOSTS`) — just click "add", or enter the IP manually.

- **Star ★ = default printer.** It gets the canonical path `ipp/print` and is also the target of the web *Print* button. On first start, the first discovered printer is added and marked as default automatically (zero-config).
- The other printers in the list work as additional AirPrint queues, each pointing to its own physical IP.

Configuration is stored in `~/.thermal-print-config.json` (overridable via `THERMAL_CONFIG_PATH`); the legacy format (a single `printerIp` + `virtualPrinters`) is automatically migrated to the new list on load.

### Environment variables

| Variable | Meaning |
| --- | --- |
| `PORT` | Web UI / REST port (default `3000`) |
| `IPP_PORT` | IPP server port (default `6310`; announced via mDNS, the value doesn't matter) |
| `PRINTER_IP`, `PRINTER_NAME` | Default target IP and name of the main network printer |
| `PAPER_WIDTH_DOTS` | Default print width: `576` (80 mm) or `384` (58 mm) |
| `THERMAL_CONFIG_PATH` | Path to the configuration file |
| `THERMAL_JOBS_PATH` | Path to the job history file (defaults to next to the config) |
| `THERMAL_DISCOVERY_HOSTS` | Manual list of IPs to scan (instead of subnet autodetection) |
| `WEBHOOK_URL` | When set, a notification is POSTed here on print failure |
| `PRINT_QUEUE_MAX_WAIT_MS`, `PRINT_QUEUE_RETRY_GAP_MS` | Queue retry window for an offline printer |
| `LOG_LEVEL` | Log level: `debug` / `info` (default) / `warn` / `error` |

Status and diagnostics are available at `GET /health` (IPP/mDNS running, printer reachability and status, job counts, list of announced printers).

> On first start, the Windows/macOS firewall may ask to allow incoming connections (IPP port + mDNS). The IPP server listens on `0.0.0.0`, while the web UI itself stays on loopback only.

## Requirements

- Node.js 22+
- Epson thermal printer reachable on the network (port 9100)

## Development

```bash
npm ci          # installs devDependencies (concurrently)
npm run dev          # starts the backend (port 3000) + frontend (port 5173)
```

## Tests

The backend has a test suite (vitest) covering the IPP codec, PWG/URF decoder, PDF rendering, dithering, the print queue, reprint, IPP attributes/status and discovery:

```bash
npm test --prefix backend
```

## Desktop application (Electron)

The same backend and frontend packaged into a window for Windows/macOS. The server inside the app listens only on `127.0.0.1` with a random free port — it is not reachable from the outside and doesn't collide with anything on port 3000. The desktop app also **does not announce itself as a network printer** (IPP/mDNS is disabled) — it is a local UI; run the driverless printer via the server (see Deploy).

```bash
npm --prefix desktop install
npm run desktop          # build + open the window (development)
npm run desktop:dist     # build the installer (.dmg / .exe) via electron-builder
```

The installer for a given platform has to be built on it (macOS `.dmg` on a Mac, Windows `.exe` on Windows) — or leave it to GitHub Actions, see below.

### Release

A new downloadable version is released via a git tag:

```bash
npm version patch   # or minor / major — bumps the version, commits and creates the vX.Y.Z tag
git push --follow-tags
```

Pushing a `v*` tag triggers the [release.yml](.github/workflows/release.yml) workflow, which builds the installers on macOS and Windows runners and creates a GitHub release with a downloadable `.dmg` (Apple Silicon) and `.exe`. The version in `desktop/package.json` is synchronized automatically during `npm version`.

The installers are not signed with a developer certificate.

On macOS the recommended installation is therefore via [install-mac.sh](install-mac.sh) — curl doesn't add the quarantine attribute, so Gatekeeper doesn't block anything:

```bash
curl -fsSL https://raw.githubusercontent.com/FilipChalupa/thermal-print-from-web/main/install-mac.sh | bash
```

A manually downloaded `.dmg` will be refused by macOS ("is damaged") until the quarantine is removed: `xattr -cr "/Applications/Thermal Print.app"`.

Windows shows a SmartScreen warning (More info → Run anyway). Fully removing both warnings requires an Apple Developer account (signing + notarization) or a Windows code signing certificate, respectively.

## Deploy (Coolify)

The repository contains a standalone `Dockerfile` for both the backend and the frontend.

When deploying via Coolify, set the **Base Directory** of each resource to `/backend` and `/frontend` respectively.

The frontend expects the backend URL in an environment variable:

```
VITE_BACKEND_URL=https://your-backend.example.com
```

### Deploy including the network printer (driverless printing)

The web UI (HTTP) works from anywhere, but **driverless printing (AirPrint / IPP Everywhere) only works from a host on the same LAN** as the printer and the devices you print from — mDNS discovery runs over UDP multicast, which doesn't cross the internet or subnets.

Additionally, **host networking** is required — in a regular Docker bridge network the multicast doesn't reach the LAN. Deploy the service with `network_mode: host` (in Coolify via a **Docker Compose** resource where you configure the host network; don't forget to persist the configuration with a volume on `THERMAL_CONFIG_PATH`, so the selected printer and UUID survive a redeploy).

On the host, allow incoming LAN traffic on:

- **UDP 5353** (mDNS/Bonjour discovery)
- **TCP `IPP_PORT`** (default 6310, IPP)

#### Domain routing with host networking (important)

The Coolify **Domains** field of a service in `network_mode: host` **doesn't work** — automatic routing via Traefik labels needs the container on the internal `coolify` network, but a host-networking container isn't on it (it listens directly on the host `:3000`). The result is that the domain falls through to Traefik's default `404 page not found`.

The solution — **leave the Domains field empty** and add a Traefik **dynamic configuration** (in Coolify: _Server → Proxy → Dynamic Configurations_) that routes the domain to the host via `host.docker.internal`:

```yaml
http:
  routers:
    thermal-print:
      rule: "Host(`print.your-company.com`)"
      entryPoints:
        - http          # see the note about two-layer Traefik below
      service: thermal-print
      # tls:            # only when TLS is handled by this (the only) Traefik:
      #   certResolver: letsencrypt
  services:
    thermal-print:
      loadBalancer:
        servers:
          - url: "http://host.docker.internal:3000"   # PORT from compose
```

Verify that the Coolify Traefik knows the host gateway: `docker exec coolify-proxy getent hosts host.docker.internal` (returns an IP). If not, put the Docker bridge IP directly into `url` (`docker exec coolify-proxy ip route | grep default`, typically `172.17.0.1`).

> **Two-layer Traefik:** if another (edge) Traefik runs in front of the Coolify Traefik, **terminates TLS** and forwards inside over HTTP, don't put any `redirectScheme: https` middleware or `tls` into the inner router — the inner Traefik receives the traffic as HTTP and a redirect to https would loop (`307` forever). Handle TLS + the certificate on the outer Traefik.

> **Watch out for `avahi-daemon`:** if it runs on the host (typically desktop Linuxes), it holds UDP 5353 and mDNS advertising may collide. It usually doesn't run on servers; if it does, either disable it or expect a possible collision (watch the logs for `mDNS advertising error`).

After deployment, open the web UI — discovered printers appear in the list; star one as the target of system printing (or the first discovered one is chosen automatically). Then add the printer on the clients (macOS AirPrint / Windows IPP Everywhere) — it shows up by itself.
