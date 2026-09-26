# draw-a-chart — Architecture

Stylus-first financial charting PWA for Wyckoff study. **The pen draws, fingers navigate, the
mouse navigates (or draws in an explicit mode).** This document records the decisions, the
reasons behind them, and the platform facts they rest on. Status of each part is tracked in
[PROGRESS.md](PROGRESS.md).

## 1. Technology choices

| Concern | Choice | Why |
|---|---|---|
| UI | React 19 + TypeScript 6.0 + Vite 8 | Preferred stack. TS pinned to 6.0.x: TS 7 (native compiler) has no JS API yet and `typescript-eslint` requires `<6.1`. |
| Styling | Tailwind CSS 4 | Preferred; tokens in `src/index.css`. |
| Chart | TradingView Lightweight Charts **5.2** | Fast canvas chart with a documented primitive (plugin) API that lets drawings render *inside* the chart's paint pass. No alternative offered a better input or drawing story. |
| Ink geometry | `perfect-freehand` 1.2 | Pressure-sensitive stroke outlines; about 0.08 µs per point (30k points ≈ 2.5 ms on desktop). The same code renders live and committed ink, so strokes don't "pop" on commit. |
| Market data | Crypto: Binance Spot (public, no key). US stocks and ETFs: Alpaca (free plan: every exchange, 15 min delayed). Futures: Yahoo Finance (unofficial, no key, 10 min delayed). All behind the self-hosted server's bar cache; crypto live updates straight from Binance's stream | Free sources with consolidated volume (Wyckoff needs real volume). The cache makes charts open instantly and fetches only missing bars. See §6. |
| Persistence | IndexedDB (`idb`) on each device + a self-hosted sync server: Node 24, SQLite (`node:sqlite`), WebSocket (`ws`), in one Docker container | Local-first; sync is only needed to share drawings between devices. No accounts yet (see §7). |
| PWA | `vite-plugin-pwa` 1.x (`registerType: 'prompt'`) | Auto-update could reload mid-stroke, so updates are prompted instead. |
| Tests | Vitest 5 (unit, including the sync server) + Playwright 1.63 (Chromium via CDP for trusted touch/pen input; WebKit iPad-like context; the production server; multi-device sync) | |

There is no state-management framework. The engine is plain TypeScript classes, and React
subscribes via `useSyncExternalStore`.

## 2. Module map

```
shared/              code the app and the server both run (no imports; .ts extensions)
  sessions.ts        trading sessions, bar clocks (which bar times exist), New York time
src/
  market/            provider-agnostic market data
    types.ts         Candle, MarketDataProvider (prepare → symbol info + bar clock), LiveStatus
    protocol.ts      wire protocol of /api/market (types only, shared with the server)
    registry.ts      the markets of this page load (binance, us) and symbol search
    candleSeries.ts  sorted/deduped bars, merge semantics, change classification, gap finder
    candleFeed.ts    one symbol+timeframe: history, live, pagination, gap backfill, resync
    server/          MarketApi (HTTP client) and ServerMarketProvider (history from the server,
                     live from Binance's stream or by polling the server)
    binance/         REST client (paced, failover, backoff), stream client (one socket), provider
    mock/            deterministic provider (?provider=mock) for offline dev and E2E, with an
                     optional US-like session calendar
  chart/
    ChartController  owns Lightweight Charts: data sync, deferral, viewport, navigation setters
    timeIndex.ts     time <-> fractional logical index (the anchoring core)
    viewport.ts      immutable pane transform snapshot used by all drawing code
  drawing/
    model.ts         Drawing types (ink / line / glyph / stamp), validation, glyph scale
    store.ts         DrawingStore + History (undo/redo) = DrawingDocument per chart
    DrawingEngine    tools, stroke sessions (draw/erase/select/stamp), QuickShape, notes, live layer
    quickShape.ts    line recognition, hold detection, angle snapping
    classify.ts      handwriting vs drawing classification, note grouping
    stamps.ts        Wyckoff label stamps: vocabulary, where a stamp lands (bar high/low), layout
    render/          shared stroke renderer, chart primitive, live overlay canvas
  input/
    InputRouter      capture-phase gatekeeper: routes pen/touch/mouse, blocks touch events
    TouchNavigator   finger pan/pinch/kinetic/crosshair/axis gestures via the chart API
    palmPolicy.ts    palm rejection rules
  sync/
    protocol.ts      wire protocol shared with the server (types only)
    localDb.ts       IndexedDB: drawings (+tombstones, server rev), outbox, cursors
    PersistentDocuments  documents backed by IndexedDB (ordered writes, load-race safe)
    SyncEngine       flush (compare-and-swap), pull, live merge, previews, retries
    serverRemote.ts  RemoteApi for the sync server: HTTP + one reconnecting WebSocket
    session.ts       who this device is on the server (cached; the hook for sign-in later)
  app/
    Workspace.ts     chart composition (chart + feed + engine + navigator + router)
    runtime.ts       app composition (provider, persistence, sync, session, previews, workspace)
    screenshot.ts    capture, clipboard, share, download
  ui/                React controls (top bar, tool rail, palette, label strip, screenshot, sync status)
server/              self-hosted sync server (Node 24 runs the TypeScript directly)
  main.ts            production entry (env config, graceful shutdown)
  backup.ts, restore.ts   online backup; restore with a new generation (devices resynchronize)
  http.ts            HTTP server: sync API + WebSocket + static dist/ on one port
  app.ts             the API, the live hub, and identify() (the auth hook)
  store.ts           SQLite: compare-and-swap writes, pulls, migrations, backup
  validate.ts        request and preview validation
  market/            market data: /api/market/* (§6)
    cache.ts         SQLite bar cache (market.sqlite) with coverage ranges
    service.ts       bars through the cache, symbol lists, calendars, split checks, futures archive
    binance.ts, alpaca.ts, yahoo.ts, upstream.ts   upstream clients (rate-limited, retries)
    futures.ts       the futures offered (continuous front month, Yahoo tickers, ticks)
    sessionBars.ts   upstream bars to session bars (regular hours, trade dates, 4-hour bars)
    api.ts           HTTP routes and input validation
  static.ts          built app with cache headers, SPA fallback, traversal guard
  vitePlugin.ts      the same API inside `npm run dev`
Dockerfile, docker-compose.yml   one container: the app + its sync server, data on a volume
```

## 3. Input model (the core requirement)

### 3.1 Routing

Every event over the chart passes through `InputRouter`. It uses **capture-phase** listeners on
the chart host, so it runs before any Lightweight Charts (LWC) handler.

| Input | Goes to | Never |
|---|---|---|
| `pointerType: 'pen'` contact | `DrawingEngine` (draw / erase / select) | reaches the chart; navigates |
| `pointerType: 'pen'` hover (`buttons === 0`) | palm guard + eraser cursor. The chart crosshair is hidden while the pen is in use. | draws |
| `pointerType: 'touch'` | `TouchNavigator` (our own navigation) | draws |
| `pointerType: 'mouse'` | native LWC navigation; the engine only in mouse-draw mode (Space = temporary pan) | |
| Touch Events (`touchstart`…) | **always blocked** (`stopPropagation` + `preventDefault`) | reach the chart |
| Mouse compat events from pen/touch | blocked | reach the chart |

### 3.2 Why all Touch Events are blocked and navigation is re-implemented

From reading the LWC 5.2 source (`MouseEventHandler`):

- LWC consumes Touch Events and Mouse Events, not Pointer Events.
- After a `touchstart` it registers `touchmove`/`touchend` listeners on `<html>`, keyed by `_activeTouchId`.
- Its pinch logic reads `event.touches`, which is *all* contacts, including a resting palm or the pen.
- If any touch sequence is filtered partially, `_activeTouchId` stays set and LWC ignores every later touch.

Selective filtering is therefore not robust. Instead:

- LWC sees no touch at all (`handleScroll.*TouchDrag = false`, `handleScale.pinch = false`,
  `kineticScroll.touch = false`).
- `TouchNavigator` implements navigation on Pointer Events and **absolute** public-API setters:
  - one-finger pan (vertical pan past a dead zone turns auto-scale off, like TradingView);
  - pinch zoom anchored under the fingers, plus two-finger pan;
  - kinetic scrolling;
  - tap to toggle the crosshair; long-press for crosshair tracking;
  - price-axis drag to scale, time-axis drag to zoom;
  - double-tap on an axis to reset.

Because we own the gesture state, we can roll back a gesture the palm started just before the
pen landed. With native LWC handling that would be impossible.

**Crosshair and the pen.** A writing surface should not show a crosshair chasing the nib, so the
crosshair is hidden (`CrosshairMode.Hidden`) while the pen is in use. It comes back on real mouse
movement, and on a finger tap or long-press.

- Pen press and click compat events are blocked, because they could start a chart drag.
- Pen **hover** enter/leave/move events are *not* blocked. LWC only subscribes to `mousemove` on
  `mouseenter`, so blocking them would break the pen → mouse hand-off (verified in a trace: the
  order is `pointerover → pointerenter → mouseover → mouseenter → pointermove → mousemove`).

### 3.3 Palm rejection (`palmPolicy.ts`)

Fingers never draw, so a palm can at worst navigate. Rules:

1. A touch that starts while the pen is down is a palm.
2. So is one that starts within 450 ms after the pen lifts, or within 350 ms of pen hover.
3. A reported contact larger than 60 CSS px is a palm (only where the platform reports width/height).
4. A new touch within 160 px of a resting palm is a palm. Far away is allowed, e.g. the other hand panning.
5. When the pen lands, any finger gesture that started in the last 600 ms is **rolled back** to its start view.
6. An OS `pointercancel` on a touch younger than 1.5 s is rolled back too; iPadOS cancels touches it classifies as palms.

### 3.4 Platform facts this rests on (researched September 2026; items marked HW need physical hardware)

- Apple Pencil and S Pen report `pointerType: 'pen'`. Passive capacitive styluses report `'touch'`,
  so they navigate and cannot draw (not fixable on the web).
- In both WebKit and Chromium, a pen contact fires Pointer Events *before* Touch Events for the same
  contact; the pen also fires Touch Events.
- `Touch.touchType` exists only in Safari. We don't need it, because every touch event is blocked.
- WebKit does not implicitly capture Apple Pencil pointers, only `'touch'`, so the router calls
  `setPointerCapture` explicitly.
- `getCoalescedEvents()` / `getPredictedEvents()`: Chrome ≥ 58/77, Safari ≥ 18.2. The Pencil's
  240 Hz samples only arrive as coalesced events. Both are used when available.
- **iPad input exclusivity:** Safari delivers one input type at a time (pen *or* touch). So
  "pen draws while a finger pans" at the same instant is not achievable on iPad (HW).
  Coexistence means switching instantly with no mode change.
- iPad hover arrives on a different `pointerId` than the contact, and a hover `pointermove` can
  precede the contact's `pointerup`. Sessions therefore end only on their own pointer's up/cancel/lost-capture.
- S Pen side button: Chromium maps it to the *left* button flag, so the "barrel button = eraser"
  mapping (`buttons & 2`) may never trigger on Galaxy tablets (HW).
- Safari before 26.2 reported integer CSS-pixel coordinates; ink smoothing hides the resulting
  quantization (HW).
- Known iPad web-drawing bugs, outside our control:
  - the first Pencil tap after tapping a toolbar button can be ignored (tldraw #5950);
  - Scribble can swallow strokes on some iPadOS versions (turn Scribble off if affected);
  - a tap followed by a long press can still show the loupe (WebKit 296492).
- Passive-listener intervention: only window/document/body listeners default to passive. Ours
  sit on the host element with `passive: false`.

### 3.5 Gestures added

| Gesture | Action | Conflict analysis |
|---|---|---|
| Hold pen still at stroke end (≈450 ms) | QuickShape: straighten. Snaps to exact horizontal/vertical within 4°. Keep holding and move to adjust the end point. | Needs a straight-enough stroke longer than 24 px. Handwriting never holds at a line end. |
| Two-finger tap | Undo | ≤ 350 ms, < 14 px movement; any tiny zoom is rolled back first. |
| Three-finger tap | Redo | Same. |
| Pen eraser end (`buttons & 32`) / barrel button | Erase | Unverified on hardware (see 3.4). |
| Space (desktop) | Temporary pan in mouse-draw mode | |

Tap-and-hold with the pen was *not* mapped to selection: it would conflict with dots and QuickShape.

### 3.6 Pen session robustness

- **Every pen contact is pointer-captured and tracked**, not just the one that draws. A new pen
  contact clears stale entries whose `pointerup` was lost, so the palm guard can never stay
  stuck in "pen down".
- A **window-level `pointerup`/`pointercancel` listener** ends a session whose release happened
  outside the chart host.
- **`pointercancel`, window `blur` and `visibilitychange → hidden`** end the stroke cleanly:
  - what was drawn so far is committed;
  - pen contacts are cleared;
  - finger gestures are reset.
- **Pressure 0** mid-stroke (some pens report it on fast samples) keeps the previous pressure
  instead of pinching the ink.
- The **eraser end / barrel button** is evaluated when the contact starts, not from the last hover.
- **Navigation that has not painted yet.** `setVisibleLogicalRange` is applied by LWC on its next
  paint. `ChartController` therefore marks the view as *settling* after every navigation setter.
  - A pen stroke that starts in that window is buffered (`PendingStart`) and replayed once the
    view has settled, so its first points are mapped with the transform the user actually sees.
  - Finger zoom stores its anchor as an offset from the last bar (`anchorFromEnd`), so a history
    page that is prepended mid-pinch does not make the view jump.

## 4. Rendering architecture — hybrid

Three options were evaluated:

1. **Everything in LWC primitives.**
   - Pro: perfect sync; included in screenshots.
   - Con: every stylus sample triggers a full chart repaint (`requestUpdate` = full invalidation).
2. **Everything on an independent overlay canvas.**
   - Pro: full control over redraws.
   - Con: must detect every chart transform change, including auto-scale and kinetic
     scrolling. Painting in a separate rAF lags a frame ("swimming" drawings). Screenshots need
     manual compositing.
3. **Hybrid (chosen).**
   - Committed drawings are a series primitive with `zOrder: 'normal'`. They paint inside the
     chart's main-canvas pass, with the exact transform of that frame, and appear in
     `takeScreenshot()`.
   - `'top'` is avoided: that layer is the crosshair canvas. It is repainted on every mouse move
     and excluded from default screenshots.
   - Transient content goes on a pointer-transparent overlay canvas (`LiveLayer`): the stroke in
     progress (with predicted points), the QuickShape preview, eraser cursor, lasso, selection
     outlines, and remote live previews.
   - The overlay repaints in the **same frame** as the chart. A no-visual primitive's
     `updateAllViews()` (called during LWC's paint, after auto-scale) schedules a microtask,
     which runs before the frame is presented.

**Keeping committed ink cheap.**

- Culling uses cached chart-space bounds per drawing.
- Ink caches per-point fractional logicals per `TimeIndex` version.
- The perfect-freehand outline is cached as a `Path2D` in *logical × price* space, together with
  the bar spacing and price scale it was built at. Panning and moderate zooming re-project the
  cached path with one affine `ctx.transform`, because both axes are linear.
  - The outline is rebuilt only when the time index changes or either scale drifts by more than
    8 %. Beyond that, stroke width would visibly scale with zoom.
- **Measured** with the perf probe (`e2e/perf.capture.ts`: 400 drawings, 287 visible, 120 frames
  of continuous panning; headless Chromium on a desktop PC, **not** an iPad):

  | | Before | After |
  |---|---|---|
  | Drawing-layer paint, median | 7 ms | 0.3 ms |
  | Frame gap, median | 29 ms | 16.7 ms |

**Size limits.** A stored drawing has at most 2 000 points (`MAX_STROKE_POINTS`):

- Longer strokes are simplified with Ramer–Douglas–Peucker at increasing tolerances (0.25 → 2 px).
- Only if that is not enough are they split into consecutive drawings.
- This keeps every row far below the server's 256 KB limit, so one stroke can never block syncing.

## 5. Coordinates and representation

### 5.1 Persisted coordinates are absolute time + price, never logical indices

- Logical indices shift whenever older history is prepended, and they mean nothing on another
  timeframe.
- LWC also only converts **integer** logicals: `logicalToCoordinate` returns `0` for fractional
  input, and `coordinateToLogical` rounds with `Math.ceil` (verified in the 5.2 source).

So:

- `TimeIndex` maps time ↔ **fractional logical**:
  - piecewise linear between bar open times (a bar's open time sits at the bar centre);
  - gaps compress exactly as the chart compresses them (Binance history has real gaps,
    e.g. 80 missing 1m bars on 2023-03-24; stocks have nights and weekends);
  - after the last bar it steps through the future bars of the **bar clock** (§6.1): every
    interval for crypto, the next session's bars for stocks. So future-area anchors stay put as
    new bars arrive, also over a weekend (a target drawn three bars after Friday's close is on
    Monday's third bar once it exists). Before the first bar it uses the nominal interval.
- `Viewport` then applies LWC's linear time scale:
  - x = x(0) + L · barSpacing, with x(0) and barSpacing read from the public API each frame;
  - price uses a linear mapping sampled from the series.

Unit tests cover prepend stability, future-area stability, gaps and round trips. E2E tests cover
pan, zoom, resize and history load.

### 5.2 Four drawing kinds

| Kind | Stored as | Behaviour |
|---|---|---|
| `line` | two (time, price) points | Straight on screen between exact chart coordinates (QuickShape result). |
| `ink` | (time, price, pressure) per point | Glued to the price action; deforms with non-uniform zoom exactly like the candles. Used for circles, boxes, projected paths. |
| `glyph` | anchor (time, price) + CSS-px offsets at a reference scale + `ref` (px per ms when written) | Handwriting. Rigid: moves with its anchor and scales **uniformly**: `k = clamp(sqrt(zoom ratio), 0.5, 2)`. Never distorted, always legible. Glyphs written in quick succession share a `group` and anchor, forming a note. |
| `stamp` | anchor (time, price) + `label` text + `place` (`above` / `below` / `at`) | Wyckoff label (§5.4). Constant-size text beside its anchor: above a bar's high or below its low, with a tick pointing at it, or centred in a box. |

- Classification is automatic (`classify.ts`), so no tool switching is needed:
  - letter-sized strokes (≤ 60 px) are glyphs;
  - short, wide strokes with ≥ 25 % horizontal back-tracking (the loops of cursive words) are glyphs;
  - everything else is ink.
- A glyph joins the current note if it starts within 1.6 s of the previous stroke and near the note.
- The toolbar's handwriting toggle turns detection off (everything becomes ink).
- The glyph scale uses only the horizontal zoom, because price auto-scale changes the vertical
  scale during horizontal panning and would make notes breathe.

### 5.3 Cross-timeframe readiness

Everything is absolute time, and `ref` is px **per millisecond**, not per bar. A drawing
therefore renders correctly on any timeframe once the query stops filtering by timeframe. The
schema keeps `timeframe` as a plain column, so sharing later is a query/visibility change, not a
rewrite.

### 5.4 Wyckoff label stamps (`stamps.ts`)

- **Vocabulary**: the 16 Wyckoff events in cycle order (PS SC AR ST Spring Test LPS SOS BU JAC /
  PSY BC UT UTAD SOW LPSY), the three waves of Phase B (1st B, 2nd B, 3rd B) and Phases A–E; the
  chip tooltips give each event's full name and what each phase does.
- **Pick, then tap**: the label tool (`L`) shows a strip of chips over the top of the chart. A
  tapped chip is armed until another one is picked, so repeated labels (ST, ST, Test) take one tap
  each. The strip lies over the price scale's top margin instead of resizing the chart, and
  scrolls sideways (finger or mouse wheel) where it is wider than the chart.
  - Where that margin (8 % of the pane) is smaller than the strip plus a label, the label tool
    widens it (`ChartController.setTopInset`): the highest bar keeps room for a label above it
    below the strip. This moves the candles a little when the tool is picked, on short panes
    only (phones, 11" iPads in landscape); the default margin comes back with the other tools.
    A change requested while the pen is down waits until it lifts, like data updates.
  - Nothing is stamped under the strip (`DrawingEngine.setCoveredTop`).
- **Where a stamp lands** (`placeStamp`): the bar under the pen is the one with the nearest centre.
  - Events and B waves go above its high when the pen is above the bar's middle, below its low
    otherwise: the anchor is the bar's open time and its exact high or low.
  - Phases go to the bar's time at the pen's price (`at`), drawn in a box.
  - Off the bars (the future area, before the first bar) a stamp stays where it was placed (`at`).
  - The stamp follows the pen while it is down (a ghost in the live layer, snapping bar to bar) and
    is committed where the pen lifts; lifting outside the pane (e.g. over an axis) or under the
    strip places nothing, and the ghost disappears while the pen is there. A hovering pen (and the mouse in
    mouse-draw mode) shows a faint ghost first. The high and low come from the displayed bar
    (`ChartController.barAt`), which cannot change under the pen (updates are deferred while it
    is down).
- The **text** is stored, not an id: stamps stay readable (and machine-readable: "SC at this bar's
  low") without the vocabulary, and a label a newer version adds still renders on an older one.
  Validation accepts any single line of 1–24 characters.
- Erasing, selecting, moving, recolouring and undo work on the stamp's screen box. A moved stamp
  lands like a placed one, with its text standing in for the pen: on the bar it is dropped on,
  above its high if the text is dropped above the bar's middle, below its low otherwise (the move
  preview shows it there). A move that leaves it where it was is not an edit (no undo step, no
  sync).

## 6. Market data

Three markets, chosen for free data with **consolidated volume** (volume analysis is the point of
Wyckoff study; a single-exchange feed shows a few percent of it):

| Market id | What | Upstream | Freshness |
|---|---|---|---|
| `binance` | every Binance Spot pair | Binance public API, no key | real time |
| `us` | US stocks and ETFs, regular hours | Alpaca market data, free paper-account key | 15 min delayed (free plan: every exchange, `end` must be ≥ 15 min old); `ALPACA_FEED=sip` with a paid plan |
| `futures` | 15 CME Group futures (`server/market/futures.ts`), continuous front month, Globex hours | Yahoo Finance's chart API (unofficial), no key | 10 min delayed (CME on Yahoo) |

Measured on the free plan (2026-09-25): AAPL over 2½ hours, the real-time IEX feed saw **4.3 %**
of the consolidated volume, so real-time-but-partial was rejected in favour of delayed-but-complete.
The market id is also the drawings' namespace (`ChartKey.provider`): `us` and `futures`, not
`alpaca` or `yahoo`, so drawings survive a change of data vendor (a futures broker's feed when
trading starts). Existing crypto drawings keep `binance`.

### 6.1 Bar clocks and trading sessions (`shared/sessions.ts`)

A `BarClock` says which bar open times exist: `next`, `prev`, `latest` (the newest bar that has
started), `bucket` (the bar containing a time, or null outside sessions) and `end`.

- Crypto: `fixedClock(ms)`, every interval around the clock, aligned to the UTC epoch.
- US stocks: `SessionCalendar.clock(ms)` from Alpaca's calendar (2015–2029, holidays and 13:00
  early closes). Intraday bars start at the 9:30 open and repeat until the close; the last one
  can be shorter (hourly: 9:30, 10:30 … 15:30–16:00; 4-hour: 9:30, 13:30). Daily bars open at
  New York midnight (Alpaca's daily timestamps).
- Futures: `globexSessions`, CME Globex hours for every product offered: each trade date's
  session opens at 18:00 New York the evening before (Sunday for Monday) and closes at 17:00, so
  `open < day < close`. Intraday bars start at 18:00 (4-hour: 18, 22, 2, 6, 10, 14, the last until
  17:00); the daily bar is the trade date, at its New York midnight, and takes the evening hours
  before it. Exchange holidays are not modeled: a closed day's slots stay empty (at most one extra
  request when the app checks a gap), and a shortened holiday session (e.g. Labor Day, until about
  13:00) becomes a short daily bar dated on the holiday, where CME books it to the next trade date.
  Daylight saving time changes on Sundays at 2:00, before the week's first open, so one offset
  holds for a whole session.
- The same file runs on the server (Node type stripping; the image copies `shared/`) and in the
  app, so both agree exactly on bar times. It has no imports; times are UTC ms; New York time is
  converted with `Intl` (verified in the `node:24-alpine` image: full ICU).
- Used by: `TimeIndex` (future area, §5.1), `CandleSeries.findGaps` and `CandleFeed` (nights and
  weekends are not missing bars), the server (which slots a request covers, bucketing).

### 6.2 The server's bar cache (`server/market/`)

- `/api/market/bars?market&symbol&tf&limit[&start][&end]` has Binance's klines semantics (latest
  `limit` bars; `limit` bars up to `end`; up to `limit` bars from `start`), in compact arrays
  `[t, o, h, l, c, v, closed]`. Also `/symbol`, `/search`, `/calendar`, `/markets`.
- `market.sqlite` holds closed bars per series (market + symbol + timeframe) and **coverage**:
  time ranges known to be complete. A request computes its bar slots with the clock, fetches
  only the uncovered ranges upstream (one request also brings the forming bar), and stores bars
  and coverage in one transaction. Ranges with no bars upstream (nights, before a listing, an
  exchange outage) are covered too and never requested again.
- The forming bar is never cached; it is fetched fresh, reused for 15 s so devices polling at the
  same time cost one upstream call. A bar is final when it ended `settle` before the data time:
  10 s for Binance (clock skew; the exchange finishing the bar); for Alpaca 60 s after the 15-minute
  delay (late trade reports), and for a **daily** bar the end of the extended session (20:00 New
  York), because its volume counts post-market trades. Requests to Alpaca keep `end` 30 s older
  than the free plan requires (clock skew would otherwise turn into 403s). Futures bars are final
  10 min after Yahoo's 10-minute delay (so 20 min after they end): Yahoo may report late.
- Thinly traded stocks have minutes without trades: requests collect up to 4 chunks to fill
  `limit`, and the app does not backfill holes inside server history (`completeHistory`).
- Requests for one series run one at a time (no duplicate upstream calls). Upstream clients use a
  token bucket (Alpaca 3/s with bursts of 12, below its 200/min; Binance 8/s; Yahoo 2/s, it
  publishes no limit) and retry 429/5xx/network errors with backoff, honouring `Retry-After`.
- Symbol lists (Alpaca assets without OTC, about 13 000; Binance's trading pairs, about 1 400)
  and the calendar are kept in the cache file too, refreshed daily/weekly in the background, and
  loaded at startup. The first request after a fresh install waits for them (Binance's list is
  6 MB and takes a few seconds).
- **Splits.** Bars are split-adjusted (`adjustment=split`), so a split rewrites a stock's past
  prices. Once a day per symbol the service asks Alpaca for splits since its last check (2 days of
  margin) and drops the symbol's cached bars when there was one. A request waits at most 2 s for
  that check (it goes on in the background).
- Failed loads (symbol lists, calendar, split checks) are not retried for 2 minutes, so an
  upstream outage does not turn every request into a multi-megabyte download attempt.
- Every answer of `/api/market` carries `X-Market-Api: 1`. Anything else at that path (market
  data turned off, a static host's `index.html`, a proxy's error page) means "no market server":
  crypto then falls back to Binance directly, and markets the server cannot serve (`/markets`,
  e.g. US stocks without a key) are hidden from search and suggestions.
- It is a cache: its own file, not in backups (`MARKET_DB_FILE`, default
  `$DATA_DIR/market.sqlite`). Deleting it only costs a refetch, except for futures history older
  than Yahoo's (§6.4), which only the cache keeps (`server/backup.ts` with `DB_FILE` pointing at
  it backs it up). A file the server cannot open (corrupt, or a newer schema after a rollback) is
  moved aside (`<file>.unusable-<time>`, with its `-wal`) and an empty one started instead of
  stopping the server.

### 6.3 US stocks: what the bars are

- **Regular hours only** (9:30–16:00 New York). Alpaca's bars include pre- and post-market
  trades; those bars are dropped.
- 1/5/15-minute bars are Alpaca's own. **Hourly and 4-hour bars are built from 30-minute bars**:
  Alpaca's hourly bars are clock-aligned (9:00–10:00 mixes pre-market with the open).
- Daily bars are Alpaca's: official open and close, volume of the whole day including
  pre/post-market.
- The closing auction prints at 16:00:00, so it falls into the post-market minute and is **not in
  intraday bars** (AAPL on 2026-09-24: 5.1 M shares in the 16:00 minute). The daily bar has it.
- Axis and crosshair show New York time (`timeFormat.ts`). Bar times stay absolute UTC. The
  time scale weighs tick marks in the same zone (`ZonedTimeScale`): Lightweight Charts alone puts
  day and month marks where the UTC date changes, which for futures is 20:00 New York.

### 6.4 Futures: what the bars are

- **Continuous front month**, as Yahoo stitches it (`ES=F`): it moves to the next contract during
  roll week (September 2026: Monday the 14th, around 11:00 New York, four days before expiry),
  **unadjusted**, so price jumps by the calendar spread (about 65 points for ES) between two bars,
  like TradingView's ES1!. The 4-hour and daily bars that contain the roll mix both contracts.
- 1/5/15-minute and hourly bars are Yahoo's. **4-hour and daily bars are built from hourly bars**:
  Yahoo's own daily bars switch contracts on another day (at expiry), so drawings would not line
  up across timeframes during roll week, and its latest daily volume was a stale copy of the day
  before (2026-09-25). Hourly bars sum to 3–7 % less volume than Yahoo's daily figure, partly
  because of the session's first bar (below); every timeframe uses the same data, so they agree.
- Daily bars for trade dates older than Yahoo's hourly history (two years) are Yahoo's daily bars.
- Yahoo serves 1-minute bars for 30 days (8 days per request), 5 and 15 minutes for 60 days,
  hourly for 730 days, daily since 2000 (each contract from its own first day, `dataFrom` in
  `futures.ts`); it refuses anything older (HTTP 422, or 400 "Data doesn't exist" before a
  contract's first day). The client asks for none of it: it clamps to Yahoo's limit, and callers
  plan with a day to spare (`historyStart`), so a range is still served when its request goes out.
- **Yahoo's volume quirks** (checked live, 2026-09-26):
  - the first row of every intraday answer has no volume: requests start 30 bars early and drop
    those rows (without it, every newly closed bar would have been stored with volume 0);
  - after the daily break (18:00 New York, Monday to Thursday evenings) the session's first bar has
    no volume wherever it is (the minute, 5 minutes or hour), so hourly-built 4-hour and daily bars
    of Tuesday to Friday miss the 18:00–19:00 volume. Sunday's open keeps its volume, except the
    first 1-minute bar (18:10);
  - 1-minute data has no rows for 23:59 and 00:00–00:08 New York each night (their volume lands in
    the next row); in 5-minute data the 00:00 bar is empty and 00:05 carries its volume;
  - the newest row of an answer is the latest trade (time of the trade, no volume): it is folded
    into the bar it falls in. An answer ending before today also carries today's price at 23:59
    New York the evening before, after the range: only the range filter in `parseRows` keeps it
    out, so never loosen it. Rows without prices (breaks, weekends) are skipped.
- **Archive**: Yahoo drops old intraday history, so twice a day (first run 2 minutes after
  startup) the server fetches everything its cache is missing within Yahoo's history, for every
  timeframe of each futures symbol charted so far, one step (1 500 bars) per lock, so charts and
  polls get in between. Then it fetches the last day again and stores it over the cached bars: a bar
  is final 20 minutes after it ends by the server's clock alone, so a late or revised Yahoo bar is
  repaired within 12 hours. ES costs about 3 MB for the first run (57 000 bars, 20 s) and about
  25 MB a year after that (1-minute bars are most of it).
- A 4-hour bar is only built when all its hours are within Yahoo's hourly history.

### 6.5 Live updates

- Crypto: straight from Binance's stream on each device (the fastest path; unchanged code).
- US stocks and futures: the app polls `/api/market/bars?limit=3` once a minute, 35 s after it
  turns (the US data trails by the delay plus the 30 s margin, so each poll sees the minute that
  just ended), and when the app becomes visible again. Futures bars stay revisable for 10 minutes,
  so their polls cover that span (`revisableMs`: 12 one-minute bars, 4 five-minute bars) and an
  open chart sees each bar's final version. Alpaca's stream was rejected: it allows one connection per
  account (a dev server, the home server and trading bots would take it from each other), and
  with minute bars 15 minutes late it delivers the same data. A failed poll shows
  "Reconnecting"; the next success makes the feed backfill what it missed.
- The top bar shows "15m delayed" (stocks) or "10m delayed" (futures) for delayed data.

### 6.6 In the app

- **`MarketDataProvider`**: `prepare(symbol, timeframe)` (symbol details + bar clock; each
  market's calendar is loaded once) + `fetchCandles(request)` + `subscribeCandles(symbol, timeframe, listener)`,
  normalized `Candle` (ms open time, numbers, `closed` flag). The `Workspace` prepares a chart
  before starting its feed (retried every 10 s if the server cannot answer); switching charts
  aborts a pending preparation.
- **Markets of a page load** (`runtimeConfig.createMarkets`): the server (default); `?provider=mock`
  (crypto-, US- and futures-like mock markets); `?provider=binance` (crypto from Binance directly, no
  server). In the default mode crypto history falls back to Binance directly when the server is
  unreachable (not when it answers with an error).
- **Symbol search** (`SymbolSearch.tsx`): the server ranks exact symbols (and a coin's pairs:
  "btc" means Bitcoin) first, then symbols and names starting with the query; recent symbols are
  kept on the device.
- **`CandleSeries`**:
  - Merge semantics: a closed bar never regresses; between open versions the higher trade count
    or volume wins. This handles out-of-order REST vs stream data.
  - Duplicates resolve by open time.
  - Every merge reports `tail` (incremental), `prepend`, or `general` (full re-sync).
- **`CandleFeed`**:
  - Subscribes before loading history and buffers updates in between.
  - Detects skipped bars and backfills them; confirmed exchange gaps are never re-fetched.
  - Re-fetches a bar whose final update was missed.
  - Backfills from the last bar after every reconnect (`onResync`).
  - Pages older history when the view nears the oldest bar.
- **Binance REST**: `data-api.binance.vision`, falling back to `api.binance.com`, then `api-gcp`.
  - Error responses carry no CORS headers, so a 429 is an opaque `TypeError` in the browser.
    Every failure is therefore treated as a possible rate limit: global backoff 2–60 s with
    jitter, then host rotation.
  - Requests are serialized at ≥ 250 ms intervals.
- **Binance WS**: one combined-stream socket (`data-stream.binance.vision`, then `stream.binance.com:9443`, then `:443`).
  - SUBSCRIBE/UNSUBSCRIBE are paced below 5 messages/s.
  - Backoff with jitter, and host rotation when a connection never opens.
  - Reconnect triggers: 30 s silence watchdog, 23 h rotation, `serverShutdown` events,
    `online`, and `visibilitychange`.
  - A socket with no subscriptions closes after 10 s of lingering.
- **While the pen is down**, chart data updates are deferred (`ChartController.beginDeferUpdates`),
  so neither a new bar nor an auto-scale change moves the surface under the nib.

## 7. Persistence and synchronization

- **Local-first.**
  - IndexedDB (`sync/localDb.ts`) stores `drawings` (records + tombstones + last server `rev`),
    `outbox` and `meta` (pull cursors).
  - `outbox` holds one coalesced pending change per drawing, with `opId`, `baseRev`, `owner`,
    `sent` and `prevOpIds`.
  - Each local edit writes its record and outbox entry in **one transaction**.
  - Offline use is fully functional; the server is only needed to share drawings between devices.
- **Outbox ownership.** Each entry records the user it was queued for, and only the current user's
  entries are sent. Today there is one user; the rule keeps accounts safe once they exist.
- **Multiple tabs.** Tabs share one IndexedDB. A `BroadcastChannel` announces every local write
  and every merged remote change, so other open tabs reload the affected chart instead of
  showing stale drawings (and later overwriting newer ones).
- **Self-hosted server** (`server/`, one Docker container):
  - Node 24 runs the TypeScript directly (type stripping, so no build step); `ws` is its only
    dependency.
  - It serves the built app (`dist/`) and the API on one origin: no CORS, and a proxy login
    (Cloudflare Access) covers both.
  - Storage is SQLite through `node:sqlite`:
    - WAL with `synchronous = full`, so a committed write survives a power loss (with `normal` it
      could be rolled back after devices already had it);
    - one file on a Docker volume, schema versions in `PRAGMA user_version`;
    - consistent online backups (`server/backup.ts`, `VACUUM INTO`) and a restore tool
      (`server/restore.ts`);
    - a startup check that the file is writable (a read-only file opens silently and only fails
      on the first write); `/api/health` repeats it for the container health check.
  - `npm run dev` embeds the same API in the Vite dev server (`server/vitePlugin.ts`).
- **Server restored or replaced (generation).** The database carries a random `generation`. It
  changes when `restore.ts` puts a backup in place, and a new (empty) database has its own. The
  server reports it in `/api/session` and in the `hello` of every live connection; each device
  stores the one it last synced with.
  - If it differs, the device's server revisions and pull cursors no longer mean anything. The
    device queues every drawing it has again as new (base revision 0) and drops its tombstones
    (`LocalDrawingDb.resetForServer`).
  - The server keeps its version where it has one (a conflict, which the device adopts). It gets
    back drawings it lost, e.g. those created after the backup, or everything after a lost volume.
  - Without this, devices would believe they were in sync with a server that went back in time:
    newer revisions would be skipped as "already seen", and lost drawings never re-uploaded.
- **Durable model.** Table `drawings`:
  - one row per drawing, with a client-generated UUID and `user_id`;
  - `provider`, `symbol`, `timeframe`, `kind`, `data` (JSON);
  - `deleted` (tombstone), `rev`, `last_op_id`, `created_at`;
  - `updated_at`: server time, strictly increasing, so a pull cursor never skips a write.
- **Identity, and auth later.**
  - There is no sign-in. `identify()` in `server/app.ts` is the only place that decides who is
    calling (HTTP and WebSocket alike, and it may be async), and today it returns the single user
    `local` for every request.
  - Every row still has an owner. `GET /api/session` tells the client its user id; the client
    caches it, so an offline start keeps attributing queued edits to that user.
  - Adding auth later means:
    - `identify()` returns null for unauthenticated requests (401, WebSocket refused) and the
      user otherwise, e.g. from the verified Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) or
      a session cookie;
    - the app shows a sign-in screen when `/api/session` answers 401 (the client already has a
      `signed-out` state);
    - with expiring credentials, live connections are closed when they expire (they are only
      checked when they open);
    - one data step: assign the rows owned by `local` to the first account
      (`update drawings set user_id = ? where user_id = 'local'`), and have the client treat
      outbox entries queued as `local` like unowned ones (adopted by whoever signs in). Otherwise
      those drawings stay invisible and their edits come back `rejected`.
  - Cross-site protection: writes require `Content-Type: application/json` (a cross-site form
    cannot send it), and the live connection only accepts pages of its own origin (`Origin` host =
    `Host`, or `ALLOWED_ORIGINS`), because WebSockets are not covered by CORS. Not covered: DNS
    rebinding against the HTTP API from a website visited on the LAN (no `Host` allowlist). With
    no accounts, the network (LAN or Cloudflare Access) is the boundary.
- **API.** The contract is `src/sync/protocol.ts`: types only, imported by the client and the
  server.
  - `GET /api/health`, `GET /api/session`;
  - `GET /api/login?next=/path`: redirects back to the app (see Cloudflare below);
  - `POST /api/changes`: up to 200 changes, a result for each;
  - `GET /api/drawings?provider&symbol&timeframe&since&limit`: pull, oldest first;
  - WebSocket `/api/live`:
    - server → client: `hello`, `rows` (every change, to every device of the user, the writer
      included), `preview`, `ping`;
    - client → server: `preview`.
- **Write semantics** (optimistic compare-and-swap in `server/store.ts`, one transaction per batch):
  - unknown id → insert at rev 1;
  - id owned by someone else → `rejected` (reveals nothing);
  - same `op_id` as the last applied op → `duplicate`, i.e. an idempotent retry (**duplicate prevention**);
  - `rev = base_rev` → applied, `rev + 1`;
  - the row was last written by one of the client's own earlier ops (`prev_op_ids`: sent, but
    the response was lost) → applied as well. Without this, "response lost, then edited again"
    would be reported as a conflict and the newer edit would be dropped.
  - otherwise → `conflict`: the server version wins and the client adopts it.
  - A malformed or oversized change → `invalid`. It is reported per change and the rest of the
    batch still applies. The client drops that change and shows a persistent sync error; an
    unrelated successful pull does not hide it.
  - Limits, as a guard against runaway clients:
    - 100 000 live drawings per user (`MAX_ROWS`; tombstones do not count). A change that would
      exceed it is `invalid` on its own; edits, deletions and the rest of the batch still apply.
    - 16 MB per request.
- **Race-free rebasing** (found and fixed through tests):
  - A change's base revision comes only from state inside the IndexedDB write transaction (the
    pending entry's base, else the record's `rev`). An in-memory "in flight" flag was tried first
    and lost a race with the acknowledgement.
  - An acknowledgement rebases any successor edit queued on the same base.
  - A `duplicate` answer adopts the server row, which may have moved on since the lost response.
  - Deletions are always queued as tombstones, even for drawings that may not have reached the
    server yet (the create could be in flight).
- **Reads**:
  - paged pulls with `updated_at >= cursor - 2 min`, merged by `rev` (re-reads are idempotent);
  - live rows over the WebSocket;
  - every (re)connect, `online` or visibility change triggers a pull (the live feed has no replay).
- **New drawing kinds.** A version skips rows of kinds it does not know (`parseDrawing` returns
  null) but still moves its pull cursors past them. So each set of kinds keeps its own cursors
  (`pullCursorKey`: `cursor:ink+line+glyph+stamp:<user>:<chart>`): after an update that adds a
  kind, the first pull of every chart is a full one, and a tab or window still running the older
  version (same IndexedDB) cannot move the newer version's cursors. Without it, stamps drawn on
  another device before this one updated would never appear on it.
- **Connection.** One WebSocket per device:
  - it reconnects with jittered backoff (1 s, doubling to 30 s), and immediately on `online` or
    when the app becomes visible again;
  - subscribers hear "connected" only after the server's `hello`, so the generation is known
    before they resynchronize;
  - the server sends a heartbeat every 25 s, so proxies such as Cloudflare keep idle sockets open;
  - 60 s of silence counts as a dead connection on the client; a missed pong drops it on the server;
  - an attempt that has not opened within 15 s is abandoned, and coming back to the app after
    more than 35 s of silence reconnects at once (iOS suspends background sockets);
  - HTTP requests time out after 30 s, so a hung request cannot block syncing.
- **Behind Cloudflare Zero Trust:**
  - the manifest is requested with credentials (`useCredentials`); otherwise Access redirects the
    anonymous request and installing the app fails;
  - API requests use `redirect: 'manual'`, so an expired Access session is detected instead of
    surfacing as a CORS failure. The sync panel then offers **Sign in again**: a navigation to
    `/api/login?next=…`. The service worker never answers `/api/` from its cache, so the request
    reaches Access, which shows its login and returns there; the server redirects back into the
    app. A plain reload would not work: the service worker serves the app shell from cache;
  - cache headers suit the edge: hashed assets are immutable; `index.html`, `sw.js` and the
    manifest are always revalidated.
- **Ephemeral previews:** the stroke in progress (throttled to 90 ms, downsampled) goes over the
  WebSocket and the server relays it to the user's other devices.
  - They are never stored. The server rebuilds each one from its known fields before relaying, so
    nothing unchecked is ever re-serialized.
  - Points are only computed while the connection is open, so there is no work when nobody listens.
  - The final message says `commit` or `discard`. On `commit` the preview stays until the durable
    drawing arrives; on `discard` it disappears immediately. Previews that stop updating expire
    after 5 s, so no ghost strokes are left behind.
- **Verification:**
  - **Server unit tests:**
    - the store: compare-and-swap, tombstones, `prev_op_ids`, `invalid`, per-change quota,
      timestamp order, migrations, generation, the read-only file check, backup;
    - `restore.ts` run for real, including a stale write-ahead log that must not be replayed (a
      negative control, with the removal disabled, fails);
    - the HTTP API and its error codes, `/api/login` (no open redirect), health on an unwritable
      database, async `identify()`;
    - the WebSocket: who receives rows, preview relay, heartbeat and dead-peer drop, the Origin
      check;
    - hostile input: a preview with 100 000 levels of nesting, a malformed upgrade request, a
      failing identity check (each crashed the process before the review fix);
    - static serving: traversal attempts, cache policy, SPA fallback.
  - **Client against a real in-process server:** `ServerRemote` round trips, reconnect after a
    server restart (with the new generation), detection of proxy login redirects, and two
    complete devices (IndexedDB, outbox, sync engine) syncing live.
  - **Sync engine against `FakeBackend`** (unit tests): offline queueing, lost responses, conflicts,
    in-flight rebase, invalid changes, user switches, catch-up pull, a replaced server, a restored
    server.
  - **Real browsers against the production server** (Playwright `sync` project, a fresh server
    per test):
    - two devices draw and erase, compared exactly;
    - a label stamp;
    - live preview;
    - a device opened later;
    - the offline queue;
    - a conflicting edit;
    - a lost response followed by another edit;
    - a server rebuilt with an empty database (devices upload their drawings again);
    - an expired proxy login: "Sign in again" and back to syncing;
    - a server restart with automatic reconnect.
  - **Docker:** the image was built and smoke-tested: health check, app and manifest, API,
    non-root user, data kept across a restart, graceful stop. The README's compose backup and
    restore commands were run as written.
  - **Not covered:** an actual Cloudflare Tunnel and Access setup; physical devices.

## 8. Screenshot

- `chart.takeScreenshot(false, false)` returns panes + axes + committed drawings (main canvas),
  without the crosshair, live stroke or selection outlines.
- **Copy:** `navigator.clipboard.write([new ClipboardItem({'image/png': promise})])`, called
  synchronously in the tap (Safari requirement).
- **Share:** `navigator.share({ files })`, the iPad fallback. `<a download>` is unreliable in iOS
  Home Screen apps.
- **Download:** `<a download>` on desktop and Android.

## 9. Main risks

| Risk | Mitigation |
|---|---|
| Real Pencil/S Pen behaviour differs from simulation | Documented physical test plan ([DEVICE_TESTING.md](DEVICE_TESTING.md)). Routing never relies on `touchType`, and every touch event is blocked. Only the pen-crosshair filter relies on compat mouse events following their pointer event (spec order, observed in Chromium). |
| LWC internals change (time-scale formula used for anchored zoom) | Formula isolated in `ChartController.timeViewAnchored/logicalAt`; E2E test asserts the zoom anchor stays under the fingers. |
| Palm rejection thresholds | Constants in one place (`PALM`, `NAV`); tuned on hardware. |
| Handwriting misclassification | Handwriting toggle. Glyph vs ink only changes zoom behaviour, never position. |
| Binance geo-blocking (HTTP 451, e.g. US) | Market-data-only host first; provider interface allows swapping. |
| Alpaca changes its free plan (limits, the 15-minute rule, the calendar/assets endpoints) | All Alpaca calls are in `server/market/alpaca.ts`; the market id `us` is vendor-neutral, so another vendor plugs in without touching drawings. |
| Yahoo changes or blocks its unofficial chart API | Futures stop updating; the cached history stays. All Yahoo calls are in `server/market/yahoo.ts` and the market id `futures` is vendor-neutral: a broker feed or Databento replaces it without touching drawings. `FUTURES_DATA=off` turns it off. |
| Bar cache grows without bound | Only what is viewed is cached, plus the futures archive: ~55–70 bytes per bar, e.g. one year of 1-minute bars ≈ 7 MB per stock, ≈ 35 MB per crypto pair, ≈ 25 MB per future (all timeframes). Deleting `market.sqlite` is safe, but loses futures history older than Yahoo's. |
| `node:sqlite` is still experimental in Node 24 | The image pins Node 24; all SQL sits behind `DrawingStore` (one file), so a switch to `better-sqlite3` stays local. |
| Cloudflare Tunnel/Access behaviour (idle timeouts, login redirects, manifest fetch) | Heartbeats every 25 s, redirect detection, credentialed manifest; still to be checked on the real setup (DEVICE_TESTING §6). |

## 10. Known limitations

- **Unverified on hardware.** No physical Apple Pencil or S Pen was available. Everything in
  [DEVICE_TESTING.md](DEVICE_TESTING.md) is unverified, notably:
  - pressure feel and latency;
  - palm-rejection thresholds;
  - the S Pen barrel-button eraser (likely unsupported by Chromium's mapping);
  - Scribble interference;
  - hover behaviour.
- **iPad:** pen and finger cannot act at the same instant (Safari input exclusivity).
- **Handwriting vs drawing** is a heuristic, with a toggle to turn it off. Changing an existing
  drawing's kind after the fact is not implemented.
- **Label stamps:**
  - one size (12 px text) at every zoom; two stamps on the same bar extreme overlap;
  - a stamp on the bar still forming keeps that bar's high or low at the moment it was placed; if
    the bar extends, the label overlaps it (moving the stamp a little snaps it to the new extreme);
  - with the mouse they need mouse-draw mode, like every drawing;
  - after a rollback to a server image without stamps, every stamp change (new stamps, and moves,
    recolours and deletions of synced ones) is refused (`invalid`) and dropped from the outbox:
    the device that made it keeps it, the other devices do not get it, and it is not sent again
    when the server is upgraded. The sync status shows the error until the next clean send;
  - while a browser profile still has a tab or window of a version without stamps open, that
    version shares the outbox and may receive the answer for a stamp changed in the updated one.
    After a conflict or a lost response it cannot store the server's copy of the stamp, so the
    stamp's next change conflicts and is replaced by the server's version.
- **Eraser** removes whole strokes. There is no partial (pixel) erasing.
- **Scales:** crypto times are shown in UTC, US stocks and futures in New York time (no local-time option). A log price scale is not supported,
  because `Viewport` uses a linear price mapping behind a `PriceMapping` interface.
- **Scope:** six timeframes. Sharing drawings across timeframes is modelled but not exposed in
  the UI.
- **US stocks:**
  - regular hours only (no pre/post-market option yet);
  - the cache has no eviction (see §9 for its size);
  - the closing auction's volume is not in intraday bars (§6.3);
  - 15 minutes delayed on the free plan, and live bars arrive once a minute;
  - two decimals for every stock (sub-dollar stocks show rounded prices);
  - a long stretch without any bar (a halted stock, or thousands of minutes without trades) can end
    the loading of older history early: a request collects at most 4 chunks, and an empty page
    tells the app that history is exhausted;
  - no indices (SPX, VIX): ETFs such as SPY and QQQ, or the futures, stand in;
  - **drawings are not rescaled after a split**: the cached bars are, so drawings on a stock that
    split sit at the old price level (the server's `updated_at` of each drawing says which price
    basis it was drawn in, so a rescale can be added later).
- **Futures:**
  - Yahoo's API is unofficial: no agreement, it may change or block without notice;
  - 10 minutes delayed, polled once a minute;
  - continuous front month, unadjusted: prices jump at each roll, and the 4-hour and daily bars
    of the roll mix both contracts (§6.4); no back-adjusted series, no single contract months;
  - exchange holidays and early closes are not in the session calendar: closed days leave empty
    slots, and a shortened holiday session is a short daily bar of its own (CME books it to the
    next trade date);
  - 15 products with Globex hours; grains (other hours), Treasuries (prices in 32nds) and Micro WTI
    (no daily history on Yahoo; CL has the same prices) are left out;
  - Yahoo reports no volume for the first bar after the daily break (18:00 New York, Monday to
    Thursday; on hourly bars the whole first hour) and has a hole in 1-minute data around midnight
    New York (§6.4);
  - the history before the cache started archiving is Yahoo's: 1-minute bars from 30 days, 5 and
    15 minutes from 60 days, hourly and 4-hour bars from two years back.
- **Binance** returns HTTP 451 in restricted jurisdictions (e.g. the US). Error bodies are
  CORS-opaque, so the exact reason can't be shown in the browser.
- **No accounts:** anyone who can reach the sync server can read and change the drawings. Keep it
  on the LAN or behind Cloudflare Access; a published port bypasses Access. There is no `Host`
  allowlist, so DNS rebinding from a website visited on the LAN could reach the HTTP API. §7
  describes how auth plugs in later, including the one data step.
- **Cloudflare Zero Trust** was not tested end to end (tunnel, Access login expiry, WebSocket
  through the tunnel). The known problems are handled in code, see §7.
- **Clipboard image writes** vary by browser and by iOS Home Screen context; Share and Download are
  the fallbacks.

## 11. Decision log

| Decision | Alternatives | Why |
|---|---|---|
| Block all Touch Events from LWC; own touch navigation | Filter touches per id; synthesize events | LWC's `_activeTouchId` / `event.touches` logic can't be partially fed; ours allows palm rollback |
| Committed drawings as `'normal'` series primitive; live overlay canvas | All primitives; all overlay | Same-frame sync + screenshots; `'top'` = crosshair canvas (repainted per mouse move, not in screenshots) |
| Persist absolute time + price; own fractional mapping | Logical indices; LWC coordinate APIs | Indices shift on history load; LWC converts integer logicals only |
| Handwriting = rigid glyph notes (sqrt-damped, clamped uniform scale) | Distort with chart; constant pixel size | Legible under non-uniform zoom yet still "belongs" to the chart |
| Wyckoff labels as a `stamp` kind placed by pick-then-tap | Handwritten labels only; tap a bar, then pick from a menu at the pen | Handwriting stays available; stamps are neat at any zoom, sit exactly on the bar's high or low, and can be read by code later. Pick-then-tap keeps the chart uncovered and repeats a label with one tap |
| Stamps store their text | A label id | Readable without the vocabulary; labels a newer version adds still render on older ones |
| Label strip over the chart's top margin, widened on short panes while the tool is on | A row that resizes the chart; a strip that covers labels above the highest bars | A resize moves the candles on every tool switch on every screen; widening the margin moves them a little, and only where the default margin is too small |
| Lifting a stamp outside the pane cancels it | Always commit (like ink) | A press has no other way to take a mis-tap back before it is saved and synced |
| Defer market-data updates while the pen is down | Let chart move | The surface must not move under the nib |
| Self-hosted sync server in one container | Supabase (hosted or self-hosted) | One user, no accounts, own server: Supabase's auth/Postgres/Realtime stack (about 10 containers self-hosted) is more machinery than needed. The same sync semantics fit in a small Node server. The Supabase version is in the Git history (first commit). |
| SQLite via `node:sqlite` | Postgres; `better-sqlite3` | One file to back up; no database container; no native module to compile |
| App and API on one origin | Separate API host | No CORS; one Cloudflare Access application covers both; relative URLs |
| No auth now; one `identify()` hook; every row owned | Build accounts now | Not needed yet. Adding auth later is contained: the hook, a sign-in screen, and re-owning the `local` rows (§7) |
| Database generation, devices re-upload on change | Treat restores as out of band | A restored or rebuilt server would otherwise silently diverge from devices that "already have" newer revisions |
| One WebSocket (`ws`) for live rows and previews | Server-sent events + POST; polling | Two-way (previews), one connection per device, works through Cloudflare Tunnel |
| TypeScript 6.0 | TypeScript 7 | typescript-eslint requires < 6.1 |
| perfect-freehand for all ink | Constant-width polylines | Handwriting quality; 0.08 µs/pt makes per-frame outlines affordable |
| US stocks from Alpaca's free plan, delayed but consolidated | Real-time IEX (free); Massive/Polygon, Twelve Data, Finnhub, Yahoo free tiers | Volume from every exchange matters more than 15 minutes; IEX had 4.3 % of the volume. The others: end-of-day only, ~5 % of the volume, no candles, or unofficial. Upgrade path: the same API in real time ($99/month) is `ALPACA_FEED=sip`. |
| Market data through the server's bar cache | Each device fetches from the upstream (and caches in IndexedDB) | The Alpaca key stays on the server; history fetched once serves every device; charts open from the cache; only missing ranges go upstream. |
| Coverage ranges in the cache | Detect missing bars by gaps between stored bars | Nights, holidays, outages and minutes without trades are indistinguishable from missing data by looking at bars. |
| US live bars by polling once a minute | Alpaca's WebSocket (delayed_sip works on the free plan) | One stream connection per account; the data is minute bars 15 minutes late either way. |
| Session-aware bar clock shared by server and app (`shared/`) | Linear extrapolation; server-generated future times | The future area and gap detection must follow the same calendar the server buckets with. |
| Regular-hours hourly bars built from 30-minute bars | Alpaca's hourly bars | Those are clock-aligned and mix pre-market into the 9:00 bar. |
| Futures from Yahoo Finance (free, unofficial, 10 min late) | Alpaca (no futures data; its futures broker, registered August 2026, has not started); Databento, broker feeds (IBKR, Tradovate) | Free and delayed is enough until trading starts; the others need an account and exchange fees. Upgrade path: another upstream behind the same `futures` market id. |
| Futures 4-hour and daily bars built from hourly bars | Yahoo's own daily bars | Same contract on every timeframe at every moment (Yahoo's daily bars roll on another day; drawings are shared across timeframes); its latest daily volume was stale. |
| Archive Yahoo's intraday history in the cache | Cache only what is viewed | Yahoo drops 1-minute bars after 30 days; "fetch only what is missing" needs the missing part to still exist upstream. |

## 12. Verification strategy

- **Unit (Vitest)**: time mapping (also across sessions), viewport, candle merge/gaps, feed recovery
  (with session clocks), REST pacing/backoff, stream reconnection, QuickShape, classification,
  store/undo, palm/navigation logic, sync engine, the market API client and polling provider,
  label stamps (vocabulary, where a stamp lands, its box, validation, the full pull after an
  update that adds a drawing kind, and a check that the server accepts every kind the app draws).
- **Market-data server (Vitest)**: session clocks (DST, weekends, early closes, next/prev inverse),
  the bar cache and its coverage, regular-hours bucketing, the service against fake upstreams
  (only missing ranges fetched, forming bar reuse, exchange gaps, the 15-minute rule, split purge,
  thinly traded stocks, symbol ranking), futures (Globex sessions across midnight and DST, daily
  bars from hourly ones and from Yahoo's before its hourly history, 4-hour bars from 18:00 and none
  from partial hours, the end of Yahoo's history, nothing before a contract's data, the archive and
  its re-fetch of the last day, no symbol list loaded at startup), Yahoo's answers (the volume-less
  first row dropped, empty rows, the latest-trade row, history limits, "no data" as empty, errors)
  and the HTTP API (validation, 401/404/502/503, an unusable cache moved aside).
- **App (Vitest)**: tick marks weighed in the exchange's time zone (`ZonedTimeScale`), polls that
  cover the bars the server may still revise, markets an older server does not have, the mock's
  paging of futures daily bars.
- **Sync server (Vitest)**: SQLite store, HTTP API, WebSocket hub, static serving, and the client
  transport against a real in-process server (see §7, Verification).
- **Browser (Playwright, Chromium)**:
  - trusted **touch** and **pen** input via CDP (`Input.dispatchTouchEvent`, `Input.dispatchMouseEvent` with `pointerType: 'pen'`);
  - anchoring under pan/zoom/resize/history-load, measured against the chart's own bar coordinates, plus painted-pixel checks;
  - palm rules, cancel/blur cleanup, gestures, and crosshair suppression (screenshot pixel diff);
  - mouse navigation/drawing;
  - label stamps: the strip, placement above a high / below a low / a phase at the pen height (in
    its box), following the pen until it lifts, cancelled when lifted outside the chart or under
    the strip, painted in the chart canvas, erase/select/undo, a nudge that is no edit, a move
    that lands on another bar, the room kept under the strip above the highest bar (made only
    once the pen lifts), the `L` shortcut, reload (also in the WebKit iPad-like context);
  - persistence across reload; screenshot PNG content and clipboard;
  - the Binance code path against mocked REST/WebSocket (`page.route`, `page.routeWebSocket`).
- **Browser (Playwright, Chromium), markets**: US mock sessions (regular hours only; a drawing in
  the future area stays on its bar over the weekend; symbol search switches markets), futures mock
  sessions (bars across midnight, no daily break or weekend, trade-date daily bars, the future-area
  drawing over the weekend, the symbol search opens a future), the server
  path with a mocked API (history from the server, live from Binance, fallback when unreachable,
  errors shown).
- **Browser (Playwright, WebKit)**: iPad-like context (DPR 2, iPad user agent, synthetic pointer
  events) covering drawing, QuickShape, panning, anchoring, pixels, persistence and export. This
  shows engine compatibility, not Apple Pencil behaviour.
- **PWA (Playwright against the production server)**: manifest, service-worker activation, offline shell reload.
- **Multi-device sync (Playwright `sync` project, production server)**: see §7, Verification.
- **Docker**: image build and a container smoke test (not part of `npm run e2e`).
- **Not provable in automation:** real Apple Pencil / S Pen behaviour. Covered by the
  [device test procedure](DEVICE_TESTING.md).
