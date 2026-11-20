"""
Target Discord-Alert Server — Piece 1 of Auto-Buy v5 (williamesco, order FO31C2E00C185).

Receives Restockd Discord alerts (forwarded by the Tampermonkey Discord
Receiver running in the buyer's own browser tab), matches them against the
watchlist in config.json, dedupes them, and queues them for the Tampermonkey
Auto-Buy v5 script running on target.com.

- Binds to 127.0.0.1 ONLY. Never expose this to the internet.
- This server NEVER talks to Target or Discord itself.
- It does not promise a purchase. A queued alert only means "a watched
  product was alerted" — the buy flow can still lose to a 2-minute stock
  window, a manual Press & Hold challenge, or Target's own limits.

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
import sqlite3
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
DB_PATH = BASE_DIR / "alerts.db"
LOG_PATH = BASE_DIR / "server.log"

# ---------------------------------------------------------------- config
with open(CONFIG_PATH, encoding="utf-8") as f:
    CONFIG = json.load(f)

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

if __name__ == "__main__":
    import uvicorn
    logger.info("v5 server starting on %s:%d (watchlist: %s)",
                HOST, PORT, ", ".join(WATCHLIST))
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
