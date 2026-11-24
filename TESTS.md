# TESTS.md — Auto-Buy v5 test record

**Date:** 2026-11-20 (re-verified after the 2026-11-20 token sanitization
for the public repo push: server tests 12/12, T6 9/9, T7 5/5 — all PASS;
re-verified again after the 2026-11-20 dashboard UI was added: server
tests incl. new T11 UI checks 23/23, T6 9/9, T7 5/5 — all PASS;
re-verified again after the 2026-11-21 no-config-file change (v5.2.0):
server tests incl. new T12 no-config checks 26/26, T6 9/9, T7 5/5 —
all PASS;
re-verified again after the 2026-11-21 token removal + buy modes
(v5.3.0): server tests incl. new T14 mode checks 39/39, T6 9/9,
T7 5/5, T9 5/5 (T9 with the server stopped, as designed) — all PASS;
re-verified again after the 2026-11-21 any-page + auto-navigate change
(v5.4.0): server tests incl. new T15 /next-any checks 47/47, T6 9/9,
T7 5/5 (rewritten for the navigate behavior), T9 5/5 — all PASS;
re-verified again after the 2026-11-24 real-message fix (v5.4.2):
server tests incl. new T17 howl-redirect checks 56/56, T16 real-channel
HTML 7/7, T6 9/9, T7 5/5 — all PASS;
re-verified again after the 2026-11-24 dashboard fix (v5.4.3):
server tests 60/60 (default mode is now "any"), T16 7/7, T18 dashboard
mode flow 9/9, T6 9/9, T7 5/5 — all PASS)
**Rule followed:** no test is marked passed unless it was actually run.
Tests that need the live Discord channel, a real challenge, or an
overnight soak are marked NOT RUN, not passed.
**Token note:** the test harnesses fetch the secret token from the
dashboard at runtime (GET `/` for the per-start UI token, then
`/api/config`) — no real token is stored in any test file or in this
repo, and there is no config file (v5.2.0).

## How to re-run

```bash
# Server tests (needs Python + fastapi; server must be running on a FRESH db)
cd target-discord-alert-v5/server && rm -f alerts.db server.log
python server.py            # in one terminal
python tests/run_server_tests.py

# Browser tests (needs node + jsdom: npm install jsdom)
NODE_PATH=<path-to-jsdom>/node_modules node tests/run_browser_tests.js t6
NODE_PATH=<path-to-jsdom>/node_modules node tests/run_browser_tests.js t7
# T9 needs the server STOPPED:
NODE_PATH=<path-to-jsdom>/node_modules node tests/run_browser_tests.js t9

# T16 — Receiver against the real Restockd channel HTML (needs the pasted
# file at ~/workspace/user/files/pasted-text.txt, no server needed):
NODE_PATH=<path-to-jsdom>/node_modules node tests/check-real-discord-html.js

# T18 — Dashboard mode flow (needs the server UP on a fresh DB):
NODE_PATH=<path-to-jsdom>/node_modules node tests/check-dashboard-mode.js
```

## Results (2026-11-20, final code)

### Server tests — `tests/run_server_tests.py` — ALL PASSED (12/12)

Run against a fresh database. The T1 alert used the Nov 13 Restockd
format (title / price / qty / retailer / "Open product" URL) with a
watched product at its real price.

| Test | What was checked | Result |
|---|---|---|
| T1 | POST /alert with watched TCIN 1011407490 at $31.99 → queued, TCIN extracted from the URL; GET /next returns it | PASS |
| T2 | POST /alert with unwatched TCIN 9999999999 ($79.99 Unova-style) → ignored `not_watched`; /next returns none | PASS |
| T3 | POST /alert for 1011407490 at $39.99 (above the $31.99 cap) → ignored `over_price_cap` | PASS |
| T4 | Same TCIN alerted again while the first is still pending → ignored `duplicate` | PASS |
| auth | POST /alert with a wrong token → 401 | PASS |
| ack | Claim a pending alert → claimed; second claim → 409 `already_claimed`; claimed alert no longer offered by /next; claimed → failed works | PASS (4 checks) |
| ack-guard | ack `done`/`failed` on an ignored alert → 409 `not_resolvable` (added after an early test run exposed it; covered by its own check in the final run) | PASS |

### Browser tests — `tests/run_browser_tests.js` (jsdom harness, real files, real server)

| Test | What was checked | Result |
|---|---|---|
| T6 | Simulated alert for 1011407490 while the product page is OOS (main button disabled, "Find alternative" button enabled): script wakes, claims, verifies (Redsky returned PerimeterX-blocked from this VM, as expected), finds no usable button, buys nothing, marks the alert `failed: stock_check_blocked`, returns to IDLE. Zero clicks — the alternative button was never touched. `findATCButton()` returns null on the OOS page AND returns the enabled exact-TCIN button in the positive control. Target requests happened only in the one ARMED verification (2 Redsky calls, none while IDLE). | PASS (9/9 checks) |
| T7 | REWRITTEN in v5.4.0 (was: other-TCIN alert ignored): pending alert for the OTHER watched TCIN (1010892070) while the tab is on 1011407490 — the tab now CLAIMS it (first tab wins), goes ARMED, saves the claimed alert for resume after navigation, zero clicks, zero Target requests before reaching the product page. jsdom cannot really navigate, so the URL change itself is not asserted — the "Navigating to the alerted product page…" log + claim + saved resume state prove the path. | PASS (5/5 checks) |
| T9 | Server stopped; Receiver fed a realistic Restockd embed in a fake Discord DOM: it parses the alert (title/price/link), retries the POST 3×, keeps the alert in its retry queue, panel shows 🔴 OFFLINE, zero Target requests. | PASS (5/5 checks) |
| T11 | Dashboard UI (`GET /` + `/api/config`, added 2026-11-20 so a non-technical user never edits a file): page loads with a per-start UI token and the Add-product form; wrong UI token → 401; add product works, duplicate TCIN → 409, non-numeric TCIN → 400; settings update + restore works; remove product works and `/status` is back to the original two products afterwards. Token-change via the dashboard is NOT covered by automated tests (it would break the running test server's auth) — verify it manually once. | PASS (11/11 checks) |
| T12 | No config file (v5.2.0, 2026-11-21): the server starts and serves with NO `config.json` / `config.example.json` anywhere — watchlist + settings come from its own database (`alerts.db`, created automatically), and `/status` shows the seeded two products on a fresh database. (v5.3.0 also removed the token, so nothing is fetched from the dashboard at all.) | PASS (3/3 checks) |
| T13 | Receiver message-id fix (v5.2.1, 2026-11-21): `messageIdOf` took the FIRST 17–20 digit run from `data-list-item-id`, which is the CHANNEL id (`chat-messages-<channelId>-<messageId>`) — after the first alert, every later message in the same channel would be silently skipped as "already processed". Verified against the real id format from the live test message (channel 1573320752499916810, two different message ids): the fix returns the MESSAGE id, different per message. The live test message itself parsed fine (embed title/price/link all present in the DOM); the failure was downstream, see the checklist in the README's T5 section. | PASS (1/1 check) |
| T14 | Token removed + buy modes (v5.3.0, 2026-11-21; default changed to `any` in v5.4.3, 2026-11-24): the token is gone everywhere — server starts and serves with no token, `/alert` and `/ack` take no token field (a stray `token` field is ignored), `/api/config` returns no `secret_token`, and the dashboard has no token section. Buy mode, picked in the dashboard (`/api/config/mode`): default `any` since v5.4.3 (was `selected`); in `any` mode an unwatched TCIN at $999.99 queues, a watched TCIN over its cap queues, dedupe still ignores repeats, an invalid mode is rejected, and switching back to `selected` restores the watchlist filter (unwatched TCIN ignored again). The buyer script reads the mode from `/status` (refreshed every 30s) and skips the price cap in `any` mode. (One real defect caught by this test: the dedupe check lived inside the `else` branch, so `any` mode skipped it — fixed so dedupe runs in both modes, then all 11/11 checks passed.) | PASS (11/11 checks + 2 new default-mode checks in v5.4.3) |
| T18 | Dashboard mode flow (v5.4.3, 2026-11-24): the dashboard page's own script had a REAL syntax error — a mis-escaped quote in the watchlist Remove button (`onclick="removeProduct(\''+…`) — so the whole script never ran: no Save button worked, no mode ever saved, and every page refresh showed the hardcoded "selected" radio again. That was the reported "any product never sticks, refresh shows selected" bug. Fixed by rebuilding the button with `data-tcin` (no nested quotes). Second bug in the same page: the 10 s auto-refresh (`loadAll`) reset the mode radio to the server's current mode, so a choice picked but not yet saved was silently wiped if the user took >10 s to press Save — fixed with dirty flags (refresh skips fields the user touched until the save succeeds). The test loads the REAL served dashboard in jsdom (real UI token, real fetch), asserts the script parses, asserts a fresh DB defaults to `any`, switches the radio, runs a refresh tick, and asserts the unsaved choice survives; then saves and asserts `/status` agrees, in both directions. Mode also verified to survive a server restart in both directions (selected stays selected, any stays any). | PASS (9/9 checks) |
| T15 | `/next-any` + auto-navigate (v5.4.0, 2026-11-21): new server endpoint returns the OLDEST pending alert for ANY TCIN (then the next one after the first is claimed, then none when nothing is pending). The buyer now runs on any `target.com` page (`@match https://www.target.com/*`) and polls `/next-any`; when an alert arrives it claims it and opens that product's page itself (runArmedClaimed's existing navigate branch, now live; boot() also navigates if a claimed alert is saved but the tab landed on the wrong page). First tab to see an alert claims it — other tabs stand down via the 409 claim check. | PASS (8/8 checks) |
| T16 | Real Restockd channel HTML (v5.4.2, 2026-11-24): the Receiver was run in jsdom against the REAL `#pokemon-target` HTML the user pasted (Nov 6–13 messages). It forwarded 28 alerts. Before the fix the URLs were `howl.link` redirects and the parsed fields were wrong (`retailer` = "TargetView on TargetOpen productTime", `qty` = ">= 10RetailerTargetView on TargetOpen pr"). After the fix every alert carries the REAL product URL (`https://www.target.com/p/-/A-…`), `retailer` is exactly "Target", `qty` is ">= 10" or "Pre-Order", and every price is a number. | PASS (7/7 checks) |
| T17 | howl.link redirect unwrap (v5.4.2, 2026-11-24): a watched TCIN posted with a real howl.link URL queues (TCIN read through the redirect) and the stored + `/next-any` URL is the real product page, not howl.link. An unwatched TCIN via howl URL is ignored `not_watched` in selected mode (by design — the dashboard's Any-product mode is the switch for it) and queues in any-mode. | PASS (8/8 checks) |

### NOT RUN (need live conditions — not claimed as passed)

| Test | Why it cannot run here | What it needs |
|---|---|---|
| T5 | Live Discord receiver | Open #pokemon-target, wait for a real Restockd alert; it must appear in `/alerts` within ~5 s. **Sample-server alternative (no waiting for a real restock):** create your own Discord server + channel, add a webhook there, and POST `tests/sample-alert-webhook.json` to it (watched TCIN 1011407490, $31.99). The receiver only requires the message text to contain "Restockd", an "Open product" / `/p/` Target link, and a Price line — it does not check the channel name — so your own test channel works. Keep the Auto-Buy tab on an OUT-OF-STOCK page with "Auto place order" OFF for this test: the script should wake, verify OOS, buy nothing, and return to IDLE. This proves the Discord → server → buyer chain, but not Restockd's real alert delay or real embed quirks — one real alert is still needed later to confirm the real format parses. |
| T8 | Challenge pause | A real PerimeterX Press & Hold appearing mid-ARMED; script must pause, alert, and resume after a manual solve. |
| T10 | Overnight soak | Server + both scripts running overnight with no restock: zero Target requests, zero false buys, server still up in the morning. |

A live purchase is unproven until a real restock is caught end-to-end
and the buyer confirms the order. T6 proves the wiring; only a live
restock proves the purchase.

## Bugs found by testing (all fixed, re-tested)

1. **T6 exposed a ternary-precedence bug in `findATCButton()`** (buyer
   script). `A || B.closest ? C.closest('div') : null` parsed the whole
   `A || B.closest` as the condition, so when the fulfillment section
   existed but the shipping cell did not, it called `.closest()` on
   `null` and crashed the ARMED flow. Fixed by rewriting as separate
   statements. Re-ran T6: PASS.
2. **T6 exposed a mislabelled error path in `runArmed()`**: one `.catch`
   covered both the claim and the buy flow, so a crash inside the buy
   flow was reported as "could not be claimed (another profile may have
   it)". Fixed with separate handlers: claim failures stand down, buy
   flow errors fail the alert with reason `buy_flow_error`. Re-ran T6: PASS.
3. **Early server-test run exposed an ack hole**: `done`/`failed` was
   accepted on `ignored`/`unmatched` alerts. Fixed: only
   `pending`/`claimed` alerts can be resolved. (The failing test data
   in that first run was also wrong — T1 used $79.99 for a $31.99-capped
   product, which the server correctly rejected as over-cap; the test
   was corrected, not the server.)
4. **Harness limitation (not a script bug):** jsdom has no layout
   engine, so `getBoundingClientRect()` returns 0×0 and the scripts'
   `isVisible()` was always false. Fixed in the harness by stubbing
   `getBoundingClientRect()` to non-zero. The scripts are unchanged.

## Notes on the test environment

- Server tests ran on this VM with FastAPI 0.165 / uvicorn (venv).
  The buyer's Windows PC installs the same via `pip install -r
  requirements.txt` (run automatically by `start-server.bat`).
- Redsky calls from this VM are PerimeterX-blocked (HTTP 435), as
  documented in the v4.4 investigation — that is why T6's verification
  ended in `stock_check_blocked` rather than `gone_before_buy`. On the
  buyer's real browser the in-page fetch carries the Target session,
  so a live restock should verify via the API or the DOM button.
- The v4.4 script was not modified. SHA-256 of
  `~/workspace/target-auto-buyer-fix/Target Auto Buyer.js` before and
  after this build: `458e756dda97e19480c5287cd331d77f997e52698d8247432fecb83b2d793c55`
  (unchanged).
- Nothing was pushed to GitHub. Nothing was sent to the buyer.
