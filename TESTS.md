# TESTS.md — Auto-Buy v5 test record

**Date:** 2026-11-20 (re-verified after the 2026-11-20 token sanitization
for the public repo push: server tests 12/12, T6 9/9, T7 5/5 — all PASS)
**Rule followed:** no test is marked passed unless it was actually run.
Tests that need the live Discord channel, a real challenge, or an
overnight soak are marked NOT RUN, not passed.
**Token note:** the test harnesses read the secret token from the local
`server/config.json` at runtime — no real token is stored in any test
file or in this repo.

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
| T7 | Pending alert for the OTHER watched TCIN (1010892070) while the tab is on 1011407490: script stays IDLE, zero clicks, zero Target requests, the other alert stays pending (not stolen). | PASS (5/5 checks) |
| T9 | Server stopped; Receiver fed a realistic Restockd embed in a fake Discord DOM: it parses the alert (title/price/link), retries the POST 3×, keeps the alert in its retry queue, panel shows 🔴 OFFLINE, zero Target requests. | PASS (5/5 checks) |

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
