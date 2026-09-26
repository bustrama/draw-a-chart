# draw-a-chart

A personal, stylus-first charting PWA for studying and practising Wyckoff analysis.

- **The pen draws** (Apple Pencil, Samsung S Pen) with no tool selection. Hold still at the end of a
  line to straighten it (QuickShape). Pressure-sensitive ink, eraser, lasso select, undo/redo.
- **Wyckoff labels** (`L`, or the tag in the tool rail): pick a label from the strip (the 16
  events, 1st/2nd/3rd B, Phases A–E), then tap bars with the pen. Events land on the bar's high or
  low, depending on which half of the bar you tap.
- **Fingers navigate**: pan with momentum, pinch-zoom, tap/long-press crosshair, axis scaling. They
  never draw, and a resting palm is rejected.
- **The mouse navigates** like any chart. Press `D` (or the mouse button in the tool rail) to draw with it.
- **Markets:** every Binance Spot pair (live); US stocks and ETFs (regular hours, volume from
  every exchange; 15 minutes delayed on Alpaca's free plan); and futures (ES, NQ, YM, RTY and their
  micros, crude oil, gas, gold, silver, copper, euro; continuous front month, CME Globex hours, 10
  minutes delayed, from Yahoo Finance). Symbol search across all of them; timeframes 1m, 5m, 15m,
  1h, 4h, 1D. The server caches history and fetches only what is missing, so charts open instantly
  on every device.
- Drawings are anchored to chart time/price, saved on the device, and synced live across all
  your devices through a small self-hosted server (one Docker container).
- Screenshot: copy to the clipboard, share, or download as PNG.

## Self-hosting (Docker)

One container serves the app and its sync server; drawings live in a SQLite database on a Docker
volume. There are no accounts: every device that opens the app syncs (see [Security](#security)).

```bash
git clone https://github.com/bustrama/draw-a-chart.git
cd draw-a-chart
docker compose up -d --build
```

Then open `http://<server>:8080` on each device. Update with `git pull && docker compose up -d --build`.

**HTTPS.** Installing the app to the home screen, starting it offline and copying screenshots
need HTTPS. With **Cloudflare Zero Trust**:

1. Create a tunnel (Networks → Tunnels) and add a public hostname whose service is
   `http://<server-ip>:8080`, or `http://draw-a-chart:8080` when `cloudflared` runs in the same
   compose project (a commented-out service is in `docker-compose.yml`; keep the token in `.env`).
2. Protect the hostname with an Access application if you like. The app is built for it: the
   manifest is requested with credentials, and when the Access session expires the sync panel
   offers **Sign in again** (a normal reload would be answered by the app's offline cache and
   never reach the Access login).
3. WebSockets must stay enabled for the hostname (they are by default); live sync uses one.

**Backups.** Everything is in one SQLite file. This writes a consistent copy while the server
runs and prints its path (for example `/data/backup-2026-09-24T18-00-00-000Z.sqlite`):

```bash
docker compose exec draw-a-chart node --disable-warning=ExperimentalWarning server/backup.ts
```

Copy it off the server with `docker compose cp draw-a-chart:<printed path> .`.

To restore a backup (`backup.sqlite` in the current directory), with the server stopped:

```bash
docker compose stop draw-a-chart
docker compose cp ./backup.sqlite draw-a-chart:/data/restore.sqlite
docker compose run --rm --no-deps draw-a-chart node --disable-warning=ExperimentalWarning server/restore.ts /data/restore.sqlite
docker compose start draw-a-chart
```

`restore.ts` copies the backup into place (owned by the server's user), removes the old
write-ahead log (SQLite would otherwise replay it onto the restored file), and marks the database
as restored. Devices notice when they reconnect: the backup's version of each drawing wins, and
drawings the backup does not have are uploaded again from the devices that still have them. The
same happens automatically if the server ever starts with an empty database (e.g. a lost volume).

**US stocks.** Put an Alpaca API key in a `.env` file next to `docker-compose.yml` (never commit
it). A free paper-trading account is enough: [app.alpaca.markets](https://app.alpaca.markets) →
Paper Trading → API Keys.

```bash
APCA_API_KEY_ID=...
APCA_API_SECRET_KEY=...
```

The free plan gives 15-minute-delayed data from every US exchange. With a paid real-time plan,
add `ALPACA_FEED=sip`. Without a key the app has no US stocks.

**Futures** need nothing: they come from Yahoo Finance's chart data (no key, 10 minutes delayed).
It is unofficial, so it can change or be blocked without notice; `FUTURES_DATA=off` turns
futures off. Yahoo keeps 1-minute bars for 30 days, 5- and 15-minute bars for 60 days and hourly
bars for two years, so twice a day the server saves every timeframe of each future you have
opened: the history keeps growing past Yahoo's (about 25 MB per contract per year). Yahoo's data
has quirks: no volume on the first bar after the daily break (18:00 New York, Monday to Thursday)
and no 1-minute bars just after midnight New York (docs/ARCHITECTURE.md §6.4).

**The bar cache** (`market.sqlite` next to the drawings) is a cache: it is not in the backups,
and deleting it only costs a refetch, except for futures history older than Yahoo's, which only
the cache has. To keep that too, back it up like the drawings:
`docker compose exec -e DB_FILE=/data/market.sqlite draw-a-chart node --disable-warning=ExperimentalWarning server/backup.ts /data/market-backup-$(date +%F-%H%M).sqlite`
(a new file each time: the backup refuses to overwrite one).
To restore it, stop the container, put the backup in place as `market.sqlite` (delete
`market.sqlite-wal` and `-shm`), and start it again. A cache the server cannot open is moved
aside to `market.sqlite.unusable-<time>`, not deleted.

Server settings (environment variables) are listed in `.env.example` and `server/main.ts`.

### Security

There is no sign-in: anyone who can reach the server can read and change the drawings.

- **Behind Cloudflare Access only?** Don't publish the port on the LAN: in `docker-compose.yml`
  use `127.0.0.1:8080:8080`, or no port mapping with `cloudflared` in the same compose network.
  A published port is reachable by every device on the network without going through Access
  (and Docker's published ports bypass host firewalls such as ufw). On a VPS, never publish it.
- **On a LAN:** the live connection refuses pages from other sites. A website visited on your
  network could still reach the HTTP API through DNS rebinding, so treat the LAN as trusted.
- **Accounts later.** One function (`identify()` in `server/app.ts`) decides who is calling, and
  every drawing has an owner. Today everything belongs to the single user `local`. Turning on
  accounts means implementing `identify()` (e.g. verifying the Cloudflare Access JWT) plus one
  data step: assign the `local` drawings to your account and let devices adopt edits they queued
  as `local` (see ARCHITECTURE §7).

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` includes the sync API and the market-data API
(databases in `.data/`; US stocks need the Alpaca key in `.env`, see above), and it listens on the
LAN, so phones and tablets can open `http://<this-pc>:5173` and sync with it. Append
`?provider=mock` for offline, deterministic chart data (a crypto and a US-like market),
`?provider=binance` for crypto straight from Binance without the server, or `?sync=off` to keep a
page load local-only.

| Command | What it does |
|---|---|
| `npm test` | Unit tests (Vitest), including the sync and market-data server |
| `npm run e2e` | Browser tests (Playwright: Chromium, WebKit, the production build, multi-device sync). The first time, run `npm run e2e:install`. |
| `npm run build` / `npm start` | Production build / serve it with the sync server on port 8080 |
| `npm run lint`, `npm run typecheck` | Static checks |

To use it on a tablet, the app must be reachable over **HTTPS** (see [docs/DEVICE_TESTING.md](docs/DEVICE_TESTING.md)).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design decisions, platform facts, risks, limitations
- [docs/DEVICE_TESTING.md](docs/DEVICE_TESTING.md): physical Apple Pencil / S Pen test procedure
- [docs/PROGRESS.md](docs/PROGRESS.md): implementation status
- [CLAUDE.md](CLAUDE.md): project rules for AI-assisted development

Lightweight Charts™ by TradingView (Apache-2.0). The attribution logo stays enabled, as its license requires.
