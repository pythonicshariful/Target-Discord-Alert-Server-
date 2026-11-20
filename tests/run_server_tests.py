"""Server tests T1-T4 for the v5 Discord-Alert server (run while server.py is up).
Usage:  python tests/run_server_tests.py [base_url]
Prints PASS/FAIL per test and exits non-zero on any failure.
Uses a FRESH database: stop the server, delete server/alerts.db, restart, run.
"""
import json
import sys
import urllib.request

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:5000"
import pathlib
TOKEN = json.loads((pathlib.Path(__file__).resolve().parent.parent
    / "server" / "config.json").read_text())["secret_token"]  # local config only, never pushed
FAILURES = []


def call(method, path, body=None):
    req = urllib.request.Request(
        BASE + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" — {detail}" if detail else ""))
    if not cond:
        FAILURES.append(name)


# --- T1: server receives + parses a watched alert (Nov 13 Restockd format,
# --- but with a WATCHED product at its real price — the $79.99 in the sample
# --- screenshots belongs to the Unova product, which is NOT watched) ---
s, r = call("POST", "/alert", {
    "token": TOKEN, "source": "restockd-discord",
    "title": "Pokémon TCG 30th Celebration Booster Bundle Box | Target",
    "price": 31.99, "qty": "Pre-Order", "retailer": "Target",
    "url": "https://www.target.com/p/pokemon-tcg-30th-celebration-booster-bundle-box/-/A-1011407490",
    "discord_time": "2026-11-13 04:44 AM", "message_id": "test-msg-1",
})
check("T1 parse+queue watched TCIN",
      s == 200 and r.get("status") == "queued" and r.get("tcin") == "1011407490",
      f"HTTP {s} {r}")
t1_id = r.get("alert_id")

s, r = call("GET", f"/next?tcin=1011407490")
check("T1 /next returns the queued alert",
      s == 200 and r.get("status") == "pending"
      and r.get("alert", {}).get("id") == t1_id,
      f"HTTP {s} {r}")

# --- T2: watchlist filter — TCIN not watched (the $79.99 Unova sample has no
# --- known TCIN; use a made-up one to prove the filter) ---
s, r = call("POST", "/alert", {
    "token": TOKEN, "source": "restockd-discord",
    "title": "Pokémon Trading Card Game: Unova Hea... | Target",
    "price": 79.99, "qty": "Pre-Order", "retailer": "Target",
    "url": "https://www.target.com/p/pokemon-trading-card-game-unova-heroes/-/A-9999999999",
    "discord_time": "2026-11-13 04:54 AM", "message_id": "test-msg-2",
})
check("T2 unwatched TCIN ignored",
      s == 200 and r.get("status") == "ignored" and r.get("reason") == "not_watched",
      f"HTTP {s} {r}")

s, r = call("GET", "/next?tcin=9999999999")
check("T2 /next for unwatched TCIN is none",
      s == 200 and r.get("status") == "none", f"HTTP {s} {r}")

# --- T3: price cap — watched TCIN above its max price ---
s, r = call("POST", "/alert", {
    "token": TOKEN, "source": "restockd-discord",
    "title": "Pokémon TCG 30th Celebration Booster Bundle Box | Target",
    "price": 39.99, "qty": "Pre-Order", "retailer": "Target",
    "url": "https://www.target.com/p/-/A-1011407490",
    "discord_time": "2026-11-13 05:00 AM", "message_id": "test-msg-3",
})
check("T3 over-cap price ignored",
      s == 200 and r.get("status") == "ignored" and r.get("reason") == "over_price_cap",
      f"HTTP {s} {r}")

# --- T3b: ignored alerts cannot be resolved (guard added 2026-11-20) ---
s, r = call("POST", "/ack", {"token": TOKEN, "alert_id": 3, "status": "failed", "reason": "gone_before_buy"})
check("ack-guard: failed on an ignored alert rejected (409 not_resolvable)",
      s == 409 and r.get("error") == "not_resolvable", f"HTTP {s} {r}")

# --- T4: dedupe — same TCIN alerted again while the first is still pending ---
s, r = call("POST", "/alert", {
    "token": TOKEN, "source": "restockd-discord",
    "title": "Pokémon TCG 30th Celebration Booster Bundle Box | Target",
    "price": 31.99, "qty": "Pre-Order", "retailer": "Target",
    "url": "https://www.target.com/p/-/A-1011407490",
    "discord_time": "2026-11-13 04:54 AM", "message_id": "test-msg-4",
})
check("T4 duplicate alert ignored",
      s == 200 and r.get("status") == "ignored" and r.get("reason") == "duplicate",
      f"HTTP {s} {r}")

# --- extra: auth + ack flow (supports T6/T7 harness) ---
s, r = call("POST", "/alert", {"token": "wrong-token", "url": "https://www.target.com/p/-/A-1011407490"})
check("auth: bad token rejected (401)",
      s == 401, f"HTTP {s} {r}")

s, r = call("POST", "/ack", {"token": TOKEN, "alert_id": t1_id, "status": "claimed"})
check("ack: claim pending alert",
      s == 200 and r.get("status") == "claimed", f"HTTP {s} {r}")

s, r = call("POST", "/ack", {"token": TOKEN, "alert_id": t1_id, "status": "claimed"})
check("ack: second claim rejected (409 already_claimed)",
      s == 409 and r.get("error") == "already_claimed", f"HTTP {s} {r}")

s, r = call("GET", "/next?tcin=1011407490")
check("ack: claimed alert no longer offered by /next",
      s == 200 and r.get("status") == "none", f"HTTP {s} {r}")

s, r = call("POST", "/ack", {"token": TOKEN, "alert_id": t1_id, "status": "failed", "reason": "gone_before_buy"})
check("ack: claimed -> failed",
      s == 200 and r.get("status") == "failed", f"HTTP {s} {r}")

# --- T11: dashboard UI (GET / page + /api/config) ---
# The dashboard page carries a per-start UI token; extract it from the
# HTML exactly as a browser would, then use it for the config calls.
import re
import urllib.request as _urlreq
try:
    with _urlreq.urlopen(BASE + "/", timeout=10) as resp:
        html = resp.read().decode()
        m = re.search(r'const UI_TOKEN = "([^"]+)"', html)
        ui_token = m.group(1) if m else ""
    check("T11 dashboard page loads with UI token", bool(ui_token), f"token found: {bool(ui_token)}")
    check("T11 dashboard page has Add product form",
          "Add a product" in html and "Watched products" in html)
except Exception as e:  # noqa: BLE001 - test harness reports it as a failure
    ui_token = ""
    check("T11 dashboard page loads with UI token", False, str(e))

def ui_call(method, path, body=None):
    req = _urlreq.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json", "X-UI-Token": ui_token},
    )
    try:
        with _urlreq.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

if ui_token:
    s, r = ui_call("GET", "/api/config")
    # wrong-token check: same endpoint with a wrong token must 401
    req = _urlreq.Request(BASE + "/api/config", headers={"X-UI-Token": "wrong"})
    try:
        with _urlreq.urlopen(req, timeout=10) as resp:
            s_noauth = resp.status
    except urllib.error.HTTPError as e:
        s_noauth = e.code
    check("T11 /api/config with wrong UI token -> 401", s_noauth == 401, f"HTTP {s_noauth}")
    check("T11 /api/config returns watchlist + token (UI-token protected, dashboard only)",
          s == 200 and "secret_token" in r and r.get("secret_token") == TOKEN
          and len(r.get("watchlist", [])) == 2, f"HTTP {s} {r}")
    s, r = ui_call("POST", "/api/config/watchlist",
                   {"tcin": "1234567890", "name": "Test Product", "max_price": 9.99})
    check("T11 add product via dashboard", s == 200
          and any(w["tcin"] == "1234567890" for w in r.get("watchlist", [])),
          f"HTTP {s} {r}")
    s, r = ui_call("POST", "/api/config/watchlist",
                   {"tcin": "1234567890", "name": "Test Product", "max_price": 9.99})
    check("T11 duplicate TCIN rejected (409)", s == 409, f"HTTP {s} {r}")
    s, r = ui_call("POST", "/api/config/watchlist",
                   {"tcin": "ABC", "name": "Bad", "max_price": 9.99})
    check("T11 non-numeric TCIN rejected (400)", s == 400, f"HTTP {s} {r}")
    s, r = ui_call("POST", "/api/config/settings",
                   {"dedupe_window_seconds": 901, "alert_ttl_seconds": 601})
    check("T11 settings update via dashboard", s == 200
          and r.get("dedupe_window_seconds") == 901, f"HTTP {s} {r}")
    s, r = ui_call("POST", "/api/config/settings",
                   {"dedupe_window_seconds": 900, "alert_ttl_seconds": 600})
    check("T11 settings restored", s == 200
          and r.get("dedupe_window_seconds") == 900, f"HTTP {s} {r}")
    s, r = ui_call("DELETE", "/api/config/watchlist/1234567890")
    check("T11 remove product via dashboard", s == 200
          and not any(w["tcin"] == "1234567890" for w in r.get("watchlist", [])),
          f"HTTP {s} {r}")
    s, r = call("GET", "/status")
    check("T11 /status watchlist back to the original two",
          s == 200 and len(r.get("watchlist", [])) == 2, f"HTTP {s} {r}")

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("RESULT: all server tests passed")
