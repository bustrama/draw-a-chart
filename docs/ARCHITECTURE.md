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
| Market data | Binance Spot public REST + WebSocket | No keys. Behind a provider interface. |
| Persistence | IndexedDB (`idb`) locally + Supabase (Auth, Postgres, Realtime) | Local-first; Supabase optional at runtime. |
| PWA | `vite-plugin-pwa` 1.x (`registerType: 'prompt'`) | Auto-update could reload mid-stroke, so updates are prompted instead. |
| Tests | Vitest 5 (unit, PGlite for SQL) + Playwright 1.63 (Chromium via CDP for trusted touch/pen input; WebKit iPad-like context; PWA build) | |

There is no state-management framework. The engine is plain TypeScript classes, and React
subscribes via `useSyncExternalStore`.

## 2. Module map

```
src/
  market/            provider-agnostic market data
    types.ts         Candle, MarketDataProvider, LiveStatus
    candleSeries.ts  sorted/deduped bars, merge semantics, change classification, gap finder
    candleFeed.ts    one symbol+timeframe: history, live, pagination, gap backfill, resync
    binance/         REST client (paced, failover, backoff), stream client (one socket), provider
    mock/            deterministic provider (?provider=mock) for offline dev and E2E
  chart/
    ChartController  owns Lightweight Charts: data sync, deferral, viewport, navigation setters
    timeIndex.ts     time <-> fractional logical index (the anchoring core)
    viewport.ts      immutable pane transform snapshot used by all drawing code
  drawing/
    model.ts         Drawing types (ink / line / glyph), validation, glyph scale
    store.ts         DrawingStore + History (undo/redo) = DrawingDocument per chart
    DrawingEngine    tools, stroke sessions (draw/erase/select), QuickShape, notes, live layer
    quickShape.ts    line recognition, hold detection, angle snapping
    classify.ts      handwriting vs drawing classification, note grouping
    render/          shared stroke renderer, chart primitive, live overlay canvas
  input/
    InputRouter      capture-phase gatekeeper: routes pen/touch/mouse, blocks touch events
    TouchNavigator   finger pan/pinch/kinetic/crosshair/axis gestures via the chart API
    palmPolicy.ts    palm rejection rules
  sync/
    localDb.ts       IndexedDB: drawings (+tombstones, server rev), outbox, cursors
    PersistentDocuments  documents backed by IndexedDB (ordered writes, load-race safe)
    SyncEngine       flush (CAS RPC), pull, realtime merge, previews, retries
    supabaseRemote   Supabase implementation of RemoteApi; auth.ts = email/password store
  app/
    Workspace.ts     chart composition (chart + feed + engine + navigator + router)
    runtime.ts       app composition (provider, persistence, sync, auth, previews, workspace)
    screenshot.ts    capture, clipboard, share, download
  ui/                React controls (top bar, tool rail, palette, screenshot, account/sync)
supabase/migrations/ schema, RLS, write RPC, realtime + private broadcast policies
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
    e.g. 80 missing 1m bars on 2023-03-24);
  - it extrapolates with the nominal interval before the first and after the last bar, so
    future-area anchors stay put as new bars arrive.
- `Viewport` then applies LWC's linear time scale:
  - x = x(0) + L · barSpacing, with x(0) and barSpacing read from the public API each frame;
  - price uses a linear mapping sampled from the series.

Unit tests cover prepend stability, future-area stability, gaps and round trips. E2E tests cover
pan, zoom, resize and history load.

### 5.2 Three drawing kinds

| Kind | Stored as | Behaviour |
|---|---|---|
| `line` | two (time, price) points | Straight on screen between exact chart coordinates (QuickShape result). |
| `ink` | (time, price, pressure) per point | Glued to the price action; deforms with non-uniform zoom exactly like the candles. Used for circles, boxes, projected paths. |
| `glyph` | anchor (time, price) + CSS-px offsets at a reference scale + `ref` (px per ms when written) | Handwriting. Rigid: moves with its anchor and scales **uniformly**: `k = clamp(sqrt(zoom ratio), 0.5, 2)`. Never distorted, always legible. Glyphs written in quick succession share a `group` and anchor, forming a note. |

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

## 6. Market data

- **`MarketDataProvider`**: `fetchCandles(request)` + `subscribeCandles(symbol, timeframe, listener)`,
  normalized `Candle` (ms open time, numbers, `closed` flag).
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
  - Offline and credential-less use are fully functional; Supabase is optional at runtime.
- **Outbox ownership.** Each entry records the user it was queued for. Only entries of the
  signed-in user are sent, so changes made under one account can never be uploaded to another.
  Edits made while signed out or in local-only mode are adopted by the next sign-in.
- **Multiple tabs.** Tabs share one IndexedDB. A `BroadcastChannel` announces every local write
  and every merged remote change, so other open tabs reload the affected chart instead of
  showing stale drawings (and later overwriting newer ones).
- **Durable model.** Table `drawings`:
  - one row per drawing, with a client-generated UUID and `user_id`;
  - `provider`, `symbol`, `timeframe`, `kind`, `data jsonb`;
  - `deleted` (tombstone), `rev`, `last_op_id`, timestamps.
- **Security.**
  - Clients may only `SELECT` their own rows (RLS, `(select auth.uid()) = user_id`); there are no
    insert/update/delete policies.
  - Table privileges are explicit: `authenticated` gets `SELECT` only, and `anon` gets nothing.
    New Supabase projects no longer grant the API roles access to new tables automatically
    (without the grant every read failed with "permission denied": found by the live tests).
    Older projects grant everything, which the migration revokes.
  - All writes go through `apply_drawing_changes(jsonb)`: `SECURITY DEFINER`, `search_path = ''`,
    explicit ownership checks, executable by `authenticated` only. `rev`, `user_id` and `last_op_id`
    therefore cannot be tampered with through PostgREST.
- **Write semantics** (optimistic compare-and-swap):
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
  - A per-user quota (100 000 rows) fails the whole call. This is defence in depth in case
    sign-ups are left open; sign-up is hidden in the UI unless `VITE_ALLOW_SIGNUP=true`.
  - The function runs on real Postgres in `migration.test.ts` (PGlite): RLS with role switching,
    direct-write denial, CAS, `prev_op_ids`, idempotency, tombstones, `invalid`, quota. It runs
    under both privilege defaults (older projects: everything granted; new projects: nothing).
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
  - Realtime Postgres Changes filtered by `user_id` for live updates;
  - every (re)subscribe, `online` or visibility change triggers a pull (Postgres Changes has no replay).
- **Ephemeral previews:** in-progress strokes are broadcast (throttled to 90 ms, downsampled) on
  the private channel `preview:<uid>` (RLS on `realtime.messages`).
  - They are never persisted.
  - Points are only computed while the channel is joined, so there is no REST fallback and no
    work when nobody listens.
  - The final message says `commit` or `discard`. On `commit` the preview stays until the durable
    drawing arrives; on `discard` it disappears immediately. Previews that stop updating expire
    after 5 s, so no ghost strokes are left behind.
- **Auth:** email + password. Magic links open in Safari, and iOS Home Screen apps have isolated
  storage.
  - Sign-out is local (`scope: 'local'`), so other devices stay signed in.
  - Local drawings stay on the device.
- **Verification.** Three layers:
  - **SQL on Postgres** (PGlite, unit tests): the migration and the write function.
  - **Sync engine against `FakeBackend`** (unit tests), which implements the RPC's exact semantics:
    - two devices;
    - offline queueing;
    - lost responses, including a lost response followed by another edit;
    - conflicts;
    - in-flight rebase;
    - invalid changes;
    - sign-out mid-flush and account switches;
    - catch-up pull;
    - previews.
  - **The real app against a local Supabase stack** (`npm run e2e:supabase`: real Postgres, Auth,
    PostgREST and Realtime in Docker via the Supabase CLI). Two browser profiles act as two
    devices of one user, and Node-side clients act as a second account. Covered:
    - drawing and erasing across devices, compared exactly;
    - live preview while drawing, replaced by the saved drawing;
    - the offline queue, delivered on reconnect;
    - a conflicting edit (the server version wins on both devices);
    - a lost response followed by another edit (applied through `prev_op_ids`);
    - per-device sign-out (the other device's session still refreshes);
    - another account can neither read nor overwrite, gets `permission denied` on direct writes,
      and is refused on the private preview channel, for both listening and sending.
  - **Not covered:** a hosted project. Its settings differ from the local defaults: Realtime
    "Allow public access", email confirmation, rate limits.

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
- **Eraser** removes whole strokes. There is no partial (pixel) erasing.
- **Scales:** times are shown in UTC (the library default). A log price scale is not supported,
  because `Viewport` uses a linear price mapping behind a `PriceMapping` interface.
- **Scope:** only BTCUSDT/ETHUSDT and six timeframes. Sharing drawings across timeframes is
  modelled but not exposed in the UI.
- **Binance** returns HTTP 451 in restricted jurisdictions (e.g. the US). Error bodies are
  CORS-opaque, so the exact reason can't be shown in the browser.
- **Supabase:** tested end to end against a local Supabase stack (the same services as hosted),
  but not yet against a hosted project; see §7 for what the hosted settings could change.
- **Clipboard image writes** vary by browser and by iOS Home Screen context; Share and Download are
  the fallbacks.
- **Signing out** keeps local data on the device (single-user device assumption).

## 11. Decision log

| Decision | Alternatives | Why |
|---|---|---|
| Block all Touch Events from LWC; own touch navigation | Filter touches per id; synthesize events | LWC's `_activeTouchId` / `event.touches` logic can't be partially fed; ours allows palm rollback |
| Committed drawings as `'normal'` series primitive; live overlay canvas | All primitives; all overlay | Same-frame sync + screenshots; `'top'` = crosshair canvas (repainted per mouse move, not in screenshots) |
| Persist absolute time + price; own fractional mapping | Logical indices; LWC coordinate APIs | Indices shift on history load; LWC converts integer logicals only |
| Handwriting = rigid glyph notes (sqrt-damped, clamped uniform scale) | Distort with chart; constant pixel size | Legible under non-uniform zoom yet still "belongs" to the chart |
| Defer market-data updates while the pen is down | Let chart move | The surface must not move under the nib |
| Writes only via SECURITY DEFINER RPC, read-only RLS | INVOKER RPC + write policies | Rev/owner integrity; tested on Postgres |
| Email + password auth | Magic link / OTP | iOS Home Screen storage isolation; zero email round trip |
| TypeScript 6.0 | TypeScript 7 | typescript-eslint requires < 6.1 |
| perfect-freehand for all ink | Constant-width polylines | Handwriting quality; 0.08 µs/pt makes per-frame outlines affordable |

## 12. Verification strategy

- **Unit (Vitest)**: time mapping, viewport, candle merge/gaps, feed recovery, REST pacing/backoff,
  stream reconnection, QuickShape, classification, store/undo, palm/navigation logic, sync engine.
- **SQL (Vitest + PGlite)**: the Supabase migration on real Postgres, with stand-in `auth` objects.
- **Browser (Playwright, Chromium)**:
  - trusted **touch** and **pen** input via CDP (`Input.dispatchTouchEvent`, `Input.dispatchMouseEvent` with `pointerType: 'pen'`);
  - anchoring under pan/zoom/resize/history-load, measured against the chart's own bar coordinates, plus painted-pixel checks;
  - palm rules, cancel/blur cleanup, gestures, and crosshair suppression (screenshot pixel diff);
  - mouse navigation/drawing;
  - persistence across reload; screenshot PNG content and clipboard;
  - the Binance code path against mocked REST/WebSocket (`page.route`, `page.routeWebSocket`).
- **Browser (Playwright, WebKit)**: iPad-like context (DPR 2, iPad user agent, synthetic pointer
  events) covering drawing, QuickShape, panning, anchoring, pixels, persistence and export. This
  shows engine compatibility, not Apple Pencil behaviour.
- **PWA (Playwright on the production build)**: manifest, service-worker activation, offline shell reload.
- **Live sync (Playwright + local Supabase stack, `npm run e2e:supabase`)**: see §7, Verification.
- **Not provable in automation:** real Apple Pencil / S Pen behaviour. Covered by the
  [device test procedure](DEVICE_TESTING.md).
