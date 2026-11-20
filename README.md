# Target-Discord-Alert-Server-

Target Auto-Buy v5 — a Discord-alert-driven auto-purchase system for
Target.com, built for Fiverr order FO31C2E00C185 ($300, williamesco).

**Version:** 5.0.0 — 2026-11-20
**Status:** Built and harness-tested (see TESTS.md). A live purchase is NOT
yet proven — that needs a real restock. No purchase is promised.

## What this is

The old bot (v4.4) checked Target's stock API every 1–2 seconds, all day.
On Nov 13 it missed a restock that lasted 2 minutes or less. v5 works the
other way round:

> **While out of stock, v5 makes ZERO requests to Target. When Restockd
> posts a restock alert in Discord, v5 wakes up within seconds and tries
> to buy only that exact product.**

Three new pieces. The v4.4 script is **not edited, not imported, not
touched** — it stays as the fallback.

| Piece | File | Runs where |
|---|---|---|
| 1. Python server API | `server/server.py` | Buyer's Windows PC, `http://127.0.0.1:5000` |
| 2. Discord Receiver | `tampermonkey/Target Discord Receiver.user.js` | discord.com, in the buyer's own Discord tab |
| 3. Auto-Buy v5 | `tampermonkey/Target Auto Buyer v5 (Discord Alert).user.js` | target.com, one Chrome profile per Target account |

## Watched products (the ONLY two — do not add others without confirming)

| Product | TCIN | Max price |
|---|---|---|
| Pokémon TCG 30th Celebration Booster Bundle Box | 1011407490 | $31.99 |
| Pokémon TCG 30th Celebration Knock Out Collection | 1010892070 | $11.99 |

The $79.99 Unova product in the sample screenshots is a **sample only**
and is deliberately NOT watched.

## Install (buyer's Windows PC)

### Step 1 — Python + server (once)

1. Install Python 3.11 or newer from python.org. During install, tick
   **"Add python.exe to PATH"**.
2. Copy this whole folder somewhere, e.g. `C:\TargetBot-v5\`.
3. **Set your own secret token (once, before the first run):** copy
   `server\config.example.json` to `server\config.json`, open it, and
   replace the `secret_token` value with a long random string of your
   own (e.g. 32 random letters/digits). Then set the **same** string in
   both Tampermonkey scripts: Tampermonkey dashboard > script >
   Settings > `v5_token`. The three places must match, or the server
   rejects the scripts (401). Never post `config.json` anywhere — it
   is your private token, and it is gitignored in this repo for that
   reason. The scripts ship with a `CHANGE-ME-...` placeholder on
   purpose; the server refuses to start with it.
4. Double-click `server\start-server.bat`. The first run installs the
   dependencies (FastAPI + uvicorn). A black window opens — **keep it
   open** while the bot runs. It should say the server is starting on
   `http://127.0.0.1:5000`.
5. Check it works: open `http://127.0.0.1:5000/health` in Chrome — you
   should see `{"ok":true}`. Open `http://127.0.0.1:5000/status` — you
   should see the two watched products.

### Step 2 — Tampermonkey scripts (once, per Chrome profile)

1. Install the Tampermonkey extension in Chrome (if not already installed).
2. Open `tampermonkey/Target Discord Receiver.user.js` — Tampermonkey
   offers to install it. Install.
3. Open `tampermonkey/Target Auto Buyer v5 (Discord Alert).user.js` —
   install the same way.
4. **On the profile where v5 will run, DISABLE the old v4.4 script**
   (Tampermonkey dashboard > toggle it off). v4.4 and v5 must never run
   on the same product page — they would fight over the same button.
   Keep v4.4 enabled only on profiles where you are NOT running v5.

### Step 3 — Settings in the v5 panel (on target.com)

Open a watched product page. A dark panel appears bottom-right:

- **CVV:** type the CVV of your saved payment method. It is stored only
  in that browser profile (Tampermonkey storage) and is only ever typed
  into Target's own checkout page. It is never sent to the server or
  anywhere else.
- **Auto place order:** ON by default. The bot will click "Place order"
  once, after checking the cart holds only the expected product. Uncheck
  it if you want the bot to stop at the review step and let you click
  "Place order" yourself.
- **Test server:** checks the local server is reachable.
- **Simulate alert (test):** posts a TEST alert for this product to the
  server so you can watch the whole flow on an out-of-stock page. It
  buys nothing — the product is out of stock, so the run ends in
  "failed: gone_before_buy / stock_check_blocked" and returns to waiting.
  Use this once after install to prove the wiring.

### Step 4 — Before a restock (every time)

1. Start the server (Step 1) and leave the black window open.
2. Chrome open, logged in, with TWO tabs:
   - Discord, **#pokemon-target channel open** (Restockd alerts must be
     visible there — the Receiver only reads what this tab shows).
   - Target product page for each profile, logged in, payment saved.
3. PC must stay **on and awake overnight** — if it sleeps, or Chrome
   closes, the chain breaks silently. The panels are your only warning:
   Receiver panel top-right of Discord (🟢/🔴), v5 panel bottom-right
   of Target (mode + server status).
4. One static residential US IP per profile is still recommended for
   multi-account running. The Discord design removes Target *polling*
   traffic, but checkout still comes from your IPs.

## How it behaves

- **IDLE (waiting):** the Target panel says "⏳ Waiting for a Discord
  alert". The script polls only the local server (~every 0.75 s). No
  Target requests at all.
- **Alert arrives:** Restockd posts in #pokemon-target → Receiver
  forwards it → server queues it (only if the TCIN is watched, the
  price is at or under the cap, and it is not a duplicate) → the v5
  script claims it and runs: challenge check → one stock check → price
  check → exact-product Add to cart → cart check → checkout.
- **Press & Hold / Quick verification:** the bot **PAUSES**, beeps, and
  shows a red banner. **Solve it by hand** — it is never auto-solved.
  The bot re-checks every 1.5 s and resumes on its own after you solve
  it. This check runs before the stock check, before the click, and in
  the checkout loop (the check v4.4's polling was missing).
- **One alert = one attempt.** A second alert for the same product
  within 15 minutes is ignored as a duplicate (unless the first attempt
  already failed). A second Chrome profile cannot claim an alert another
  profile already claimed.
- **Wrong product / over price / alternative button:** the bot refuses
  to click and buys nothing. The panel and the server log say why.

## Testing it without a real restock (sample Discord server)

You do not need to wait for a real restock to prove the chain works:

1. Create your own Discord server (free) and a `#test-alerts` channel.
   No one else needs to join; do not invite the Restockd bot.
2. In that channel: Settings → Integrations → Webhooks → New Webhook,
   name it `Restockd`, copy the webhook URL (keep it private).
3. POST `tests/sample-alert-webhook.json` to that webhook URL (a
   Restockd-style embed for the watched TCIN 1011407490 at $31.99).
   The Receiver only requires the message text to contain "Restockd",
   an "Open product" / `/p/` Target link, and a Price line — it does
   not check the channel name, so your test channel works.
4. Keep the Auto-Buy tab on an **OUT-OF-STOCK** page with **"Auto place
   order" OFF**. The script should wake, verify OOS, buy nothing, and
   return to IDLE. Check `http://127.0.0.1:5000/alerts` — the alert
   should show as queued, then failed (gone/stock_check_blocked).
5. This proves the Discord → server → buyer chain. It does NOT prove
   Restockd's real alert delay or real embed quirks — one real alert is
   still needed later to confirm the real format parses.

## After a restock — what to send Shariful

1. What the v5 panel said (mode + last action), and a screenshot of it.
2. `http://127.0.0.1:5000/alerts` — open it in Chrome, copy the list
   (or screenshot it). It shows every alert and what happened to it.
3. `server\server.log` — the server's log file.
4. If a Press & Hold screen appeared: a full screenshot of it, including
   any Reference ID.
5. If an order went through: the order confirmation screenshot.

## Safety notes (read these)

- v5 will place an order by itself when everything checks out — that is
  what an auto-buy bot is for. It only ever buys the alerted TCIN,
  quantity 1, at or under its max price, and only after the cart check.
  If you are not comfortable with that, uncheck "Auto place order" and
  click it yourself.
- Never buy a CAPTCHA solver for this: NopeCHA / 2Captcha do not solve
  Target's PerimeterX Press & Hold.
- The server binds to `127.0.0.1` only and is not reachable from the
  internet. The token in `server/config.json` is shared with the two
  Tampermonkey scripts (Tampermonkey dashboard > script settings >
  `v5_token` / `v5_server_url`). If you change it, change it in all
  three places. Do not post `config.json` anywhere.
- If Discord changes its page layout, the Receiver may stop parsing
  alerts (its panel will keep showing the old counts). Tell Shariful —
  the parser is the part that needs maintenance.
- No 100% success: a 2-minute window, a manual challenge solve, or
  Target's own limits can still beat the bot. This system improves
  speed and lowers flagging risk; it does not promise a purchase.

## Files

```
Target-Discord-Alert-Server-/
├── server/
│   ├── server.py            Piece 1 — FastAPI server (127.0.0.1:5000)
│   ├── config.example.json  Copy to config.json, set your own token
│   ├── requirements.txt     fastapi + uvicorn
│   ├── start-server.bat     Double-click starter (Windows)
│   ├── alerts.db            Created on first run (SQLite alert log, gitignored)
│   └── server.log           Created on first run (rotating log, gitignored)
├── tampermonkey/
│   ├── Target Discord Receiver.user.js                  Piece 2
│   └── Target Auto Buyer v5 (Discord Alert).user.js     Piece 3
├── tests/
│   ├── run_server_tests.py      T1–T4 + auth/ack checks (needs server up)
│   ├── run_browser_tests.js     T6/T7/T9 jsdom harness (needs node + jsdom)
│   └── sample-alert-webhook.json  Restockd-style test alert for your own server
├── README.md                This file
└── TESTS.md                 What was actually tested, with results
```

`server/config.json` is intentionally NOT in this repo — it holds your
private token. Copy `config.example.json` to `config.json` and set a
token of your own (see Step 1).

## If something goes wrong

| Symptom | Check |
|---|---|
| Receiver panel 🔴 OFFLINE | Is the black server window open? Is `http://127.0.0.1:5000/health` reachable? |
| v5 panel 🔴 OFFLINE | Same — server down. The bot waits and makes no Target requests. |
| Alert in Discord but nothing happens | Open `http://127.0.0.1:5000/alerts` — is it there? If `ignored: not_watched`, the TCIN is not in the watchlist. If `ignored: duplicate`, an earlier identical alert is still pending/claimed. |
| "failed: gone_before_buy" | Stock was already gone by the time the bot verified (seconds matter) — or Restockd's alert arrived late. Check the alert's Discord time vs the server's received time in `/alerts`. |
| "failed: stock_check_blocked" | Target blocked the stock check (PerimeterX). The DOM button was also not usable. Wait for the next alert. |
| Bot paused on Press & Hold | Solve it by hand. It resumes automatically. |
