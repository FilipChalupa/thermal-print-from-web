FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

FROM node:22-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=frontend-build /app/frontend/dist ./public

# NOTE: EXPOSE is documentation only — it neither publishes ports nor opens the
# firewall, and it is a no-op under `network_mode: host`. Driverless discovery
# needs host networking so mDNS multicast reaches the LAN (see docker-compose.yml).
EXPOSE 3000
# IPP / virtual printer (default IPP_PORT; advertised over mDNS so any port works)
EXPOSE 6310
# mDNS / Bonjour discovery (multicast)
EXPOSE 5353/udp

# Liveness: the web server answers /health once it is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider "http://127.0.0.1:${PORT:-3000}/health" || exit 1

CMD ["node", "dist/index.js"]
