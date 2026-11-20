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

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("RESULT: all server tests passed")
