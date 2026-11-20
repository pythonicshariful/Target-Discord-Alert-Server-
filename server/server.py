"""
Target Discord-Alert Server — Piece 1 of Auto-Buy v5.

Receives Restockd Discord alerts (forwarded by the Tampermonkey Discord
Receiver running in the buyer's own browser tab), matches them against the
watchlist in config.json, dedupes them, and queues them for the Tampermonkey
Auto-Buy v5 script running on target.com.

- Binds to 127.0.0.1 ONLY. Never expose this to the internet.
- This server NEVER talks to Target or Discord itself.
- It does not promise a purchase. A queued alert only means "a watched
  product was alerted" — the buy flow can still lose to a 2-minute stock
  window, a manual Press & Hold challenge, or Target's own limits.

Dashboard: open http://127.0.0.1:5000/ in a browser after starting the
server. The dashboard lets a non-technical user add/remove watched
products, change the price caps and timing settings, and see recent
alerts — no file editing needed. (The buyer still sets the same secret
token in the two Tampermonkey scripts once, see README.md.)

Watchlist (config.json — the ONLY two products):
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
CONFIG_PATH = BASE_DIR / "config.json"
CONFIG_EXAMPLE_PATH = BASE_DIR / "config.example.json"
DB_PATH = BASE_DIR / "alerts.db"
LOG_PATH = BASE_DIR / "server.log"

# ---------------------------------------------------------------- config
# If config.json is missing (first run), create it from the example with a
# fresh random token, so a non-technical user never has to edit a file to
# get started. The token still has to be copied into the two Tampermonkey
# scripts once (dashboard shows it — see the dashboard's Token section).
if not CONFIG_PATH.exists():
    if CONFIG_EXAMPLE_PATH.exists():
        CONFIG = json.loads(CONFIG_EXAMPLE_PATH.read_text(encoding="utf-8"))
    else:
        CONFIG = {
            "alert_ttl_seconds": 600,
            "dedupe_window_seconds": 900,
            "host": "127.0.0.1",
            "port": 5000,
            "secret_token": "CHANGE-ME-replace-with-a-long-random-string",
            "watchlist": [
                {"max_price": 31.99, "name": "Booster Bundle Box",
                 "tcin": "1011407490"},
                {"max_price": 11.99, "name": "Knock Out Collection",
                 "tcin": "1010892070"},
            ],
        }
    CONFIG["secret_token"] = secrets.token_hex(16)
    CONFIG_PATH.write_text(json.dumps(CONFIG, indent=2) + "\n", encoding="utf-8")

with open(CONFIG_PATH, encoding="utf-8") as f:
    CONFIG = json.load(f)

# Ephemeral token for the dashboard UI only. Generated fresh on every
# server start, kept in memory, never written to disk. The dashboard page
# served by this server carries it; only a browser that loaded that page
# (on this PC) can call the /api/config endpoints with it. It is NOT the
# alert token the Tampermonkey scripts use.
UI_TOKEN = secrets.token_urlsafe(24)

def save_config():
    """Persist the in-memory CONFIG back to config.json."""
    CONFIG_PATH.write_text(json.dumps(CONFIG, indent=2) + "\n", encoding="utf-8")

def sync_watchlist_from_config():
    WATCHLIST.clear()
    WATCHLIST.update({w["tcin"]: w for w in CONFIG["watchlist"]})

SECRET_TOKEN = CONFIG["secret_token"]
PORT = int(CONFIG.get("port", 5000))
HOST = CONFIG.get("host", "127.0.0.1")
ALERT_TTL_SECONDS = int(CONFIG.get("alert_ttl_seconds", 600))
DEDUPE_WINDOW_SECONDS = int(CONFIG.get("dedupe_window_seconds", 900))
WATCHLIST = {w["tcin"]: w for w in CONFIG["watchlist"]}

if not SECRET_TOKEN or SECRET_TOKEN.startswith("CHANGE-ME"):
    raise SystemExit("config.json: set a long random secret_token before starting.")

STARTED_AT = time.time()

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
init_db()

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

def check_token(token: Optional[str]):
    if token != SECRET_TOKEN:
        raise HTTPException(status_code=401, detail="bad token")

# ---------------------------------------------------------------- models
class AlertIn(BaseModel):
    token: str
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
    token: str
    alert_id: int
    status: str = Field(pattern="^(claimed|done|failed)$")
    reason: Optional[str] = None

# ---------------------------------------------------------------- app
app = FastAPI(title="Target Discord-Alert Server v5", version="5.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # localhost-only service; browser userscripts call it directly
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
        "watchlist": [
            {"tcin": t, "name": w["name"], "max_price": w["max_price"]}
            for t, w in WATCHLIST.items()
        ],
        "pending": pending,
        "uptime_seconds": int(time.time() - STARTED_AT),
    }

@app.post("/alert")
def post_alert(payload: AlertIn):
    check_token(payload.token)
    now = time.time()
    tcin = extract_tcin(payload.url, payload.tcin)
    price = parse_price(payload.price)
    raw = payload.model_dump_json()

    status, reason = "pending", None
    if not tcin:
        status, reason = "unmatched", "no_tcin_in_url"
    elif tcin not in WATCHLIST:
        status, reason = "ignored", "not_watched"
    elif price is not None and price > float(WATCHLIST[tcin]["max_price"]):
        status, reason = "ignored", "over_price_cap"
    else:
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
def next_alert(tcin: str = Query(...), token: Optional[str] = Query(None)):
    # Read path: token is optional (localhost-only service). If a token IS
    # supplied it must be correct; the write paths always require it.
    if token is not None:
        check_token(token)
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
    check_token(payload.token)
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
# the served page only). The alert token is shown masked, with a
# show/copy button — it never leaves this PC, and it is never in the repo.
class WatchlistAddIn(BaseModel):
    tcin: str
    name: str
    max_price: float

class SettingsIn(BaseModel):
    dedupe_window_seconds: int = Field(ge=60, le=86400)
    alert_ttl_seconds: int = Field(ge=60, le=86400)

class TokenIn(BaseModel):
    new_token: str

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

<h2>Secret token</h2>
<div class="card"><p class="muted">The server and the two Tampermonkey scripts share one
secret word. <b>After changing it here, you must put the same word in both
scripts</b> (Tampermonkey dashboard &gt; script &gt; Settings &gt; <code>v5_token</code>),
or the scripts stop working. Never post this word anywhere.</p>
<p>Current token: <code id="token-masked">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</code>
<button onclick="toggleToken()">Show</button>
<button onclick="copyToken()">Copy</button></p>
<label>New token (at least 16 characters)</label>
<input id="new-token" style="width:95%" placeholder="a long random word of your own">
<br><br><button onclick="changeToken()">Change token</button>
<div class="msg" id="tok-msg"></div></div>

<h2>Recent alerts <button onclick="loadAll()">Refresh</button></h2>
<div class="card"><table><thead><tr><th>Product</th><th>Price</th><th>Status</th><th>Time</th></tr></thead>
<tbody id="alerts"></tbody></table>
<p class="muted">Statuses: <code>queued</code> = waiting for the buyer,
<code>ignored</code> = not a watched product / over the price cap / duplicate,
<code>claimed/done/failed</code> = the buyer acted on it.</p></div>

<script>
const UI_TOKEN = "__UI_TOKEN__";
let fullToken = "";
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
    fullToken = cfg.secret_token || "";
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
function toggleToken(){
  const el = document.getElementById("token-masked");
  if(el.textContent.indexOf("•") !== -1){ el.textContent = fullToken; }
  else{ el.textContent = "••••••••"; }
}
function copyToken(){
  if(navigator.clipboard && fullToken){ navigator.clipboard.writeText(fullToken); }
  document.getElementById("tok-msg").textContent = "Token copied — paste it into both Tampermonkey scripts (v5_token).";
}
async function changeToken(){
  const msg = document.getElementById("tok-msg");
  const v = document.getElementById("new-token").value.trim();
  if(v.length < 16){ msg.textContent = "The new token must be at least 16 characters."; return; }
  if(!confirm("Change the secret token? You must then put the SAME token in both Tampermonkey scripts (v5_token), or the scripts stop working.")) return;
  try{
    await api("/api/config/token", {method: "POST", body: JSON.stringify({new_token: v})});
    msg.innerHTML = '<span class="warn">Token changed. Now put this same token in both Tampermonkey scripts (v5_token) and restart the server.</span>';
    loadAll();
  }catch(e){ msg.textContent = "Could not change: " + e.message; }
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
        "watchlist": [
            {"tcin": t, "name": w["name"], "max_price": w["max_price"]}
            for t, w in WATCHLIST.items()
        ],
        "dedupe_window_seconds": DEDUPE_WINDOW_SECONDS,
        "alert_ttl_seconds": ALERT_TTL_SECONDS,
        "secret_token": SECRET_TOKEN,
    }

@app.post("/api/config/watchlist")
def add_watchlist(payload: WatchlistAddIn, request: Request):
    check_ui_token(request)
    global CONFIG
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
    CONFIG["watchlist"].append({"tcin": tcin, "name": name, "max_price": payload.max_price})
    save_config()
    sync_watchlist_from_config()
    logger.info("dashboard: added watchlist %s %s max $%s", tcin, name, payload.max_price)
    return {"ok": True, "watchlist": CONFIG["watchlist"]}

@app.delete("/api/config/watchlist/{tcin}")
def remove_watchlist(tcin: str, request: Request):
    check_ui_token(request)
    if tcin not in WATCHLIST:
        raise HTTPException(status_code=404, detail="That TCIN is not watched")
    CONFIG["watchlist"] = [w for w in CONFIG["watchlist"] if w["tcin"] != tcin]
    save_config()
    sync_watchlist_from_config()
    logger.info("dashboard: removed watchlist %s", tcin)
    return {"ok": True, "watchlist": CONFIG["watchlist"]}

@app.post("/api/config/settings")
def update_settings(payload: SettingsIn, request: Request):
    check_ui_token(request)
    global DEDUPE_WINDOW_SECONDS, ALERT_TTL_SECONDS
    DEDUPE_WINDOW_SECONDS = payload.dedupe_window_seconds
    ALERT_TTL_SECONDS = payload.alert_ttl_seconds
    CONFIG["dedupe_window_seconds"] = payload.dedupe_window_seconds
    CONFIG["alert_ttl_seconds"] = payload.alert_ttl_seconds
    save_config()
    logger.info("dashboard: settings dedupe=%s ttl=%s",
                DEDUPE_WINDOW_SECONDS, ALERT_TTL_SECONDS)
    return {"ok": True,
            "dedupe_window_seconds": DEDUPE_WINDOW_SECONDS,
            "alert_ttl_seconds": ALERT_TTL_SECONDS}

@app.post("/api/config/token")
def change_token(payload: TokenIn, request: Request):
    check_ui_token(request)
    global SECRET_TOKEN
    new = payload.new_token.strip()
    if len(new) < 16 or new.startswith("CHANGE-ME"):
        raise HTTPException(status_code=400,
                            detail="Token must be at least 16 characters")
    SECRET_TOKEN = new
    CONFIG["secret_token"] = new
    save_config()
    logger.info("dashboard: secret token changed (value not logged)")
    return {"ok": True,
            "warning": "Put this same token in both Tampermonkey scripts "
                       "(v5_token) and restart the server."}

if __name__ == "__main__":
    import uvicorn
    logger.info("v5 server starting on %s:%d (watchlist: %s)",
                HOST, PORT, ", ".join(WATCHLIST))
    logger.info("dashboard: open http://127.0.0.1:%d/ in a browser", PORT)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
