# draw-a-chart

Personal stylus-first charting PWA for Wyckoff study: **pen draws, fingers navigate, mouse navigates**
(mouse draws only in explicit mouse-draw mode). React 19 + TS 6 + Vite 8 + Lightweight Charts 5.2 +
perfect-freehand + Binance Spot public data + optional Supabase sync.

Read before changing anything substantial:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): decisions, platform facts, risks
- [docs/PROGRESS.md](docs/PROGRESS.md): milestone status and next steps (update it when you finish work)
- [docs/DEVICE_TESTING.md](docs/DEVICE_TESTING.md): physical iPad/Galaxy test procedure

## Commands

```bash
npm run dev          # http://localhost:5173 (also on the LAN); add ?provider=mock for offline data
npm test             # Vitest unit tests
npm run e2e          # Playwright browser tests (starts its own dev server on port 5174)
npm run supabase:start && npm run e2e:supabase   # live sync tests vs a LOCAL Supabase stack (Docker; port 5175/553xx)
npm run supabase:stop                            # the local stack listens on all interfaces with default keys
npm run typecheck    # tsc -b (app, node config, e2e)
npm run lint         # ESLint
npm run build        # typecheck + production build (dist/)
npm run preview      # serve the production build
```

URL switches: `?provider=mock&mockNow=<ms>&mockLive=0` (deterministic data), `?test=1` (exposes `window.__dac` in prod builds; always on in dev).

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

## Conventions

- TypeScript `erasableSyntaxOnly`: no `enum`, no namespaces, no constructor parameter properties.
- TypeScript is pinned to 6.0.x because `typescript-eslint` does not support TS 7 yet.
- Tunable constants live in one place each: `QUICKSHAPE`, `HANDWRITING`, `PALM`, `NAV`.
- Tests: colocated `*.test.ts` (Vitest, node env); browser tests in `e2e/` (Playwright);
  live sync tests in `e2e/*.supabase.ts` (own config `e2e/supabase.config.ts`).
- Don't edit files while a Playwright run is using the dev server: Tailwind is scoped to `src/`,
  but source edits still hot-reload the page under test.
- Table privileges are explicit in the migration (new Supabase projects grant API roles nothing):
  any new table needs its own `grant`s, and `migration.test.ts` checks both old and new defaults.
- Do not claim hardware behaviour is verified unless it was tested on a physical device.
