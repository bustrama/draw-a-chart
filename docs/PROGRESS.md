# Implementation progress

Resume here in a new session. Newest notes at the top of each section.

## Milestones

| # | Milestone | Status |
|---|---|---|
| 1 | Repo scaffold, toolchain, research, architecture | ✅ done |
| 2 | Market data layer (types, CandleSeries, CandleFeed, Binance REST/WS, mock provider) + unit tests | ✅ done |
| 3 | Chart adapter (ChartController, TimeIndex, Viewport) | ✅ done |
| 4 | Drawing engine (pen strokes, QuickShape, ink/glyph classification, erase, select/move, recolor, undo/redo, primitive + live layer) | ✅ done |
| 5 | Input routing (InputRouter, TouchNavigator, PalmPolicy) | ✅ done |
| 6 | Playwright E2E: anchoring, input routing, cancel cleanup, gestures, market data via mocked Binance | ✅ done |
| 7 | Local persistence (IndexedDB, outbox) | ✅ done |
| 8 | Screenshot (copy/share/download) | ✅ done |
| 9 | Sync across devices + live previews through a self-hosted server (SQLite + WebSocket; no accounts yet, auth-ready). Replaced the Supabase version (first commit) | ✅ done, **not yet run behind the real Cloudflare Tunnel/Access** |
| 10 | PWA (manifest, icons, SW with update prompt) | ✅ done |
| 11 | WebKit (iPad-like) browser tests | ✅ done |
| 12 | Final verification + independent review | ✅ done (21 review findings fixed, 15 with a regression test) |
| 13 | Physical device testing (iPad + Apple Pencil, Galaxy + S Pen) | ✅ tested by the user on an iPad Pro (Apple Pencil) and a Galaxy S26 Ultra (S Pen), 2026-09-25: "works just great". The itemized `DEVICE_TESTING.md` results were not recorded. |
| 14 | Self-hosting: Dockerfile, docker-compose, online backup/restore | ✅ deployed (home server behind Cloudflare Tunnel + Access; image built on a PC and shipped; nightly backups) |
| 15 | Market data: server bar cache (fetch only what is missing), US stocks and ETFs (Alpaca free plan: every exchange, 15 min delayed, regular hours), every Binance pair, symbol search, trading-session clocks (future area and gaps follow the calendar), New York time axis | ✅ deployed 2026-09-25 (1087971) |

## Verification snapshot (2026-09-25, market data)

- `npm run lint` clean · `npm run typecheck` clean · `npm run build` OK
- Unit: 215 tests (26 files), including the sync server (store, API, WebSocket, static files,
  backup, restore, hostile input), the client against a real in-process server, the market-data
  server (sessions, cache, service against fake upstreams, HTTP API) and the market client
- Market API against the live upstreams (in process and in the Docker image with a 256 MB limit:
  about 64 MB after loading both symbol lists and the calendar)
- Browser: 55 tests:
  - 43 Chromium (CDP trusted pen/touch; 7 new for markets);
  - 2 WebKit iPad-like;
  - 1 PWA against the production server;
  - 9 multi-device sync (27/27 over 3 repeated runs).
- Docker: the image builds (60 MB). A container smoke test passed: health, app and manifest, API,
  non-root user, data kept across a restart, 0.3 s graceful stop. The README's compose backup and
  restore commands (`server/restore.ts`) were run for real: backed-up state restored, file owned
  by `node`, new generation, container healthy.
- Visual capture (`e2e/visual.capture.ts`) reviewed at iPad landscape/portrait, desktop and Slide Over (320 px)
- Perf probe (`e2e/perf.capture.ts`, headless desktop Chromium, 287 visible drawings while panning):
  drawing-layer paint median 0.3 ms, frame gap median 16.7 ms
- Not verified: anything on a physical iPad/Galaxy tablet; the real Cloudflare Tunnel/Access setup

## Log

- 2026-09-26 (Access login on the Galaxy): the app asked to sign in for sync, and **Sign in
  again** only reloaded it. The server was fine (sync answered on the LAN, the service worker leaves
  `/api/` to the network). Deleting the site's cookies in Chrome and signing in fixed it.
  - New: `REQUEST_LOG=1` logs one line per request (path, status, request kind, browser family,
    how long the Access token is valid; never tokens or identities). With it on, every request
    from the Galaxy passed Access after the fix, and the token was valid **24 hours**: the Access
    application's session is 24 h, not the month the runbook said. It is off again.
  - To do (user, Cloudflare dashboard): set the Access application's session duration to 1 month.
  - Suspected cause: a stale Access cookie the new login did not replace (unconfirmed).
- 2026-09-25 (market data, deployed): 1087971 runs on the home server with the Alpaca key in its
  `.env`. Checked on the LAN: health, session (drawings intact: the existing BTCUSDT 1h drawings are
  still served under `binance`), markets, bars, search; the first US request after the restart took
  13 s (it waited for the symbol lists being loaded at startup), repeats 80 ms; memory about
  100 MB of the 256 MB limit; the public hostname still answers with the Access login.
- 2026-09-25 (market data): faster data and more instruments.
  - Data sources compared (current docs): Alpaca's free plan is the only free source of US stock
    bars with volume from every exchange (15 minutes delayed); its real-time IEX feed saw 4.3 % of
    AAPL's volume, useless for volume analysis. Massive/Polygon free = end of day, Finnhub free =
    no candles, Twelve Data ≈ 5 % of the volume, Yahoo unofficial. Crypto stays on Binance.
  - The key was verified from the PC and from the server (paper account, consolidated bars since
    2016, the last 15 minutes refused, the delayed stream accepted) and stored in the server's
    `.env` only.
  - Server: `server/market/` (bar cache with coverage ranges in `market.sqlite`, Binance and
    Alpaca clients, `/api/market/*`). Cold load of 1000 bars 1-2 s, warm 2-3 ms (measured against
    the live APIs). Split checks purge a stock's cache.
  - `shared/sessions.ts`: trading calendar and bar clocks for both sides. The chart's future area
    follows the next sessions, so a target drawn after Friday's close lands on Monday's bar
    (unit test + a browser test across a reload on Monday).
  - App: markets registry, async chart preparation, `ServerMarketProvider` (history from the
    server; crypto live from Binance's stream; US polled once a minute; crypto falls back to
    Binance directly if the server is unreachable), symbol search with recent symbols, "15m
    delayed" status, New York time axis.
  - Found by tests while building it: the daily split check could never run again (an async
    check that finished synchronously was registered after its own cleanup); search ranked
    "Maui Land & Pineapple" above Apple for "apple".
  - Changed decision: US live updates poll the server instead of Alpaca's stream (one stream
    connection per account; same minute bars either way).
  - Independent review: 11 findings, no critical ones; 10 fixed, each with a test where it can be
    tested:
    - drawings more than 1500 bars into the future lost the session calendar (the table now grows);
    - without a market-data API at the page's origin even crypto failed (answers are now marked
      `X-Market-Api`; anything else means "no server" and crypto falls back to Binance);
    - US daily bars were cached 16 min after the close, without the post-market volume (final
      after 20:00 now);
    - the daily split check could hold every US request for a minute (now at most 2 s) and retried
      on every request while failing (failed loads back off for 2 min, also symbol lists and the
      calendar);
    - thin clock-skew margins (30 s for Alpaca, 10 s for Binance, polls 35 s after the minute);
    - an unusable cache file stopped the whole server (now replaced by an empty one);
    - US stocks were suggested when the server has no key; `?symbol=aapl` created its own drawing
      namespace; upstream requests followed redirects with the key headers.
    - Documented instead: a long stretch without bars can end older history early (ARCHITECTURE §10).
- 2026-09-25 (app icon): the installed app's icon sat in a frame. The icon generator's defaults
  (`@vite-pwa/assets-generator`, preset `minimal-2023`) put the already full-bleed tile on a white
  background with 30% padding for the maskable (Android) and Apple touch icons, and left a
  transparent margin around the others (desktop Chrome).
  - `pwa-assets.config.ts` generates every icon with no padding and the app background;
    `npm run icons` regenerates them from `public/logo.svg`. File names are unchanged, so the
    Access bypass still covers them.
  - `logo.svg` is redrawn with bolder candles and pen stroke for small sizes, with all ink inside
    the maskable safe zone, so one tile serves as both the desktop and the Android icon.
    `favicon.svg` shows the same glyph on a rounded tile.
  - New PWA E2E test: every manifest icon and the touch icon has its declared size and opaque,
    background-coloured corners (it fails on the old icons).
  - Not checked on a device. An already-installed app keeps the old icon until it is reinstalled
    (after accepting the update prompt, since the service worker precaches the icons).
- 2026-09-25 (deployed): running on the home server behind Cloudflare Tunnel + Access.
  - The server is short on RAM, so it never builds: the image is built on a PC
    (`docker buildx build --platform linux/amd64 --provenance=false`), tagged `:latest` and
    `:<git sha>` (a rollback is a re-tag), and shipped with `docker save | ssh … docker load`.
  - A server-only compose override (not committed): another host port, `build: !reset null` +
    `pull_policy: never` (a missing image fails instead of building), the data directory as a
    bind mount owned by the container's user (uid 1000, so backups are plain files) and
    `mem_limit: 256m`. The container uses about 30 MB.
  - Access guards everything except the PWA files (manifest and icons), which bypass it so
    installation works; `/api/` is never bypassed.
  - Nightly backups with `server/backup.ts` (`docker compose exec -T`), kept 30 days. The first
    copy passed `integrity_check` and was restored with `restore.ts` in a throwaway directory.
  - Checked from outside: `/`, `/api/*`, the app shell and the WebSocket redirect to the Access
    login; the PWA files answer 200 with the origin's bytes; path tricks through a bypassed file
    (`..`, `%2e%2e`, `\`, `//`) never reach the API. On the LAN, the live connection accepts the
    public origin (101) and refuses a foreign one (403); the tunnel keeps the Host header.
  - Still to do: the device checks in `DEVICE_TESTING.md` §6 (6.5–6.12) through Access.
- 2026-09-24 (self-hosted): Supabase replaced by a self-hosted sync server, for one user, no
  accounts, running on your own server behind Cloudflare Zero Trust. The Supabase version is the
  first commit in Git.
  - `server/`: Node 24 runs the TypeScript directly. It stores drawings in SQLite (`node:sqlite`),
    keeps the same compare-and-swap semantics as the SQL function, and has one WebSocket for live
    rows and previews. It also serves `dist/`, so there is one origin.
  - `identify()` is the single place where auth will plug in, and every row keeps an owner.
  - Client: `ServerRemote` + `SyncSession` replace the Supabase remote and `AuthStore`. The sync
    engine, outbox and conflict handling are unchanged.
  - For Cloudflare: the manifest is requested with credentials, Access login redirects are
    detected, and a heartbeat keeps WebSockets open.
  - `npm run dev` embeds the same API (Vite plugin). Docker: multi-stage image (60 MB) and a
    compose file with a named volume. `server/backup.ts` makes online backups, and README
    documents the restore.
  - Tests:
    - server unit tests: store, API, WebSocket, static files, backup;
    - the client against a real in-process server: restart and reconnect, proxy redirects, two
      full devices;
    - Playwright `sync` project against the production server;
    - a Docker smoke test.
  - Removed: Supabase client and CLI, the SQL migration and its PGlite tests, the live Supabase
    tests, the sign-in UI, and the unused `happy-dom`.
  - Found by running the documented Docker restore: `docker compose cp` creates root-owned files,
    so moving the backup into place left a database the `node` user could not write, and the
    server crash-looped. `server/restore.ts` now puts it in place as the server's user.
  - An independent review found 10 issues. All are fixed except two, which are documented (a
    `Host` allowlist, and closing live connections when future credentials expire).
    - **One request could crash the server:** a deeply nested preview (re-serialized), a
      malformed upgrade URL, or an exception in `identify()`. Previews are now rebuilt from
      checked fields, and every upgrade path is guarded.
    - **Behind Cloudflare Access, the installed app could never log in again:** the service
      worker answered every reload from cache. "Sign in again" now goes through `/api/login`,
      which the service worker never intercepts.
    - **Hitting the quota froze all sync:** it failed the whole batch and counted tombstones. It
      is now checked per new drawing, for live drawings only.
    - **A restored or rebuilt server silently desynchronized devices:** the database now has a
      generation, and devices requeue everything when it changes. The fix also includes
      `synchronous = full`, a writability check at startup and in `/api/health`, and
      `server/restore.ts`.
    - **Smaller fixes:** request, connect and resume-staleness timeouts on the client; an Origin
      check on the live connection; async `identify()`.
    - **Docs corrected:** adding auth later does need one data step (re-owning the `local` rows);
      publishing the port bypasses Access; the health check follows `PORT`.
- 2026-09-24 (live sync): Sync tested without a Supabase account. The Supabase CLI (dev
  dependency) runs Postgres, Auth, PostgREST and Realtime locally in Docker, and
  `e2e/sync.supabase.ts` drives the real app in two browser profiles plus Node-side clients.
  Found and fixed:
  - **Reads failed with "permission denied" on new Supabase projects.** New projects no longer
    grant the API roles access to new tables, and the migration relied on the old automatic grant.
    The PGlite test had hidden this by granting it in its own setup. The migration now grants
    `SELECT` to `authenticated` explicitly (and revokes the rest). `migration.test.ts` now runs
    under both defaults, and a regression test fails without the grant.
  - A disposed runtime left its Supabase client auto-refreshing the session (visible as the
    dev-only "Multiple GoTrueClient instances" warning from StrictMode's double mount); it now
    stops. A shared per-page client was tried and rejected: realtime-js returns a channel that is
    still being torn down for a reused topic.

  Confirmed on the real stack: the private preview channel refuses another account both for
  listening (join error) and for sending over HTTP ("Unauthorized").

- 2026-09-24 (final): Visual review found the screenshot panel clipped at 320 px (Slide Over).
  Popovers now shift to stay on screen, and an E2E test keeps all three panels inside 320 px.
  One full E2E run had 3 failures because docs were edited during the run: `@tailwindcss/vite`
  forces a full page reload when any file it scans for class names changes, and it scanned the
  whole project. A probe confirmed it (editing README.md reloaded the open app; after the fix it
  does not). Tailwind now scans `src/` only (`source('.')`). This also stops doc edits from
  reloading the dev app mid-stroke.
  New tests close gaps in the review fixes: the per-user quota boundary (SQL on PGlite), the
  2 000-point stroke cap (simplify, then split without losing points) and pressure carry-over.
- 2026-09-24 (review): Independent review by two reviewers (input/rendering; sync/security/market
  data). All 21 findings fixed.
  - 15 have a regression test (unit, SQL or E2E; local-scope sign-out via `npm run e2e:supabase`).
  - 6 were fixed and checked by code review only, with no automated test: preview discard/expiry
    (the commit path is covered live), lazily computed preview points, hover/eraser state, safe
    areas, Space reset on blur, and move-preview rendering.

  The main findings:
  - Sync: a lost response followed by another edit was reported as a conflict and the edit was
    lost → `prev_op_ids`.
  - Sync: one oversized stroke blocked all syncing → per-change `invalid`, 2 000-point cap, and a
    persistent error that a pull cannot hide.
  - Sync: queued changes were not tied to a user → outbox `owner`.
  - Sync: tabs diverged → `BroadcastChannel`.
  - Sync: sign-out mid-flush leaked in-flight state; sign-out was global → `scope: 'local'`.
  - Sync: a per-user quota was added and sign-up is hidden by default.
  - Sync: ghost previews → `commit`/`discard` end messages, and previews are sent only once the
    channel is joined.
  - Market data: a bar that closed during the initial load was never finalized.
  - Input: strokes started before a navigation had painted were offset → settling + `PendingStart`.
  - Input: a pinch jumped when history was prepended → `anchorFromEnd`.
  - Input: a lost pen-up could leave the palm guard stuck → capture every contact, window safety
    net.
  - Input: moving a selection could hide drawings on Esc; pressure 0 pinched ink; the eraser
    button was read from stale hover state.
  - Performance: committed ink paint is 7 ms → 0.3 ms (Path2D cache with affine re-projection).
  - Layout: safe areas, scrollable bars and the palette position on narrow screens.

- 2026-09-24 (later): Stage 5 complete. Bugs found by tests and fixed:
  - Sync: an in-memory "in flight" flag raced with acknowledgements (entry stuck forever) → base
    revision now derived inside the IndexedDB transaction; ack rebases successors; `duplicate`
    adopts the server row.
  - Keyboard shortcuts silently dead while the symbol `<select>` had focus → only text entry
    blocks shortcuts; select blurs after change.
  - Axis double-tap never fired (axis gestures had no pending phase) → fixed + unit test.
  - Crosshair followed the pen (LWC positions it on `mouseenter`, which precedes the first
    pointermove) → crosshair hidden while the pen is in use, restored by mouse/finger.
  - Local-only mode showed a misleading "changes waiting to sync" badge.
- 2026-09-24: Core PoC running against live Binance data. Found and fixed: (a) `scrollToRealTime()`
  animates and briefly exposed old bars, triggering pagination → use `scrollToPosition(12,false)`;
  (b) default `maxBarSpacing` (= width/2) is 0 before first layout → explicit `maxBarSpacing: 80` and
  re-apply the initial view on first non-zero size; (c) StrictMode double effects → provider and
  workspace share one lifecycle.

## Known gaps / next steps

- Access login: if **Sign in again** comes back still signed out, the app could say so and
  explain clearing the site's cookies (today it just asks again). DEVICE_TESTING 6.9 on the iPad
  is still untested.
- Market data: a pre/post-market option for stocks; rescale drawings after a stock split (the
  cache is rescaled, drawings are not; ARCHITECTURE §10); price precision for sub-dollar stocks;
  the closing auction in the last intraday bar; real-time US data when trading starts
  (`ALPACA_FEED=sip` on the paid plan, or a broker feed such as IBKR); indices/futures.
- Device testing on iPad + Galaxy Tab per `DEVICE_TESTING.md`; tune `PALM`, `NAV`, `QUICKSHAPE`,
  `HANDWRITING` constants from the results.
- Deployed behind the Cloudflare Tunnel + Access (2026-09-25): run the sync checks in
  `DEVICE_TESTING.md` §6 on the devices (Access session expiry, idle connections, restarts).
- Accounts, when needed: implement `identify()` (e.g. verify the Cloudflare Access JWT), a
  sign-in state in the UI, re-owning the `local` rows, and closing live connections when
  credentials expire (ARCHITECTURE §7, "Identity, and auth later").
- Optional hardening: a `Host` allowlist against DNS rebinding on the LAN.
- Candidates (not started): cross-timeframe drawing display, rectangle/ellipse QuickShape,
  partial eraser, local-timezone axis, log price scale (needs a log `PriceMapping`), converting a
  selection between note/ink.
