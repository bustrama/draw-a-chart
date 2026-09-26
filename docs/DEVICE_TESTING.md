# Physical device test procedure (Apple Pencil, Samsung S Pen)

Automated tests use Chromium's DevTools protocol (trusted touch + pen events) and WebKit with synthetic
pointer events. **Neither proves real stylus behaviour.** Everything in this checklist must be run on
hardware before it can be called verified. Record results in the table at the end
(✅ / ❌ / ⚠️ + note, device, OS and browser versions).

## 0. Setup

1. Serve over **HTTPS** (service workers, clipboard and installation all require a secure
   context; plain `http://<lan-ip>` works for drawing and sync, but not for installing):
   - The intended setup: the Docker container on your server behind a Cloudflare Tunnel (README,
     "Self-hosting"), optionally protected by Cloudflare Access; or
   - a quick tunnel to the dev server (`cloudflared tunnel --url http://localhost:5173`).
2. Test twice where noted: **in the browser** and **installed** (iPad: Share → Add to Home Screen;
   Galaxy: Chrome/Samsung Internet menu → Install app / Add to Home screen).
3. iPad: Settings → Apple Pencil → note whether **Scribble** is on (test both states for section 2).
4. Use `?provider=mock&mockLive=0` for a static chart, or no query for live Binance data.

## 1. Pen vs finger separation (core requirement)

| # | Action | Expected |
|---|---|---|
| 1.1 | Draw a stroke with the pen anywhere on the chart | Ink appears immediately under the nib; no tool selection needed; chart does not move |
| 1.2 | One-finger drag | Chart pans (with momentum on release); no ink |
| 1.3 | Two-finger pinch | Time axis zooms around the fingers; no ink |
| 1.4 | Finger tap on chart | Crosshair toggles on/off; no ink |
| 1.5 | Finger long-press (~0.5 s), then move | Crosshair follows the finger; chart does not pan |
| 1.6 | Drag the price axis with a finger / double-tap it | Price scale stretches / auto-scale restored |
| 1.7 | Drag the time axis with a finger / double-tap it | Bar spacing changes / view resets to latest bars |
| 1.8 | Pen on the price/time axis | Nothing happens (pen never navigates) |
| 1.9 | Pen tap (dot) | A dot is drawn; no crosshair, no click side effects |
| 1.10 | Alternate pen stroke → immediately finger pan → pen stroke | Each input does its own job with no mode switch. NOTE: touches within ~0.45 s after lifting the pen are treated as palm (see 3.x) |
| 1.11 | Fling the chart with a finger (momentum) and start drawing while it still glides | The glide stops; the stroke starts exactly under the nib, with no offset in its first points |

## 2. Stroke quality

| # | Action | Expected |
|---|---|---|
| 2.1 | Write fast cursive and slow small letters | Continuous, smooth strokes; no gaps, no straight-segment "polygon" look |
| 2.2 | Vary pressure while drawing | Stroke width follows pressure (thin light / thick hard) |
| 2.3 | Watch latency during fast strokes | Ink stays close to the nib (compare with Notes / Samsung Notes) |
| 2.4 | Write with Scribble ON (iPad) | Record whether strokes are dropped or turned into text (known iPadOS issue) |
| 2.5 | Tap a toolbar button with a finger, then immediately draw | Record whether the first stroke is lost (known iPad web issue) |
| 2.6 | Long-press with the pen without moving | No text-selection loupe, callout or context menu |
| 2.7 | Mid-stroke, leave the app (home gesture / app switcher), come back | The part drawn so far is kept; the next pen stroke and finger pan work normally (nothing stuck) |

## 3. Palm rejection

| # | Action | Expected |
|---|---|---|
| 3.1 | Rest the palm on the screen, then write | Chart does not move while writing; ink is drawn |
| 3.2 | Palm lands a moment **before** the nib (natural writing) | Any small chart movement the palm caused is undone when the nib lands |
| 3.3 | Write, lift the pen, palm still resting and sliding | No panning |
| 3.4 | Write near the right edge with the palm over the price axis | Price scale does not change |
| 3.5 | Palm resting on one side, pan with a finger of the other hand far away | Chart pans |
| 3.6 | Pencil hover (M2+ iPad Pro / Pencil Pro) or S Pen Air View near the screen, then touch with palm | Palm ignored while hovering; no crosshair chasing the pen |

## 4. QuickShape and gestures

| # | Action | Expected |
|---|---|---|
| 4.1 | Draw a rough straight line and hold still ~0.5 s at the end | Snaps to a straight line (Android: short vibration) |
| 4.2 | After the snap, keep the pen down and move it | Line end follows the pen; lifting commits |
| 4.3 | Nearly horizontal line + hold | Becomes exactly horizontal (same price at both ends) |
| 4.4 | Curved stroke + hold | Stays freehand |
| 4.5 | Two-finger tap / three-finger tap | Undo / redo (chart does not zoom) |
| 4.6 | S Pen: hold the side button while drawing | Erases **if** the browser reports the button; record the result (unverified — Chromium may map it to the primary button) |
| 4.7 | Write a short word (letters ≤ ~60 px), then pinch-zoom horizontally | Handwriting keeps its proportions (uniform scale); a big circled region stretches with the candles |

## 5. Chart anchoring on device

| # | Action | Expected |
|---|---|---|
| 5.1 | Draw a line from one candle's low to another's high; pan, pinch, rotate device | Endpoints stay on the same candles/prices |
| 5.2 | Scroll far left until older history loads | Drawings stay attached |
| 5.3 | Switch timeframe and back | Each timeframe keeps its own drawings |

## 6. Screenshot, persistence, sync

| # | Action | Expected |
|---|---|---|
| 6.1 | Camera → Copy, paste into Notes/Samsung Notes | Chart PNG with drawings, without crosshair |
| 6.2 | Camera → Share | Share sheet with the PNG (iPad: Save Image / Copy / Files) |
| 6.3 | Camera → Download (Android / desktop) | PNG saved |
| 6.4 | Draw, close the app completely, reopen | Drawings restored |
| 6.5 | Airplane mode, draw, disable airplane mode | The sync button shows a pending count while offline; it goes to 0 and the drawing appears on the other devices |
| 6.6 | Two devices open the app, draw on one | Appears on the other within a second or two, with a live preview while drawing. No sign-in anywhere |
| 6.7 | Installed PWA: new version deployed (`docker compose up -d --build`) | "A new version is available" prompt; never auto-reloads mid-stroke |
| 6.8 | Leave the app open on the iPad for 10+ minutes idle, then draw on another device | Still arrives live (the connection survives Cloudflare's idle timeout) |
| 6.9 | With Cloudflare Access: let the Access session expire (or revoke it), then draw — in the browser and in the installed app | The sync panel offers **Sign in again**; it leads through the Access login back into the app, syncing resumes, and nothing drawn meanwhile is lost |
| 6.10 | Installed PWA behind Cloudflare Access | Installation works (manifest loads); the home-screen icon is the full dark tile, with no white frame (Android masks it to its launcher shape); the installed app starts offline |
| 6.11 | `docker compose restart` while two devices are open | Both reconnect by themselves within ~30 s; drawings made meanwhile arrive |
| 6.12 | Restore a backup (README) while devices hold newer drawings, then open the app on them | The backup's drawings are back; drawings created after the backup reappear once each device that has them reconnects |

## 6b. Wyckoff label stamps

| # | Action | Expected |
|---|---|---|
| 6b.1 | Tap the tag in the tool rail with the pen; tap **SC** in the strip | The strip appears over the top of the chart; SC is highlighted in the pen colour. On a short screen the candles move down a little, so a label fits above the highest candle below the strip |
| 6b.2 | Pen-tap just under a candle's low | "SC" appears under that candle's low with a small tick pointing at it; tapping again places another SC (the label stays armed) |
| 6b.3 | Pen-tap just over a candle's high with **AR** armed | "AR" appears above the high |
| 6b.4 | Press the pen on one candle and slide sideways before lifting | The label follows from candle to candle; it is placed only where the pen lifts |
| 6b.4a | Press on a candle, slide onto the price axis and lift there | Nothing is placed (the preview disappears once the pen leaves the chart) |
| 6b.4b | Select a label (select tool, tap it) and drag it under another candle | It lands under that candle's low, with the tick pointing at it |
| 6b.5 | Pencil hover (M2+ iPad Pro / Pencil Pro) or S Pen Air View with the label tool on | A faint preview shows where the label would land |
| 6b.6 | Phase **C**: tap anywhere in a candle's column | A boxed "Phase C" at that candle's time, at the pen's height |
| 6b.7 | Tap chips with the pen while the palm rests on the chart | The chart does not pan (record any movement) |
| 6b.8 | Galaxy phone (portrait): swipe the strip sideways with a finger | It scrolls to the distribution labels, the B waves and the phases |
| 6b.9 | Pinch/pan after placing labels; draw on the other device | Labels keep their size and stay on their candles; they sync to the other device |

## 7. Orientation and layout

| # | Action | Expected |
|---|---|---|
| 7.1 | Landscape ↔ portrait | Tool rail moves left ↔ bottom; chart resizes; drawings stay anchored |
| 7.2 | Installed PWA on iPad with notch/rounded corners | Nothing hidden under system UI (safe areas) |
| 7.3 | iPad Slide Over / narrow Split View | Top bar and tool rail scroll horizontally; palette, screenshot and sync panels stay fully on screen |

## Results log

| Date | Device / OS / browser | Section | Result | Notes |
|---|---|---|---|---|
| 2026-09-25 | iPad Pro (Apple Pencil), Galaxy S26 Ultra (S Pen) | all | ✅ "works just great" (user) | Itemized results not recorded |
| 2026-09-26 | Galaxy S26 Ultra, Chrome, installed app | 6.9 | ❌ then ✅ | After the Access session expired, **Sign in again** only reloaded the app and it kept asking. Deleting the site's cookies in Chrome, then signing in, fixed it. The request log (`REQUEST_LOG=1`) then showed every request passing, with an Access token valid **24 h**. Suspected cause: a stale Access cookie that the new login did not replace; unconfirmed. |
