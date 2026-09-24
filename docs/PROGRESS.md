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
| 13 | Physical device testing (iPad + Apple Pencil, Galaxy Tab + S Pen) | ❌ not possible here — see `DEVICE_TESTING.md` |
| 14 | Self-hosting: Dockerfile, docker-compose, online backup/restore | ✅ done (image built and smoke-tested with Docker Desktop; not yet on your server) |

## Verification snapshot (2026-09-24, final)

- `npm run lint` clean · `npm run typecheck` clean · `npm run build` OK
- Unit: 148 tests (19 files), including the sync server (store, API, WebSocket, static files,
  backup, restore, hostile input) and the client against a real in-process server
- Browser: 48 tests:
  - 36 Chromium (CDP trusted pen/touch);
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

- Device testing on iPad + Galaxy Tab per `DEVICE_TESTING.md`; tune `PALM`, `NAV`, `QUICKSHAPE`,
  `HANDWRITING` constants from the results.
- Deploy on your server (`docker compose up -d --build`) behind the Cloudflare Tunnel, then run
  the sync checks in `DEVICE_TESTING.md` §6 (Access session expiry, idle connections, restarts).
- Accounts, when needed: implement `identify()` (e.g. verify the Cloudflare Access JWT), a
  sign-in state in the UI, re-owning the `local` rows, and closing live connections when
  credentials expire (ARCHITECTURE §7, "Identity, and auth later").
- Optional hardening: a `Host` allowlist against DNS rebinding on the LAN.
- Candidates (not started): cross-timeframe drawing display, rectangle/ellipse QuickShape,
  partial eraser, local-timezone axis, log price scale (needs a log `PriceMapping`), converting a
  selection between note/ink.
