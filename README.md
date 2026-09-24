# draw-a-chart

A personal, stylus-first charting PWA for studying and practising Wyckoff analysis.

- **The pen draws** (Apple Pencil, Samsung S Pen) with no tool selection. Hold still at the end of a
  line to straighten it (QuickShape). Pressure-sensitive ink, eraser, lasso select, undo/redo.
- **Fingers navigate**: pan with momentum, pinch-zoom, tap/long-press crosshair, axis scaling. They
  never draw, and a resting palm is rejected.
- **The mouse navigates** like any chart. Press `D` (or the mouse button in the tool rail) to draw with it.
- Binance Spot live candles (BTCUSDT, ETHUSDT · 1m, 5m, 15m, 1h, 4h, 1D).
- Drawings are anchored to chart time/price, saved locally, and optionally synced in real time
  across devices via Supabase.
- Screenshot: copy to the clipboard, share, or download as PNG.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. Append `?provider=mock` for offline, deterministic data.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (Vitest) |
| `npm run e2e` | Browser tests (Playwright: Chromium + WebKit + PWA build). The first time, run `npm run e2e:install`. |
| `npm run e2e:supabase` | Live sync tests against a local Supabase stack (see [Testing sync without a Supabase account](#testing-sync-without-a-supabase-account)) |
| `npm run build` / `npm run preview` | Production build / serve it |
| `npm run lint`, `npm run typecheck` | Static checks |

To use it on a tablet, the app must be reachable over **HTTPS** (see [docs/DEVICE_TESTING.md](docs/DEVICE_TESTING.md)).

## Cloud sync (optional)

Without configuration the app is fully functional and stores drawings in the browser (IndexedDB).
To sync across devices:

1. Create a Supabase project.
2. Apply the schema. Either:
   - paste `supabase/migrations/20260924000000_drawings.sql` into the SQL editor and run it, or
   - run `supabase link` then `supabase db push`.
3. Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` (Project Settings → API).
4. Create your account. Either:
   - in the Supabase dashboard: Authentication → Users → Add user (email + password, auto-confirm), or
   - temporarily set `VITE_ALLOW_SIGNUP=true` so the sign-in form offers "Create an account
     instead", then remove it again.

   Then **turn off "Allow new users to sign up"** in Auth settings. The data is protected by
   row-level security either way (plus a per-user row quota), but there is no reason to leave
   sign-ups open.
5. Optional: in Realtime settings, disable "Allow public access". The live-preview channel is
   private and authorized per user.

Sign-in is email + password. Magic links are deliberately not used: on iOS, a Home Screen app has
storage that is isolated from Safari, so a link opened in Safari cannot sign the app in.
Signing out only signs out this device and keeps the drawings stored on it.

### Testing sync without a Supabase account

The Supabase CLI (a dev dependency) runs the real Supabase services locally in Docker: Postgres,
Auth, the REST API and Realtime. No account or cloud project is needed, only Docker.

```bash
npm run supabase:start   # first run downloads the Supabase images; applies supabase/migrations
npm run e2e:supabase     # two browser "devices" of one user + a second account, against the local stack
npm run supabase:stop    # stop it when done (it listens on all network interfaces with default keys)
```

The tests create and delete their own users. They cover two-device sync, live previews, the
offline queue, conflicting edits, lost responses, per-device sign-out, and what another account
can and cannot reach.

To try the app itself against the local stack:

1. Put the Project URL and publishable key printed by `npx supabase status` into `.env.local`, plus
   `VITE_ALLOW_SIGNUP=true`.
2. Restart `npm run dev`.
3. Create an account in the sign-in form. Local sign-ups need no email confirmation.

Replace those values before pointing the app at a real project.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design decisions, platform facts, risks, limitations
- [docs/DEVICE_TESTING.md](docs/DEVICE_TESTING.md): physical Apple Pencil / S Pen test procedure
- [docs/PROGRESS.md](docs/PROGRESS.md): implementation status
- [CLAUDE.md](CLAUDE.md): project rules for AI-assisted development

Lightweight Charts™ by TradingView (Apache-2.0). The attribution logo stays enabled, as its license requires.
