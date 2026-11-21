# Target Auto-Buy v5 — Setup Guide (for non-technical users)

**Version:** 5.4.0 — 2026-11-21
**Guide updated:** 2026-11-21 — rewritten step by step for non-technical
users (Windows + Mac).
**Status:** Built and harness-tested (see TESTS.md). A live purchase is NOT
yet proven — that needs a real restock. No purchase is promised.

## What this does (in plain words)

Restockd posts a message in Discord when a product is back in stock.
This system sees that message within seconds and tries to buy that exact
product on Target — before the stock runs out again.

While the product is out of stock, this system makes **zero** requests to
Target. It just waits. That is the whole point: the old bot checked Target
every 1–2 seconds all day, and on Nov 13 it still missed a restock that
lasted 2 minutes or less.

It has three pieces:

1. **A small server program** on your own computer. It remembers which
   products to buy and passes messages between the other two pieces.
2. **A Discord script** that reads Restockd's messages in your own
   Discord tab and sends them to the server.
3. **A Target script** that waits on any Target page. When an alert
   comes, it opens the product page itself and tries to buy that one
   product — quantity 1, never anything else.

The old v4.4 script is **not changed** by this. It stays as a backup.

## Before you start — what you need

- A computer: Windows 10 or 11, or a Mac.
- Google Chrome (the browser — not Safari, not Edge).
- A Discord account that can see the Restockd server and the
  **#pokemon-target** channel.
- A Target account, logged in, with a payment method saved.
  (If you have several Target accounts, use one Chrome profile per
  account — click your profile picture at the top-right of Chrome,
  then **Add**.)
- Internet. Nothing to buy, nothing to sign up for.

## Part 1 — Get the files (5 minutes)

1. In Chrome, open this page:
   **https://github.com/pythonicshariful/Target-Discord-Alert-Server-**
2. Click the green **Code** button, then **Download ZIP**.
3. Find the ZIP file in your Downloads folder and open it to unpack it:
   - **Windows:** right-click the ZIP → **Extract All** → **Extract**.
     A folder appears.
   - **Mac:** double-click the ZIP. A folder appears.
4. Move that folder somewhere easy to find, for example your Desktop.
   You can rename it to **TargetBot-v5** if you like. From now on,
   "the folder" means this folder.

## Part 2 — Install Python (one time only)

Python is a free program the server runs on. If you already have it,
skip to Part 3.

**Windows:**

1. Go to **https://www.python.org/downloads/** and click the big yellow
   **Download Python** button.
2. Run the downloaded installer. **Important:** on the first screen,
   tick the small box at the bottom that says
   **"Add python.exe to PATH"** — then click **Install Now**.
   If you miss this box, the server will later say "Python was not
   found". Just run the installer again and tick the box.
3. Wait for it to finish, then click **Close**.

**Mac:**

1. Go to **https://www.python.org/downloads/** and click the big yellow
   **Download Python** button.
2. Open the downloaded `.pkg` file, click **Continue** and **Install**,
   and type your Mac password if it asks.
3. That's it — this installer also adds `pip`, which the server needs.

**Check it worked (optional, 10 seconds):**

- **Windows:** press `Win + R`, type `cmd`, press Enter. In the black
  window type `python --version` and press Enter. You should see
  `Python 3.11` or newer.
- **Mac:** open **Terminal** (press `Cmd + Space`, type `Terminal`,
  press Enter). Type `python3 --version` and press Enter. You should
  see `Python 3.11` or newer.

## Part 3 — Start the server (every time you want the bot running)

The server is a small program on your own computer. It must be running
while the bot works. It only talks to your own computer — nothing on the
internet can reach it.

**Windows:**

1. Open the folder → open the **server** folder inside it.
2. Double-click **start-server.bat**. A black window opens.
   The first time, it installs two small pieces (about a minute).
   Wait until you see `Starting server`.
3. Your browser opens the **dashboard** at
   **http://127.0.0.1:5000/** — you should see **Running** and the two
   products listed below. (You can bookmark this address.)
4. **Keep the black window open.** Closing it stops the bot.
   To stop the bot, press `Ctrl + C` in the black window, or just
   close the window.

**Mac:**

1. Open the folder → open the **server** folder inside it.
2. Double-click **start-server.command**. A Terminal window opens.
   The first time, it installs two small pieces (about a minute).
   Wait until you see `Starting server`.
   - If macOS says the file "cannot be opened because it is from an
     unidentified developer": **right-click** the file → **Open** →
     **Open**. After that first time, double-clicking works normally.
   - If double-clicking still does nothing: open **Terminal** and type
     these two lines (change `Desktop` if your folder is elsewhere):
     `cd ~/Desktop/TargetBot-v5/server` then `python3 server.py`
3. Your browser opens the **dashboard** at
   **http://127.0.0.1:5000/** — you should see **Running** and the two
   products.
4. **Keep the Terminal window open.** Closing it stops the bot.

If the dashboard does not open by itself, type
**http://127.0.0.1:5000/** into Chrome yourself.

> **No config file, no token, nothing to copy.** The server remembers
> everything itself (products, settings) in one file,
> `server/alerts.db`, created automatically on first start. You never
> edit a file. If you have old `config.json` / `config.example.json`
> files from an earlier version, delete them — the server does not use
> them.

## Part 4 — Choose what to buy (in the dashboard)

Open the dashboard at **http://127.0.0.1:5000/**. Everything about
**which products the bot buys** is done here — no file editing.

- **What to buy** — pick one of the two choices, then click
  **Save choice**:
  - **Selected products only** — buy only the products in the list
    below, one item each, never above their max price.
    (This is the default.)
  - **Any product, any price** — buy whatever product gets alerted, at
    whatever price it is. The list below is ignored. Use carefully:
    one alert = one purchase attempt, at any price.
- **The two products already in the list:**

  | Product | TCIN | Max price |
  |---|---|---|
  | Pokémon TCG 30th Celebration Booster Bundle Box | 1011407490 | $31.99 |
  | Pokémon TCG 30th Celebration Knock Out Collection | 1010892070 | $11.99 |

  The $79.99 Unova product in the sample screenshots is a **sample
  only** and is deliberately NOT in this list.
- **Add a product:** type its name, its TCIN (numbers only), and the
  max price you will pay, then click **Add product**.
  (Only used in Selected-products mode.)
  How to find a product's TCIN: open the product on target.com. The
  address bar shows something like
  `.../p/.../A-1011407490` — the number after `/A-` is the TCIN.
- **Remove a product:** click **Remove** next to it. The bot stops
  buying it immediately.
- **Settings:** how long a repeat alert is ignored (15 minutes), and
  how long a waiting alert is kept (10 minutes). Leave these as they
  are unless Shariful tells you otherwise.
- **Recent alerts:** every alert and what happened to it — `queued`
  (waiting), `ignored` (skipped, with a reason), `claimed` (a profile
  took it), `done` (bought), `failed` (tried, did not buy, with a
  reason).

## Part 5 — Install Tampermonkey and the two scripts (one time, per Chrome profile)

Tampermonkey is a free Chrome add-on that runs the two small scripts.
It does not need an account.

1. In Chrome, open the **Chrome Web Store**, search for
   **"Tampermonkey"**, click **Add to Chrome** → **Add extension**.
   Do this in every Chrome profile that will run the bot.
2. Install the **Discord Receiver** script:
   - In Chrome, press `Ctrl + O` (Windows) or `Cmd + O` (Mac).
   - Pick this file: `TargetBot-v5/tampermonkey/Target Discord Receiver.user.js`
   - Tampermonkey opens a page — click **Install**.
3. Install the **Auto-Buy** script the same way:
   - Press `Ctrl + O` / `Cmd + O`, pick
     `TargetBot-v5/tampermonkey/Target Auto Buyer v5 (Discord Alert).user.js`
   - Click **Install**.
4. Check it worked: click the Tampermonkey icon at the top-right of
   Chrome (it looks like a small square; if you don't see it, click the
   puzzle-piece icon first). Click **Dashboard**. You should see both
   scripts with their switches **ON**.
5. Which profile gets what:
   - **Receiver:** install it once, in the profile where you keep
     Discord open.
   - **Auto-Buy:** install it in **every** profile that has a Target
     account.
6. **Important:** if the old **v4.4** script is on a profile where v5
   runs, turn v4.4 **OFF** in the same Tampermonkey dashboard (click
   its switch). v4.4 and v5 must never run together on the same page —
   they would fight over the same button. Keep v4.4 on only on profiles
   where you are NOT running v5.

## Part 6 — The Discord tab

1. In Chrome (the profile where you installed the Receiver), open
   **discord.com** and log in.
2. Open the Restockd server, then the **#pokemon-target** channel.
   **Keep this tab open.** The Receiver only sees what this tab shows.
3. You should see a small panel at the top-right of the Discord page:
   **"V5 Discord Receiver"**, **Server: 🟢 connected**, **Sent: 0**.
   - **No panel at all:** the Receiver is not running on this tab.
     Check Part 5 step 4 — is the switch ON? Are you in the right
     Chrome profile?
   - **🔴 OFFLINE:** the server is not running. Go back to Part 3 and
     start it.
   - The **desktop Discord app does not work** for this — it must be a
     Chrome tab.
4. Leave this tab open. Do not close it.

## Part 7 — The Target tab and the dark panel

1. In Chrome, open **any target.com page** — even the homepage
   (**https://www.target.com/**). Log in to your Target account.
   Make sure a payment method is saved (the bot uses your saved
   payment — it never asks for card numbers).
2. A dark panel appears at the bottom-right: **"Target Auto-Buy v5"**.
   - **Product:** shows the product name if you are on a product page,
     or "not a product page" on the homepage. Both are fine — any page
     works now.
   - **Server:** 🟢 connected. (If it says 🔴 OFFLINE, start the
     server — Part 3.)
   - **CVV:** type the 3-digit security code (CVV) of your saved card.
     It is saved only in this browser profile, and it is only ever
     typed into Target's own checkout page. It is never sent to the
     server or anywhere else.
   - **Auto place order:** **ON** means the bot finishes the order by
     itself. **OFF** means it stops at the review page and you click
     "Place order" yourself. Decide with Shariful which one to use the
     first time.
   - **Test server:** press it — it should say the server is OK.
   - **Simulate alert (test):** a test button — see Part 8.
3. Leave a Target tab open in each profile. Any page is fine — when an
   alert comes, the tab opens the product's page by itself and starts
   buying.

## Part 8 — Test it now (no real restock needed)

Do this once after setup, so you know it works before a real restock.

### A. Quick test — the buyer half (2 minutes)

1. Open a **product page** on target.com — for example the Booster
   Bundle Box:
   **https://www.target.com/p/A-1011407490**
   (The test button needs a product page, not the homepage.)
2. In the dark panel, click **Simulate alert (test)**.
3. The panel should wake up, check the product (it is out of stock),
   buy nothing, and go back to waiting.
4. In the dashboard (**http://127.0.0.1:5000/**), under **Recent
   alerts**, you should see the test alert as **failed
   (gone_before_buy)**. That is the **correct** result for an
   out-of-stock product — it proves the wiring works.

### B. Full test — the Discord half (5 minutes)

1. Make your own test Discord server (free, nobody else needs to
   join): in Discord, click the **+** on the left → **Create My Own**
   → **For me and my friends** → give it any name → **Create**.
   Then create a channel called **#test-alerts**.
2. In the Discord tab, switch to your test server's **#test-alerts**
   channel. (Switch it back to **#pokemon-target** when you finish.)
3. Type this message into **#test-alerts** (copy it exactly):

   ```
   Restockd
   Pokémon TCG 30th Celebration Booster Bundle Box | Target
   https://www.target.com/p/A-1011407490
   Price $31.99
   Qty Pre-Order
   Retailer Target
   ```

4. Within a few seconds, the Receiver panel's **Sent** number goes up
   by 1, and the dashboard's **Recent alerts** shows the alert as
   **queued**, then **failed (gone_before_buy)** — correct, the product
   is out of stock.
   - If **Sent stays 0**, the Receiver did not see the message. Check
     Part 6: is the panel visible? Are you on the right channel?
     Is the Discord tab in Chrome (not the desktop app)?

### C. Exact-format test (optional, with a webhook)

This sends a message that looks exactly like a real Restockd alert.
You only need to do this once.

1. In your test server, open the **#test-alerts** channel settings
   (the gear icon next to the channel name) → **Integrations** →
   **Webhooks** → **New Webhook**. Name it **Restockd**. Click
   **Copy Webhook URL**. Keep this URL private — anyone with it can
   post into your channel.
2. Send the sample alert with this command (replace
   `YOUR_WEBHOOK_URL` with the URL you copied, and `TargetBot-v5`
   with your folder name if it is different):
   - **Windows** — open **PowerShell** in the folder: open the folder,
     click the address bar, type `powershell`, press Enter. Then paste:
     `curl.exe -X POST -H "Content-Type: application/json" --data-binary "@tests/sample-alert-webhook.json" "YOUR_WEBHOOK_URL"`
   - **Mac** — open **Terminal** and paste these two lines:
     `cd ~/Desktop/TargetBot-v5`
     `curl -X POST -H "Content-Type: application/json" --data-binary "@tests/sample-alert-webhook.json" "YOUR_WEBHOOK_URL"`
3. The message appears in **#test-alerts**, and the chain runs exactly
   as in test B.

**What these tests prove:** the Discord → server → buyer chain works.
**What they do NOT prove:** how fast a real Restockd alert arrives, or
the exact real message format. One real alert is still needed later to
confirm that.

## Part 9 — Before a real restock (checklist, every time)

1. **Server running** — the black window (Windows) or Terminal window
   (Mac) is open, and the dashboard shows **Running**.
2. **Discord tab open** on **#pokemon-target**, Receiver panel
   🟢 connected.
3. **Target tab open** (any page), dark panel visible, Server
   🟢 connected, CVV filled in.
4. **Computer stays ON and awake overnight.** If it sleeps, or Chrome
   closes, the bot stops silently.
   - **Windows:** Settings → System → Power → Screen and sleep → set
     **Sleep to Never** while plugged in.
   - **Mac:** System Settings → Lock Screen → set **"Turn display off
     when inactive" to Never**, and turn on **"Prevent automatic
     sleeping on power adapter when the display is off"** if you see it.
5. One static residential US IP per profile is still recommended if
   you run several accounts. The Discord design removes Target
   *polling* traffic, but checkout still comes from your IPs.

## Part 10 — What happens during a restock

1. Restockd posts in **#pokemon-target**.
2. The Receiver forwards it — its **Sent** number goes up by 1.
3. The server checks: is it a watched product? Is the price OK? Is it
   a repeat of an alert from the last 15 minutes? If yes to the first
   two and no to the third, it is **queued**.
4. The first Target tab to see it **claims** it. If several profiles
   have a Target tab open, the others stand down — only one profile
   buys.
5. The tab opens the product's page by itself, checks for a challenge
   first, checks the stock once, checks the price, clicks the exact
   product's **Add to cart** button (never "Find alternative" or a
   similar product), checks the cart has only that product, and goes
   to checkout.
6. If **Auto place order** is ON, it clicks **Place order** once. If
   OFF, it stops at the review page and beeps — you click
   **Place order** yourself.
7. Done: the panel says **DONE**, and the dashboard shows **done**.

**If Target shows a Press & Hold / verification screen:** the bot
**PAUSES**, beeps, and shows a red banner. **Solve it with your mouse,
by hand.** The bot waits and continues by itself after you solve it.
It never solves this for you.

**One alert = one try.** A second alert for the same product within
15 minutes is ignored. If the stock is already gone when the bot
checks, it buys nothing and tells you why in the panel and in the
dashboard.

## Part 11 — If something goes wrong

| What you see | What to do |
|---|---|
| No dark panel on target.com | The Auto-Buy script is not installed or not ON in this Chrome profile. Go to Part 5 step 4 and check. |
| No Receiver panel on Discord | The Receiver script is not installed or not ON, or you are in the wrong Chrome profile. Go to Part 5 step 4, then Part 6. |
| 🔴 OFFLINE on either panel | The server is not running. Go to Part 3 and start it. |
| Message in Discord but nothing happens | Check in this order: (1) Is the server running? (2) Receiver panel — did **Sent** go up? If it stayed 0, the Receiver never saw the message (wrong channel? desktop app?). (3) Dashboard → **Recent alerts** — is the alert there? If it says `ignored: not_watched`, the product is not in your list — add it (Part 4), or switch **What to buy** to **Any product, any price**. If it says `ignored: duplicate`, an earlier identical alert is still waiting. |
| `failed: gone_before_buy` | The stock was already gone by the time the bot checked (seconds matter), or Restockd's alert arrived late. |
| `failed: stock_check_blocked` | Target blocked the stock check. Wait for the next alert. |
| Bot paused on Press & Hold | Solve it by hand with your mouse. It continues by itself. |
| Still stuck | Send Shariful these three things: (1) a screenshot of the dark panel, (2) a screenshot of **http://127.0.0.1:5000/alerts**, (3) the file `server/server.log`. If a Press & Hold screen appeared, also send a full screenshot of it, including any Reference ID. |

## After a restock — what to send Shariful

1. What the dark panel said (mode + last action), and a screenshot of it.
2. **http://127.0.0.1:5000/alerts** — open it in Chrome and send a
   screenshot. It shows every alert and what happened to it.
3. The file **`server/server.log`** from the folder.
4. If a Press & Hold screen appeared: a full screenshot of it, including
   any Reference ID.
5. If an order went through: a screenshot of the order confirmation.

## Safety notes (read these)

- v5 places an order by itself when everything checks out — that is
  what an auto-buy bot is for. It only ever buys the alerted product,
  quantity 1, at or under its max price (in Selected-products mode;
  in Any-product mode, at any price), and only after checking the cart.
  If you are not comfortable with that, turn OFF "Auto place order"
  and click it yourself.
- Never buy a CAPTCHA solver for this: NopeCHA / 2Captcha do not solve
  Target's PerimeterX Press & Hold.
- No token, no password anywhere. The server only listens on your own
  computer (`127.0.0.1`), it cannot be reached from the internet, and
  only Discord and Target pages can call it from a browser — a random
  website cannot trigger a purchase.
- If Discord changes its page layout, the Receiver may stop reading
  alerts (its panel will keep showing the old numbers). Tell Shariful —
  the message reader is the part that needs maintenance.
- No 100% success: a 2-minute stock window, a manual challenge solve,
  or Target's own limits can still beat the bot. This system is faster
  and safer than the old one; it does not promise a purchase.

## Updating to a new version

1. Download the new ZIP (Part 1) and unpack it.
2. **Keep your products and settings:** your products and settings live
   in one file, **`server/alerts.db`** in your OLD folder. Copy that
   file into the NEW folder's `server` folder before you start the
   server — otherwise you start with the two default products again.
3. Replace the old folder with the new one (same place, same name).
4. In Tampermonkey, open the two new `.user.js` files again
   (`Ctrl + O` / `Cmd + O`) and click **Update** / **Reinstall**.
5. Start the server again (Part 3) and check the dashboard shows your
   products.

## Files (what is inside the folder)

```
Target-Discord-Alert-Server-/
├── server/
│   ├── server.py            Piece 1 — the server (127.0.0.1:5000)
│   ├── requirements.txt     The two pieces the server needs (fastapi + uvicorn)
│   ├── start-server.bat     Double-click starter (Windows)
│   ├── start-server.command Double-click starter (Mac)
│   ├── .venv/               Created on first run on Mac (isolated
│   │                        Python pieces, gitignored)
│   ├── alerts.db            Created on first run (SQLite: alerts +
│   │                        watchlist + buy mode + settings, gitignored)
│   └── server.log           Created on first run (rotating log, gitignored)
├── tampermonkey/
│   ├── Target Discord Receiver.user.js                  Piece 2 (Discord)
│   └── Target Auto Buyer v5 (Discord Alert).user.js     Piece 3 (Target)
├── tests/
│   ├── run_server_tests.py      T1–T4 + T11/T12/T14/T15 (needs server up)
│   ├── run_browser_tests.js     T6/T7/T9 jsdom harness (needs node + jsdom)
│   └── sample-alert-webhook.json  Restockd-style test alert for your own server
├── README.md                This file
└── TESTS.md                 What was actually tested, with results
```

There is no config file in this repo on purpose — the server creates
its own database (`server/alerts.db`) on first start and keeps the
watchlist, buy mode and settings there.
