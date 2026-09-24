# draw-a-chart: the web app + its sync server in one container.
#   docker compose up -d --build        (see docker-compose.yml and README "Self-hosting")

# ---- build the web app ---------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Type-check what ships (app + server), then bundle the app into dist/.
RUN npx tsc -b tsconfig.app.json tsconfig.server.json && npx vite build

# ---- runtime: Node serves dist/ and the sync API ------------------------------------------------
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    STATIC_DIR=/app/dist
WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies only (the browser libraries are bundled into dist/).
RUN npm ci --omit=dev && npm cache clean --force
# The server runs as TypeScript (Node type stripping); it imports nothing from src/ at runtime.
COPY server ./server
COPY --from=build /app/dist ./dist
RUN rm -f server/vitePlugin.ts && mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
# /api/health also fails (503) when the database cannot be written.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
# node:sqlite is still flagged experimental in Node 24; the warning is noise here.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.ts"]
