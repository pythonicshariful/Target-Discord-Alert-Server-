// ==UserScript==
// @name         Target Discord Receiver v5 (Restockd Alerts)
// @namespace    https://pythonicshariful.tech/
// @version      5.0.0
// @description  Reads Restockd restock alerts in the buyer's own Discord tab (#pokemon-target) and forwards them to the local v5 server (http://127.0.0.1:5000). No self-bot, no user-token login — it only reads what the buyer's own logged-in Discord tab already shows. Filtering (watchlist / price cap / dedupe) happens server-side.
// @author       Shariful Islam (pythonicshariful)
// @match        https://discord.com/channels/*
// @match        https://discord.com/app
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Target Discord Receiver v5 — Piece 2 of Auto-Buy v5 (order FO31C2E00C185)
 *
 * HOW IT WORKS
 *   1. The buyer keeps Discord open in a Chrome tab on the Restockd
 *      #pokemon-target channel. This script watches that tab.
 *   2. When Restockd APP posts an embed (Title / Price / Qty / Retailer /
 *      "Open product" link), the script parses it by its VISIBLE labels
 *      (not by Discord's hashed CSS class names) and POSTs the raw alert
 *      to the local server. The server decides watched / ignored.
 *   3. If the server is down, the alert is retried 3x, then kept in a
 *      retry queue and retried every 30s. The panel turns red.
 *
 * WHAT IT DOES NOT DO
 *   - No Discord self-bot / user-token API login (that violates Discord's
 *     ToS and risks an account ban). If this tab is closed or the PC
 *     sleeps, no alerts are received — there is no background magic.
 *   - No filtering by product here. Every Restockd/Target alert is sent;
 *     the server's watchlist (config.json) is the only filter.
 *   - It never buys anything. Buying is Piece 3's job.
 *
 * SETTINGS (Tampermonkey dashboard > this script > Settings, or the panel):
 *   v5_server_url : http://127.0.0.1:5000   (the local server)
 *   v5_token      : must match server/config.json secret_token
 *
 * No purchase is promised by this script. A forwarded alert only means
 * "Restockd posted about a product" — stock can still be gone by the
 * time the buyer script acts.
 */

(function () {
    'use strict';

    var SERVER_URL = (typeof GM_getValue === 'function' ? GM_getValue('v5_server_url', 'http://127.0.0.1:5000') : 'http://127.0.0.1:5000').replace(/\/$/, '');
    var TOKEN = typeof GM_getValue === 'function' ? GM_getValue('v5_token', 'CHANGE-ME-replace-with-a-long-random-string') : 'CHANGE-ME-replace-with-a-long-random-string';
    var SCAN_INTERVAL_MS = 2000;
    var POST_RETRIES = 3;
    var POST_RETRY_DELAY_MS = 1000;
    var RETRY_QUEUE_INTERVAL_MS = 30000;

    var sentCount = 0, queuedCount = 0, failedCount = 0;
    var serverOnline = null; // null = unknown, true/false = last check
    var lastAlertTitle = '—';
    var lastAlertTime = '—';
    var processedIds = new Set();
    var retryQueue = []; // alerts that failed all POST retries
    var panelEls = {};

    function log() {
        var args = ['[V5 Receiver]'].concat(Array.prototype.slice.call(arguments));
        console.log.apply(console, args);
    }

    // ------------------------------------------------------------ panel
    function buildPanel() {
        var div = document.createElement('div');
        div.id = 'v5-receiver-panel';
        div.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:#111827;color:#f9fafb;'
            + 'font:12px/1.5 system-ui,sans-serif;padding:10px 12px;border-radius:8px;border:1px solid #374151;'
            + 'box-shadow:0 4px 16px rgba(0,0,0,.5);max-width:280px;';
        div.innerHTML =
            '<div style="font-weight:700;margin-bottom:4px;">🎯 V5 Discord Receiver</div>' +
            '<div>Server: <span id="v5-rx-server">… checking …</span></div>' +
            '<div>Sent: <span id="v5-rx-sent">0</span> &nbsp; Queued by server: <span id="v5-rx-queued">0</span> &nbsp; Failed: <span id="v5-rx-failed">0</span></div>' +
            '<div>Retry queue: <span id="v5-rx-retry">0</span></div>' +
            '<div style="color:#9ca3af;word-break:break-word;">Last alert: <span id="v5-rx-last">—</span></div>' +
            '<div style="color:#9ca3af;font-size:11px;margin-top:4px;">Keep this #pokemon-target tab open. Alerts are forwarded to the local v5 server only.</div>';
        document.body.appendChild(div);
        panelEls.server = div.querySelector('#v5-rx-server');
        panelEls.sent = div.querySelector('#v5-rx-sent');
        panelEls.queued = div.querySelector('#v5-rx-queued');
        panelEls.failed = div.querySelector('#v5-rx-failed');
        panelEls.retry = div.querySelector('#v5-rx-retry');
        panelEls.last = div.querySelector('#v5-rx-last');
    }

    function updatePanel() {
        if (!panelEls.server) return;
        panelEls.server.textContent = serverOnline === null ? '… checking …' : (serverOnline ? '🟢 connected' : '🔴 OFFLINE — alerts NOT queued');
        panelEls.server.style.color = serverOnline ? '#4ade80' : '#f87171';
        panelEls.sent.textContent = String(sentCount);
        panelEls.queued.textContent = String(queuedCount);
        panelEls.failed.textContent = String(failedCount);
        panelEls.retry.textContent = String(retryQueue.length);
        panelEls.last.textContent = lastAlertTitle + (lastAlertTime !== '—' ? ' (' + lastAlertTime + ')' : '');
        var panel = document.getElementById('v5-receiver-panel');
        if (panel) panel.style.borderColor = serverOnline === false ? '#ef4444' : '#374151';
    }

    function flashAlert(title) {
        var panel = document.getElementById('v5-receiver-panel');
        if (panel) {
            panel.style.background = '#14532d';
            setTimeout(function () { panel.style.background = '#111827'; }, 1200);
        }
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({ title: 'V5: restock alert forwarded', text: title, timeout: 8000 });
            }
        } catch (e) { /* notifications are best-effort */ }
    }

    // ------------------------------------------------------------ parsing
    // Parse by VISIBLE labels, not CSS classes (Discord hashes its classes).
    // A Restockd embed looks like (from the Nov 13 2026 samples):
    //   "Pokémon Trading Card Game: Unova Hea… | Target"
    //   Price $79.99 | Qty Pre-Order | Retailer Target
    //   "Open product" link -> https://www.target.com/p/.../A-<TCIN>
    function parseEmbedText(text) {
        var out = { title: null, price: null, qty: null, retailer: null };
        var lines = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (/^price$/i.test(line) && lines[i + 1]) {
                var m = lines[i + 1].match(/\$?\s*([\d,]+\.\d{2})/);
                if (m) out.price = parseFloat(m[1].replace(/,/g, ''));
            } else if (/^qty$/i.test(line) && lines[i + 1]) {
                out.qty = lines[i + 1];
            } else if (/^retailer$/i.test(line) && lines[i + 1]) {
                out.retailer = lines[i + 1];
            }
        }
        // Fallbacks when labels/values run together on one line.
        if (out.price === null) {
            var pm = text.match(/Price\s*\$?\s*([\d,]+\.\d{2})/i);
            if (pm) out.price = parseFloat(pm[1].replace(/,/g, ''));
        }
        if (!out.qty) {
            var qm = text.match(/Qty\s*(Pre-Order|In Stock|Out of Stock|[^\n]{1,40})/i);
            if (qm) out.qty = qm[1].trim();
        }
        if (!out.retailer) {
            var rm = text.match(/Retailer\s*([A-Za-z ]+)/i);
            if (rm) out.retailer = rm[1].trim();
        }
        return out;
    }

    function findOpenProductLink(root) {
        var links = root.querySelectorAll('a[href*="target.com"]');
        for (var i = 0; i < links.length; i++) {
            var a = links[i];
            var txt = (a.textContent || '').trim().toLowerCase();
            var href = a.getAttribute('href') || '';
            // "Open product" is the Restockd product link. Ignore iOS/Android/
            // Ebay/TCGplayer links (they do not point at target.com anyway).
            if (txt.indexOf('open product') !== -1 || /\/p\//.test(href)) return a;
        }
        return null;
    }

    function findTitle(root, link) {
        // The embed title is the link whose text ends in "| Target".
        var links = root.querySelectorAll('a');
        for (var i = 0; i < links.length; i++) {
            var t = (links[i].textContent || '').trim();
            if (/\|\s*Target\s*$/.test(t)) return t;
        }
        if (link) {
            var t2 = (link.getAttribute('aria-label') || link.title || '').trim();
            if (t2) return t2;
        }
        return null;
    }

    function messageIdOf(node) {
        var id = node.getAttribute('data-list-item-id') || node.id || '';
        var m = id.match(/(\d{17,20})/);
        if (m) return 'discord-' + m[1];
        // Fallback: stable hash of the message text (same message re-rendered
        // by Discord must not be sent twice).
        var txt = (node.textContent || '').slice(0, 400);
        var h = 0;
        for (var i = 0; i < txt.length; i++) { h = ((h << 5) - h + txt.charCodeAt(i)) | 0; }
        return 'hash-' + h;
    }

    function messageNodes() {
        // Discord renders each chat message with data-list-item-id="chat-messages-<channel>-<id>".
        var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-list-item-id*="chat-messages-"]'));
        if (nodes.length) return nodes;
        // Fallback: any element that mentions the Restockd footer.
        return Array.prototype.slice.call(document.querySelectorAll('main [class*="message"]'));
    }

    function scanOnce() {
        var nodes = messageNodes();
        nodes.forEach(function (node) {
            var mid = messageIdOf(node);
            if (processedIds.has(mid)) return;
            var text = node.textContent || '';
            // Only Restockd APP messages, and only ones that look like a
            // product alert (embed with a Target link + a Price line).
            if (text.indexOf('Restockd') === -1) return;
            var link = findOpenProductLink(node);
            if (!link) return;
            var parsed = parseEmbedText(text);
            if (parsed.retailer && !/target/i.test(parsed.retailer)) return;
            if (parsed.price === null) return; // not a product alert (or unparsable — log it below instead)
            processedIds.add(mid);
            if (processedIds.size > 500) {
                var first = processedIds.values().next().value;
                processedIds.delete(first);
            }
            var title = findTitle(node, link) || '(untitled Restockd alert)';
            var alert = {
                source: 'restockd-discord',
                title: title,
                price: parsed.price,
                qty: parsed.qty,
                retailer: parsed.retailer || 'Target',
                url: link.getAttribute('href'),
                discord_time: (node.querySelector('time') || {}).getAttribute ? (node.querySelector('time').getAttribute('datetime') || null) : null,
                message_id: mid
            };
            log('Restockd alert found:', title, 'price=$' + parsed.price, alert.url);
            sendAlert(alert, 0);
        });
    }

    // ------------------------------------------------------------ server POST
    function postAlert(alert, attempt, onDone) {
        var payload = Object.assign({ token: TOKEN }, alert);
        var done = function (ok, resp) {
            if (ok) {
                serverOnline = true;
                sentCount++;
                if (resp && resp.status === 'queued') queuedCount++;
                lastAlertTitle = alert.title || '—';
                lastAlertTime = new Date().toLocaleTimeString();
                updatePanel();
                flashAlert(alert.title || 'Restockd alert');
                log('Alert forwarded, server says:', JSON.stringify(resp));
                if (onDone) onDone(true);
            } else if (attempt + 1 < POST_RETRIES) {
                setTimeout(function () { postAlert(alert, attempt + 1, onDone); }, POST_RETRY_DELAY_MS);
            } else {
                serverOnline = false;
                failedCount++;
                retryQueue.push(alert);
                updatePanel();
                log('ERROR: server unreachable after ' + POST_RETRIES + ' tries — alert kept in retry queue:', alert.title);
                if (onDone) onDone(false);
            }
        };
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: SERVER_URL + '/alert',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                timeout: 8000,
                onload: function (res) {
                    var resp = null;
                    try { resp = JSON.parse(res.responseText); } catch (e) { /* keep null */ }
                    done(res.status >= 200 && res.status < 300, resp);
                },
                onerror: function () { done(false, null); },
                ontimeout: function () { done(false, null); }
            });
        } catch (e) {
            done(false, null);
        }
    }

    function sendAlert(alert, attempt) { postAlert(alert, attempt); }

    function flushRetryQueue() {
        if (!retryQueue.length) return;
        var pending = retryQueue.slice();
        retryQueue = [];
        pending.forEach(function (alert) { postAlert(alert, 0); });
        updatePanel();
    }

    function checkServer() {
        try {
            GM_xmlhttpRequest({
                method: 'GET', url: SERVER_URL + '/status', timeout: 5000,
                onload: function (res) {
                    serverOnline = res.status >= 200 && res.status < 300;
                    updatePanel();
                },
                onerror: function () { serverOnline = false; updatePanel(); },
                ontimeout: function () { serverOnline = false; updatePanel(); }
            });
        } catch (e) { serverOnline = false; updatePanel(); }
    }

    // ------------------------------------------------------------ boot
    function boot() {
        buildPanel();
        updatePanel();
        checkServer();
        setInterval(checkServer, 10000);
        setInterval(flushRetryQueue, RETRY_QUEUE_INTERVAL_MS);
        // MutationObserver for new messages + a 2s scan as backup (Discord
        // re-renders the list, so the observer alone is not reliable).
        var list = document.querySelector('main') || document.body;
        try {
            var obs = new MutationObserver(function () { scanOnce(); });
            obs.observe(list, { childList: true, subtree: true });
        } catch (e) { log('MutationObserver unavailable, using interval scan only'); }
        setInterval(scanOnce, SCAN_INTERVAL_MS);
        scanOnce();
        log('V5 Receiver running. Server: ' + SERVER_URL + ' — watching for Restockd alerts.');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    // Test hook (used by the jsdom harness in tests/ — harmless in production).
    window.__v5receiver = {
        parseEmbedText: parseEmbedText,
        findOpenProductLink: findOpenProductLink,
        findTitle: findTitle,
        messageIdOf: messageIdOf,
        scanOnce: scanOnce,
        retryQueue: retryQueue,
        get serverOnline() { return serverOnline; }
    };
})();
