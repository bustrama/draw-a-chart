# draw-a-chart

Personal stylus-first charting PWA for Wyckoff study: **pen draws, fingers navigate, mouse navigates**
(mouse draws only in explicit mouse-draw mode). React 19 + TS 6 + Vite 8 + Lightweight Charts 5.2 +
perfect-freehand + market data (crypto: Binance Spot; US stocks: Alpaca, free plan, 15 min delayed)
through a self-hosted server that also syncs drawings (Node 24, SQLite, WebSocket; one Docker container). Public repo: never commit credentials, tokens, `.env` files or personal data.

Read before changing anything substantial:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): decisions, platform facts, risks
- [docs/PROGRESS.md](docs/PROGRESS.md): milestone status and next steps (update it when you finish work)
- [docs/DEVICE_TESTING.md](docs/DEVICE_TESTING.md): physical iPad/Galaxy test procedure

## Commands

```bash
npm run dev          # http://localhost:5173 (also on the LAN), includes the sync + market APIs (.data/; US stocks need APCA_* in .env)
npm test             # Vitest unit tests (app + server)
npm run e2e          # Playwright: dev server (5174, sync off), production server (4175), multi-device sync
npm run typecheck    # tsc -b (app, node config, server, tests, e2e)
npm run lint         # ESLint
npm run build        # typecheck + production build (dist/)
npm start            # production server: dist/ + sync + market APIs on port 8080 (data/)
docker compose up -d --build   # the self-hosted deployment
```

URL switches: `?market=us&symbol=AAPL&tf=1h` (open a chart), `?provider=mock&mockNow=<ms>&mockLive=0`
(deterministic data: a crypto and a US-like market), `?provider=binance` (crypto from Binance directly, no
server), `?test=1` (exposes `window.__dac` in prod builds; always on in dev), `?sync=off` (local-only page load).

## Architectural invariants (do not break)

- **Persist drawings in chart space only:** absolute time (Unix ms) + price. Never logical bar
  indices, never pixels (glyphs store px offsets relative to a chart anchor at a recorded scale).
- **All geometry goes through `Viewport`/`TimeIndex`.** Lightweight Charts' `logicalToCoordinate`
  returns 0 for fractional logicals and `coordinateToLogical` rounds — do not use them for drawings.
- **Touch Events never reach Lightweight Charts.** `InputRouter` blocks them in the capture phase;
  finger navigation is ours (`TouchNavigator`) via absolute API setters. Do not re-enable LWC touch
  options (`horzTouchDrag`, `pinch`, `kineticScroll.touch`).
- **Pen never navigates, fingers never draw.** Pen compat mouse events are suppressed.
- Committed drawings render in the `DrawingsPrimitive` with **zOrder 'normal'** (main canvas: synced,
  in screenshots, not repainted on crosshair moves). Transient visuals go to `LiveLayer`.
- Chart data updates are **deferred while a stroke is active** (`beginDeferUpdates`).
- Pen sessions end only on their own pointer's up/cancel/lostpointercapture (iPad hover uses other ids).
- Market data layer stays chart-agnostic; drawing engine stays React-agnostic.
- **Bar times come from the market's bar clock** (`shared/sessions.ts`): the chart's future area
  (`TimeIndex`), gap detection (`CandleSeries`/`CandleFeed`) and the server's bucketing all use it. Never
  assume a bar every `tf.ms` for stocks (nights, weekends, holidays, 9:30-aligned hourly bars).
- **Bar cache:** the server stores closed bars and marks the range complete (coverage) in one
  transaction; the forming bar is never cached. A drawing's namespace is the market id (`binance`,
  `us`), never the data vendor.
- **The Alpaca key lives only in the server's environment** (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`):
  never with a `VITE_` prefix, in responses, logs, the repo or chat.
- **Sync:** the client/server contract is `src/sync/protocol.ts` (types only). The server decides who
  is calling in exactly one place, `identify()` in `server/app.ts` (the hook for auth later); every
  row keeps its owner. Server write semantics (`server/store.ts`) must match `FakeBackend`.
- **Never hand-swap the database file:** restore with `server/restore.ts`, which renews the database
  `generation`; devices resynchronize only when it changes.
- Server input is hostile: never re-serialize client-supplied objects (rebuild them from checked
  fields), and every socket path (`upgrade`, `message`) must be crash-proof.

## Conventions

- TypeScript `erasableSyntaxOnly`: no `enum`, no namespaces, no constructor parameter properties.
  The server runs as TypeScript (Node type stripping): relative imports in `server/` need `.ts`
  extensions, and it may only `import type` from `src/`. Code both sides run lives in `shared/`
  (no imports, `.ts` extensions; the Docker image copies it).
- TypeScript is pinned to 6.0.x because `typescript-eslint` does not support TS 7 yet.
- Tunable constants live in one place each: `QUICKSHAPE`, `HANDWRITING`, `PALM`, `NAV`.
- Tests: colocated `*.test.ts` (Vitest, node env; `server/` and `shared/` too); browser tests in `e2e/`
  (Playwright). `e2e/sync.spec.ts` starts its own production servers. The e2e servers run with
  `MARKET_DATA=off`: browser tests use the mock provider or mock `/api/market` with `page.route`.
- Don't edit files while a Playwright run is using the dev server: Tailwind is scoped to `src/`,
  but source edits still hot-reload the page under test.
- Schema changes: append a migration to `MIGRATIONS` in `server/store.ts`; never edit a shipped one.
- Do not claim hardware behaviour is verified unless it was tested on a physical device.
