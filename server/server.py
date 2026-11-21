"""
Target Discord-Alert Server — Piece 1 of Auto-Buy v5.

Receives Restockd Discord alerts (forwarded by the Tampermonkey Discord
Receiver running in the buyer's own browser tab), matches them against the
watchlist, dedupes them, and queues them for the Tampermonkey
Auto-Buy v5 script running on target.com.

There is NO config file and NO token. Everything the server needs
(watchlist, buy mode, timing settings) lives in its own database file,
alerts.db, created automatically on first start. Just run the server
and open the dashboard — nothing to edit, nothing to copy anywhere.
The server binds to 127.0.0.1 only, and the browser only allows
Discord and Target pages to call it, so a random website cannot
trigger a purchase.

Buy modes (dashboard):
  selected — buy ONLY the watched products, at or under their max price.
  any      — buy ANY Target product that gets alerted, at ANY price.

- Binds to 127.0.0.1 ONLY. Never expose this to the internet.
- This server NEVER talks to Target or Discord itself.
- It does not promise a purchase. A queued alert only means "a watched
  product was alerted" — the buy flow can still lose to a 2-minute stock
  window, a manual Press & Hold challenge, or Target's own limits.

Dashboard: open http://127.0.0.1:5000/ in a browser after starting the
server. The dashboard lets a non-technical user add/remove watched
products, pick the buy mode (selected products vs any product), change
the price caps and timing settings, and see recent alerts — no file
editing needed, nothing to copy anywhere.

Watchlist (the ONLY two products — change them in the dashboard):
  1011407490  Booster Bundle Box     max $31.99
  1010892070  Knock Out Collection   max $11.99
The $79.99 Unova product from the sample screenshots is a SAMPLE ONLY and
is deliberately NOT in the watchlist.

Run:  python server.py        (or double-click start-server.bat on Windows)
Docs: http://127.0.0.1:5000/docs
"""

import json
import logging
import re
import secrets
import sqlite3
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "alerts.db"
LOG_PATH = BASE_DIR / "server.log"

HOST = "127.0.0.1"
PORT = 5000
DEFAULT_DEDUPE_WINDOW_SECONDS = 900
DEFAULT_ALERT_TTL_SECONDS = 600
DEFAULT_WATCHLIST = [
    {"tcin": "1011407490", "name": "Booster Bundle Box", "max_price": 31.99},
    {"tcin": "1010892070", "name": "Knock Out Collection", "max_price": 11.99},
]

# Ephemeral token for the dashboard UI only. Generated fresh on every
# server start, kept in memory, never written to disk. The dashboard page
# served by this server carries it; only a browser that loaded that page
# (on this PC) can call the /api/config endpoints with it. The user
# never sees or types it — it is not a password or a setup step.
UI_TOKEN = secrets.token_urlsafe(24)

STARTED_AT = time.time()

# Settings below are loaded from the database by refresh_settings() after
# init_db() runs. There is no config file and no token: on first start
# the server seeds the default watchlist and the default buy mode
# ("selected") in alerts.db.
BUY_MODE = "selected"  # "selected" | "any"
ALERT_TTL_SECONDS = DEFAULT_ALERT_TTL_SECONDS
DEDUPE_WINDOW_SECONDS = DEFAULT_DEDUPE_WINDOW_SECONDS
WATCHLIST = {}

# ---------------------------------------------------------------- logging
logger = logging.getLogger("v5server")
logger.setLevel(logging.INFO)
handler = RotatingFileHandler(LOG_PATH, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
logger.addHandler(handler)
logger.addHandler(logging.StreamHandler())

# ---------------------------------------------------------------- database
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT,
                price REAL,
                qty TEXT,
                retailer TEXT,
                url TEXT,
                tcin TEXT,
                source TEXT,
                discord_time TEXT,
                message_id TEXT,
                raw_json TEXT,
                status TEXT NOT NULL,
                reason TEXT,
                received_at REAL NOT NULL,
                claimed_at REAL,
                resolved_at REAL
            )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alerts_tcin_status ON alerts(tcin, status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_alerts_received ON alerts(received_at)")
        # Settings tables — the whole reason there is no config file.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY, value TEXT NOT NULL)"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS watchlist (
                tcin TEXT PRIMARY KEY, name TEXT NOT NULL,
                max_price REAL NOT NULL)"""
        )
        # v5.3.0 removed the token entirely: drop it if an older database
        # still has one. No token is ever generated or required again.
        conn.execute("DELETE FROM meta WHERE key='secret_token'")
        # First start (or a database from before v5.3.0): seed the buy
        # mode, the timing defaults and the two watched products.
        for key, default in (("buy_mode", "selected"),
                             ("dedupe_window_seconds", str(DEFAULT_DEDUPE_WINDOW_SECONDS)),
                             ("alert_ttl_seconds", str(DEFAULT_ALERT_TTL_SECONDS))):
            conn.execute(
                "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
                (key, default),
            )
        if not conn.execute("SELECT 1 FROM watchlist LIMIT 1").fetchone():
            for w in DEFAULT_WATCHLIST:
                conn.execute(
                    "INSERT OR IGNORE INTO watchlist (tcin, name, max_price) "
                    "VALUES (?, ?, ?)",
                    (w["tcin"], w["name"], w["max_price"]),
                )
init_db()

def refresh_settings():
    """Load the in-memory settings globals from the database."""
    global BUY_MODE, ALERT_TTL_SECONDS, DEDUPE_WINDOW_SECONDS
    with get_db() as conn:
        meta = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM meta")}
    BUY_MODE = meta.get("buy_mode", "selected")
    if BUY_MODE not in ("selected", "any"):
        BUY_MODE = "selected"
    ALERT_TTL_SECONDS = int(meta.get("alert_ttl_seconds", DEFAULT_ALERT_TTL_SECONDS))
    DEDUPE_WINDOW_SECONDS = int(meta.get("dedupe_window_seconds", DEFAULT_DEDUPE_WINDOW_SECONDS))

def refresh_watchlist():
    """Load the in-memory WATCHLIST dict from the database."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM watchlist").fetchall()
    WATCHLIST.clear()
    WATCHLIST.update({r["tcin"]: {"tcin": r["tcin"], "name": r["name"],
                                  "max_price": r["max_price"]} for r in rows})

def set_meta(key: str, value: str):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

refresh_settings()
refresh_watchlist()

def row_to_dict(row):
    d = dict(row)
    return d

# ---------------------------------------------------------------- helpers
TCIN_PATTERNS = [
    re.compile(r"/A-(\d{6,})"),
    re.compile(r"[?&]tcin=(\d{6,})"),
    re.compile(r"/p/[^/?#]*-(\d{6,})"),
    re.compile(r"(\d{10})"),  # last resort: a bare 10-digit TCIN in the URL
]

def extract_tcin(url: Optional[str], explicit: Optional[str] = None) -> Optional[str]:
    if explicit and re.fullmatch(r"\d{6,}", str(explicit).strip()):
        return str(explicit).strip()
    if not url:
        return None
    for pat in TCIN_PATTERNS:
        m = pat.search(url)
        if m:
            return m.group(1)
    return None

def parse_price(value) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = re.search(r"(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)", str(value).replace("$", ""))
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", ""))
    except ValueError:
        return None

def expire_stale_pending(conn):
    """Pending alerts older than the TTL are dead — mark them expired."""
    cutoff = time.time() - ALERT_TTL_SECONDS
    cur = conn.execute(
        "UPDATE alerts SET status='failed', reason='expired', resolved_at=? "
        "WHERE status='pending' AND received_at < ?",
        (time.time(), cutoff),
    )
    if cur.rowcount:
        logger.info("expired %d stale pending alert(s)", cur.rowcount)

# ---------------------------------------------------------------- models
# No token anywhere (v5.3.0): the server binds to 127.0.0.1 only, and
# CORS below allows only Discord and Target pages to call it from a
# browser. The Tampermonkey scripts use GM_xmlhttpRequest, which is not
# subject to CORS at all.
class AlertIn(BaseModel):
    source: str = "restockd-discord"
    title: Optional[str] = None
    price: Optional[float] = None
    qty: Optional[str] = None
    retailer: Optional[str] = None
    url: Optional[str] = None
    tcin: Optional[str] = None
    discord_time: Optional[str] = None
    message_id: Optional[str] = None

class AckIn(BaseModel):
    alert_id: int
    status: str = Field(pattern="^(claimed|done|failed)$")
    reason: Optional[str] = None

class ModeIn(BaseModel):
    mode: str = Field(pattern="^(selected|any)$")

# ---------------------------------------------------------------- app
app = FastAPI(title="Target Discord-Alert Server v5", version="5.3.0")
app.add_middleware(
    CORSMiddleware,
    # Only Discord and Target pages may call this server from a browser.
    # (GM_xmlhttpRequest from the Tampermonkey scripts bypasses CORS.)
    allow_origins=["https://discord.com", "https://www.target.com",
                   "https://target.com"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/status")
def status():
    with get_db() as conn:
        expire_stale_pending(conn)
        pending = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE status='pending'"
        ).fetchone()[0]
    return {
        "ok": True,
        "mode": BUY_MODE,
        "watchlist": [
            {"tcin": t, "name": w["name"], "max_price": w["max_price"]}
            for t, w in WATCHLIST.items()
        ],
        "pending": pending,
        "uptime_seconds": int(time.time() - STARTED_AT),
    }

@app.post("/alert")
def post_alert(payload: AlertIn):
    now = time.time()
    tcin = extract_tcin(payload.url, payload.tcin)
    price = parse_price(payload.price)
    raw = payload.model_dump_json()

    status, reason = "pending", None
    if not tcin:
        status, reason = "unmatched", "no_tcin_in_url"
    elif BUY_MODE == "any":
        pass  # any product, any price — no watchlist / cap check
    elif tcin not in WATCHLIST:
        status, reason = "ignored", "not_watched"
    elif price is not None and price > float(WATCHLIST[tcin]["max_price"]):
        status, reason = "ignored", "over_price_cap"
    # Dedupe runs in BOTH modes: a repeat alert for the same product
    # while one is still pending/claimed must not buy twice.
    if status == "pending":
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, status FROM alerts WHERE tcin=? AND received_at > ? "
                "AND status IN ('pending','claimed') ORDER BY id DESC LIMIT 1",
                (tcin, now - DEDUPE_WINDOW_SECONDS),
            ).fetchone()
            if row:
                status, reason = "ignored", "duplicate"

    with get_db() as conn:
        cur = conn.execute(
            """INSERT INTO alerts
               (title, price, qty, retailer, url, tcin, source, discord_time,
                message_id, raw_json, status, reason, received_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (payload.title, price, payload.qty, payload.retailer, payload.url,
             tcin, payload.source, payload.discord_time, payload.message_id,
             raw, status, reason, now),
        )
        alert_id = cur.lastrowid

    logger.info(
        "alert id=%s tcin=%s price=%s decision=%s reason=%s title=%r",
        alert_id, tcin, price, status, reason, (payload.title or "")[:80],
    )
    return {"ok": True, "alert_id": alert_id, "tcin": tcin,
            "status": "queued" if status == "pending" else status,
            "reason": reason}

@app.get("/next")
def next_alert(tcin: str = Query(...)):
    with get_db() as conn:
        expire_stale_pending(conn)
        row = conn.execute(
            "SELECT * FROM alerts WHERE tcin=? AND status='pending' "
            "ORDER BY received_at ASC LIMIT 1",
            (tcin,),
        ).fetchone()
    if not row:
        return {"status": "none"}
    return {"status": "pending", "alert": row_to_dict(row)}

@app.post("/ack")
def ack_alert(payload: AckIn):
    now = time.time()
    with get_db() as conn:
        row = conn.execute("SELECT * FROM alerts WHERE id=?", (payload.alert_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="alert not found")
        current = row["status"]
        if payload.status == "claimed":
            if current == "claimed":
                return JSONResponse(
                    status_code=409,
                    content={"ok": False, "error": "already_claimed",
                             "alert_id": payload.alert_id, "status": current},
                )
            if current != "pending":
                return JSONResponse(
                    status_code=409,
                    content={"ok": False, "error": "not_claimable",
                             "alert_id": payload.alert_id, "status": current},
                )
            conn.execute(
                "UPDATE alerts SET status='claimed', claimed_at=? WHERE id=?",
                (now, payload.alert_id),
            )
        else:  # done / failed — only from pending/claimed, never from ignored/unmatched
            if current in ("done", "failed"):
                return JSONResponse(
                    status_code=409,
                    content={"ok": False, "error": "already_resolved",
                             "alert_id": payload.alert_id, "status": current},
                )
            if current not in ("pending", "claimed"):
                return JSONResponse(
                    status_code=409,
                    content={"ok": False, "error": "not_resolvable",
                             "alert_id": payload.alert_id, "status": current},
                )
            conn.execute(
                "UPDATE alerts SET status=?, reason=COALESCE(?, reason), resolved_at=? WHERE id=?",
                (payload.status, payload.reason, now, payload.alert_id),
            )
    logger.info("ack id=%s -> %s reason=%s", payload.alert_id, payload.status, payload.reason)
    return {"ok": True, "alert_id": payload.alert_id, "status": payload.status}

@app.get("/alerts")
def list_alerts(limit: int = Query(50, ge=1, le=200)):
    with get_db() as conn:
        expire_stale_pending(conn)
        rows = conn.execute(
            "SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return {"ok": True, "alerts": [row_to_dict(r) for r in rows]}

# ---------------------------------------------------------------- dashboard UI
# A plain-English web page for a non-technical user: add/remove watched
# products, change price caps and timing, see recent alerts. No file
# editing needed. The page is served only on 127.0.0.1. Config changes go
# through /api/config, which requires the per-start UI_TOKEN (embedded in
# the served page only).
class WatchlistAddIn(BaseModel):
    tcin: str
    name: str
    max_price: float

class SettingsIn(BaseModel):
    dedupe_window_seconds: int = Field(ge=60, le=86400)
    alert_ttl_seconds: int = Field(ge=60, le=86400)

def check_ui_token(request: Request):
    if request.headers.get("X-UI-Token") != UI_TOKEN:
        raise HTTPException(status_code=401, detail="bad ui token")

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Target Alert Server — Dashboard</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#111827;background:#f9fafb}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:12px 0}
.ok{color:#047857;font-weight:700}.warn{color:#b45309}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid #e5e7eb;font-size:14px}
input,button{font-size:14px;padding:7px 9px;border-radius:6px;border:1px solid #d1d5db}
button{background:#111827;color:#fff;border-color:#111827;cursor:pointer}
button.danger{background:#fff;color:#b91c1c;border-color:#b91c1c}
label{display:block;font-size:13px;color:#4b5563;margin:8px 0 3px}
.msg{font-size:14px;margin:6px 0;min-height:18px}
.muted{font-size:13px;color:#6b7280}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>&#127919; Target Alert Server — Dashboard</h1>
<p class="muted">This page runs only on your own PC. The bot buys <b>only</b> the
products listed below, one item each, at or under the max price. Add a product
here — no need to edit any file.</p>
<div class="card"><b>Status:</b> <span id="status">checking&hellip;</span><br>
<span class="muted" id="uptime"></span></div>

<h2>Watched products</h2>
<div class="card"><table><thead><tr><th>Product</th><th>TCIN</th><th>Max price</th><th></th></tr></thead>
<tbody id="watchlist"></tbody></table>
<p class="muted">To find a product's TCIN, open it on target.com and click an alert's
"Open product" link — the TCIN is the number after <code>/A-</code> in the address.</p></div>

<h2>Add a product</h2>
<div class="card">
<label>Product name (e.g. Booster Bundle Box)</label>
<input id="add-name" style="width:95%" placeholder="Product name">
<label>TCIN (numbers only, e.g. 1011407490)</label>
<input id="add-tcin" style="width:95%" placeholder="1011407490">
<label>Max price in $ (the bot never pays more than this)</label>
<input id="add-price" type="number" min="0.01" step="0.01" placeholder="31.99">
<br><br><button onclick="addProduct()">Add product</button>
<div class="msg" id="add-msg"></div></div>

<h2>Settings</h2>
<div class="card">
<label>Ignore a repeat alert for the same product for (minutes)</label>
<input id="set-dedupe" type="number" min="1" max="1440" value="15">
<label>Forget a waiting alert after (minutes)</label>
<input id="set-ttl" type="number" min="1" max="1440" value="10">
<br><br><button onclick="saveSettings()">Save settings</button>
<div class="msg" id="set-msg"></div></div>

<h2>What to buy</h2>
<div class="card">
<label><input type="radio" name="buy-mode" value="selected" checked> <b>Selected products only</b> — buy only the products listed below, at or under their max price.</label>
<label><input type="radio" name="buy-mode" value="any"> <b>Any product, any price</b> — buy whatever product gets alerted, at whatever price it is. Use carefully: one alert = one purchase attempt.</label>
<br><button onclick="setMode()">Save choice</button>
<div class="msg" id="mode-msg"></div>
<p class="muted" id="mode-note"></p></div>

<h2>Recent alerts <button onclick="loadAll()">Refresh</button></h2>
<div class="card"><table><thead><tr><th>Product</th><th>Price</th><th>Status</th><th>Time</th></tr></thead>
<tbody id="alerts"></tbody></table>
<p class="muted">Statuses: <code>queued</code> = waiting for the buyer,
<code>ignored</code> = not a watched product / over the price cap / duplicate,
<code>claimed/done/failed</code> = the buyer acted on it.</p></div>

<script>
const UI_TOKEN = "__UI_TOKEN__";
async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({"X-UI-Token": UI_TOKEN, "Content-Type": "application/json"}, opts.headers || {});
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || ("Error " + r.status));
  return j;
}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
async function loadAll(){
  try{
    const st = await api("/status");
    document.getElementById("status").innerHTML = '<span class="ok">Running</span> — ' + st.pending + ' alert(s) waiting';
    document.getElementById("uptime").textContent = "Up for " + Math.floor(st.uptime_seconds/60) + " minute(s).";
    const cfg = await api("/api/config");
    document.querySelector('input[name="buy-mode"][value="' + (cfg.mode || "selected") + '"]').checked = true;
    document.getElementById("mode-note").textContent = cfg.mode === "any"
      ? "Any-product mode is ON — the list below is ignored, every Target alert will be queued."
      : "Selected-products mode — only the products below will be bought, at or under their max price.";
    document.getElementById("set-dedupe").value = Math.round(cfg.dedupe_window_seconds/60);
    document.getElementById("set-ttl").value = Math.round(cfg.alert_ttl_seconds/60);
    document.getElementById("watchlist").innerHTML = cfg.watchlist.map(w =>
      "<tr><td>"+esc(w.name)+"</td><td>"+esc(w.tcin)+"</td><td>$"+esc(w.max_price)+"</td>" +
      '<td><button class="danger" onclick="removeProduct(\''+esc(w.tcin)+'\')">Remove</button></td></tr>').join("") ||
      '<tr><td colspan="4">No products watched — the bot will buy nothing. Add one above.</td></tr>';
    const al = await api("/alerts?limit=20");
    document.getElementById("alerts").innerHTML = al.alerts.map(a =>
      "<tr><td>"+esc(a.title||a.tcin)+"</td><td>"+(a.price==null?"—":"$"+a.price)+"</td><td>"+esc(a.status)+(a.reason?" ("+esc(a.reason)+")":"")+"</td><td>"+esc(new Date(a.received_at*1000).toLocaleString())+"</td></tr>").join("") ||
      '<tr><td colspan="4">No alerts yet.</td></tr>';
  }catch(e){ document.getElementById("status").textContent = "Could not reach the server: " + e.message; }
}
async function addProduct(){
  const msg = document.getElementById("add-msg");
  try{
    const body = {tcin: document.getElementById("add-tcin").value.trim(),
      name: document.getElementById("add-name").value.trim(),
      max_price: parseFloat(document.getElementById("add-price").value)};
    await api("/api/config/watchlist", {method: "POST", body: JSON.stringify(body)});
    msg.innerHTML = '<span class="ok">Added.</span>'; loadAll();
  }catch(e){ msg.textContent = "Could not add: " + e.message; }
}
async function removeProduct(tcin){
  if(!confirm("Remove this product from the watchlist? The bot will no longer buy it.")) return;
  await api("/api/config/watchlist/" + encodeURIComponent(tcin), {method: "DELETE"});
  loadAll();
}
async function saveSettings(){
  const msg = document.getElementById("set-msg");
  try{
    await api("/api/config/settings", {method: "POST", body: JSON.stringify({
      dedupe_window_seconds: parseInt(document.getElementById("set-dedupe").value,10)*60,
      alert_ttl_seconds: parseInt(document.getElementById("set-ttl").value,10)*60})});
    msg.innerHTML = '<span class="ok">Settings saved.</span>';
  }catch(e){ msg.textContent = "Could not save: " + e.message; }
}
async function setMode(){
  const msg = document.getElementById("mode-msg");
  const mode = document.querySelector('input[name="buy-mode"]:checked').value;
  if(mode === "any" && !confirm("Any-product mode buys WHATEVER product gets alerted, at ANY price. Are you sure?")) { loadAll(); return; }
  try{
    await api("/api/config/mode", {method: "POST", body: JSON.stringify({mode: mode})});
    msg.innerHTML = '<span class="ok">Saved.</span>';
    loadAll();
  }catch(e){ msg.textContent = "Could not save: " + e.message; }
}
loadAll(); setInterval(loadAll, 10000);
</script></body></html>
"""

@app.get("/", response_class=HTMLResponse)
def dashboard():
    return DASHBOARD_HTML.replace("__UI_TOKEN__", UI_TOKEN)

@app.get("/api/config")
def get_config(request: Request):
    check_ui_token(request)
    return {
        "ok": True,
        "mode": BUY_MODE,
        "watchlist": [
            {"tcin": t, "name": w["name"], "max_price": w["max_price"]}
            for t, w in WATCHLIST.items()
        ],
        "dedupe_window_seconds": DEDUPE_WINDOW_SECONDS,
        "alert_ttl_seconds": ALERT_TTL_SECONDS,
    }

@app.post("/api/config/mode")
def set_buy_mode(payload: ModeIn, request: Request):
    check_ui_token(request)
    set_meta("buy_mode", payload.mode)
    refresh_settings()
    logger.info("dashboard: buy mode set to %s", BUY_MODE)
    return {"ok": True, "mode": BUY_MODE}

@app.post("/api/config/watchlist")
def add_watchlist(payload: WatchlistAddIn, request: Request):
    check_ui_token(request)
    tcin = payload.tcin.strip()
    name = payload.name.strip()
    if not re.fullmatch(r"\d{6,}", tcin):
        raise HTTPException(status_code=400, detail="TCIN must be numbers only (6+ digits)")
    if not name or len(name) > 120:
        raise HTTPException(status_code=400, detail="Product name must be 1-120 characters")
    if not (0 < payload.max_price <= 10000):
        raise HTTPException(status_code=400, detail="Max price must be between $0.01 and $10000")
    if tcin in WATCHLIST:
        raise HTTPException(status_code=409, detail="That TCIN is already watched")
    with get_db() as conn:
        conn.execute(
            "INSERT INTO watchlist (tcin, name, max_price) VALUES (?, ?, ?)",
            (tcin, name, payload.max_price),
        )
    refresh_watchlist()
    logger.info("dashboard: added watchlist %s %s max $%s", tcin, name, payload.max_price)
    return {"ok": True, "watchlist": list(WATCHLIST.values())}

@app.delete("/api/config/watchlist/{tcin}")
def remove_watchlist(tcin: str, request: Request):
    check_ui_token(request)
    if tcin not in WATCHLIST:
        raise HTTPException(status_code=404, detail="That TCIN is not watched")
    with get_db() as conn:
        conn.execute("DELETE FROM watchlist WHERE tcin=?", (tcin,))
    refresh_watchlist()
    logger.info("dashboard: removed watchlist %s", tcin)
    return {"ok": True, "watchlist": list(WATCHLIST.values())}

@app.post("/api/config/settings")
def update_settings(payload: SettingsIn, request: Request):
    check_ui_token(request)
    set_meta("dedupe_window_seconds", str(payload.dedupe_window_seconds))
    set_meta("alert_ttl_seconds", str(payload.alert_ttl_seconds))
    refresh_settings()
    logger.info("dashboard: settings dedupe=%s ttl=%s",
                DEDUPE_WINDOW_SECONDS, ALERT_TTL_SECONDS)
    return {"ok": True,
            "dedupe_window_seconds": DEDUPE_WINDOW_SECONDS,
            "alert_ttl_seconds": ALERT_TTL_SECONDS}

if __name__ == "__main__":
    import uvicorn
    logger.info("v5 server starting on %s:%d (mode: %s, watchlist: %s)",
                HOST, PORT, BUY_MODE, ", ".join(WATCHLIST))
    logger.info("dashboard: open http://127.0.0.1:%d/ in a browser", PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
