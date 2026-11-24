// ==UserScript==
// @name         Target Auto Buyer v5 (Discord Alert)
// @namespace    https://pythonicshariful.tech/
// @version      5.4.2
// @description  Watches the local v5 server for Discord restock alerts and buys the alerted product (TCIN-verified, quantity 1). Runs on ANY target.com page — when an alert arrives it opens that product's page itself and starts the purchase. Buy mode comes from the server dashboard: "Selected products" (watchlist + max price) or "Any product" (any product, any price). While waiting it makes ZERO requests to Target. Separate file — the v4.4 script is not edited or imported.
// @author       Shariful Islam (pythonicshariful)
// @match        https://www.target.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      127.0.0.1
// @connect      redsky.target.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Target Auto Buyer v5 — Piece 3 of Auto-Buy v5
 *
 * TWO MODES
 *   IDLE  — polls the LOCAL server (GET /next-any) every ~750ms. No
 *           Redsky calls, no page reloads, no Target requests at all.
 *           Runs on ANY target.com page (homepage, search, any product
 *           page) — the tab does not need to be on the alerted product.
 *   ARMED — a Discord alert arrived. Claims the alert (so a second
 *           profile cannot buy the same alert), opens the alerted
 *           product's page if this tab is not already on it, checks for
 *           a PerimeterX challenge FIRST, verifies stock once, then runs
 *           the exact-product buy flow.
 *
 * SAFETY RULES (copied from v4.4 into this file — v4.4 is NOT imported
 * or modified; disable v4.4 on any profile where v5 runs, so the two
 * scripts never fight over the same button)
 *   - Exact-TCIN-only clicks. Buttons in "Find alternative" / "Compare
 *     similar items" / "Guests also viewed" / any recommendation carousel
 *     are hard-blocked, as is any button carrying a different data-tcin.
 *   - Click-time re-verification: the button is re-checked immediately
 *     before every click.
 *   - Cart-drawer buttons are searched ONLY inside a visible dialog that
 *     belongs to this TCIN — never page-wide.
 *   - Price-cap guard (Selected-products mode only): never buy above
 *     the watchlist max price. In "Any product" mode (picked in the
 *     server dashboard) there is NO price cap — any product, any price.
 *   - Quantity is always 1. One alert = one purchase attempt max.
 *   - Place Order is clicked at most ONCE, only after the cart is checked
 *     to contain only the expected TCIN. Uncheck "Auto place order" in the
 *     panel to stop before payment instead (the script will alert you).
 *
 * PERIMETERX PRESS & HOLD — NEVER AUTO-SOLVED. If a challenge appears at
 * any point, the script PAUSES, sounds an alert, waits for YOU to solve
 * it by hand, re-checks every 1.5s, and resumes afterwards. This check
 * runs in the ARMED flow before the stock check, before the click, and
 * in the checkout loop — the check v4.4's pollStock() was missing.
 * (Synthetic mouse events are isTrusted=false and cannot reliably pass;
 *  auto-solving was considered and declined on 2026-11-15.)
 *
 * WATCHLIST (the server dashboard is the source of truth; this copy is
 * only a fallback if the server cannot be reached):
 *   1011407490  Booster Bundle Box    max $31.99
 *   1010892070  Knock Out Collection  max $11.99
 * The $79.99 Unova product from the sample screenshots is a SAMPLE ONLY
 * and is NOT in this list.
 * In "Any product" mode (dashboard) the watchlist is ignored entirely:
 * every alerted Target product is bought, at any price.
 *
 * No purchase is promised. A 2-minute stock window, a manual challenge
 * solve, or Target's own limits can still beat this script.
 */

(function () {
    'use strict';

    // ------------------------------------------------------------ config
    // No token (v5.3.0): install the script, start the server, done.
    var SERVER_URL = (typeof GM_getValue === 'function' ? GM_getValue('v5_server_url', 'http://127.0.0.1:5000') : 'http://127.0.0.1:5000').replace(/\/$/, '');
    var WATCHLIST = {
        '1011407490': { name: 'Booster Bundle Box', maxPrice: 31.99 },
        '1010892070': { name: 'Knock Out Collection', maxPrice: 11.99 }
    };
    var REDSKY_KEY = '9f36aeafbe60771e321a7cc95a78140772ab3e96'; // same public key v4.4 uses
    var BUYABLE_STATUSES = new Set([
        'IN_STOCK', 'LIMITED_STOCK', 'PRE_ORDER_SELLABLE', 'PRE_ORDER',
        'AVAILABLE', 'HAS_STOCK'
    ]);
    var IDLE_POLL_MS = 750;
    var ATC_MAX_RETRIES = 3;
    var CART_CONFIRM_TIMEOUT_MS = 20000;

    var state = {
        mode: 'IDLE',           // IDLE | ARMED | PAUSED | DONE | FAILED
        running: true,
        alert: null,            // current claimed alert object
        serverOnline: null,
        serverMode: 'selected', // buy mode from the server dashboard: 'selected' | 'any'
        serverWatchlist: null,  // {tcin: {name, maxPrice}} from /status, null until first check
        lastAlertAt: null,
        lastAction: '',
        atcRetries: 0,
        placeOrderAttempted: false,
        challengeNotified: false,
        logLines: []
    };

    // ------------------------------------------------------------ utils
    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
    function xpath(path, root) {
        try {
            return document.evaluate(path, root || document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        } catch (e) { return null; }
    }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function isVisible(el) {
        if (!el) return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }
    function isDisabled(el) {
        if (!el) return true;
        if (el.disabled) return true;
        if ((el.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return true;
        return /\.disabled$/i.test(el.id || '');
    }
    function setNativeValue(el, value) {
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (setter && setter.set) setter.set.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function extractTcin(url) {
        var m = (url || window.location.href).match(/A-(\d+)/);
        return m ? m[1] : null;
    }
    function getTabTcin() {
        return extractTcin();
    }

    // v5.4.2: real Restockd links go through a howl.link tracking redirect.
    // The Receiver and the server unwrap it, but defend here too — if an
    // old Receiver ever hands this script a howl URL, navigate to the real
    // product URL instead of the redirect (slower, and ad-blockers often
    // block howl.link outright).
    function unwrapRedirectUrl(href) {
        if (!href) return href;
        try {
            var u = new URL(href);
            var inner = u.searchParams.get('url');
            if (!inner) return href;
            for (var i = 0; i < 2; i++) {
                try { inner = decodeURIComponent(inner); } catch (e) { break; }
            }
            if (inner.indexOf('target.com') !== -1) return inner;
        } catch (e) { /* not a parseable URL — pass through */ }
        return href;
    }
    function isWatched(tcin) {
        if (state.serverMode === 'any') return true; // any product counts
        if (WATCHLIST[tcin]) return true;
        return !!(state.serverWatchlist && state.serverWatchlist[tcin]);
    }
    function getMaxPrice(tcin) {
        if (state.serverMode === 'any') return 0; // no cap in Any-product mode
        tcin = tcin || getTabTcin();
        var w = (state.serverWatchlist && state.serverWatchlist[tcin]) || WATCHLIST[tcin];
        return w ? w.maxPrice : 0;
    }
    function getProductName(tcin) {
        var w = (state.serverWatchlist && state.serverWatchlist[tcin]) || WATCHLIST[tcin];
        return w ? w.name : (state.serverMode === 'any' ? 'Any product' : 'not in watchlist');
    }
    function getStoredCvv() {
        try { return (typeof GM_getValue === 'function' ? GM_getValue('v5_cvv', '') : '') || ''; } catch (e) { return ''; }
    }
    function autoPlaceOrderEnabled() {
        try { return GM_getValue('v5_autoPlaceOrder', true) !== false; } catch (e) { return true; }
    }

    function beep(times) {
        try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var n = times || 3;
            for (var i = 0; i < n; i++) {
                (function (i) {
                    setTimeout(function () {
                        var o = ctx.createOscillator(), g = ctx.createGain();
                        o.connect(g); g.connect(ctx.destination);
                        o.frequency.value = 880; o.start();
                        g.gain.setValueAtTime(0.2, ctx.currentTime);
                        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
                        o.stop(ctx.currentTime + 0.3);
                    }, i * 350);
                })(i);
            }
        } catch (e) { /* sound is best-effort */ }
    }

    function log(msg) {
        var line = new Date().toLocaleTimeString() + ' ' + msg;
        console.log('[V5 Buyer] ' + msg);
        state.logLines.push(line);
        if (state.logLines.length > 100) state.logLines.shift();
        state.lastAction = msg;
        renderPanel();
    }

    function httpRequest(options) {
        return new Promise(function (resolve, reject) {
            var gmXhr = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest :
                (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest : null;
            if (gmXhr) {
                gmXhr({
                    method: options.method || 'GET',
                    url: options.url,
                    headers: options.headers || {},
                    data: options.data,
                    timeout: options.timeout || 10000,
                    onload: function (res) { resolve(res.responseText); },
                    onerror: function (e) { reject(new Error('GM request failed')); },
                    ontimeout: function () { reject(new Error('GM request timeout')); }
                });
            } else {
                fetch(options.url, { method: options.method || 'GET', headers: options.headers || {} })
                    .then(function (r) { return r.text(); })
                    .then(resolve, reject);
            }
        });
    }

    // ------------------------------------------------------------ panel
    var panelEls = {};
    function buildPanel() {
        if (document.getElementById('v5-buyer-panel')) return;
        var div = document.createElement('div');
        div.id = 'v5-buyer-panel';
        div.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99999;background:#111827;color:#f9fafb;'
            + 'font:12px/1.5 system-ui,sans-serif;padding:12px;border-radius:8px;border:1px solid #374151;'
            + 'box-shadow:0 4px 16px rgba(0,0,0,.5);width:300px;';
        div.innerHTML =
            '<div style="font-weight:700;">🎯 Target Auto-Buy v5 <span style="color:#9ca3af;font-weight:400;">(Discord alerts)</span></div>' +
            '<div>Mode: <b id="v5-mode">IDLE</b> &nbsp; Server: <span id="v5-server">…</span></div>' +
            '<div>Product: <span id="v5-tcin">—</span> &nbsp; Max: $<span id="v5-max">—</span></div>' +
            '<div>Last alert: <span id="v5-last-alert">—</span></div>' +
            '<div style="color:#9ca3af;">Last action: <span id="v5-last-action">—</span></div>' +
            '<label style="display:block;margin-top:6px;"><input type="checkbox" id="v5-auto-place" checked> Auto place order (uncheck to stop before payment)</label>' +
            '<label style="display:block;margin-top:4px;">CVV: <input type="password" id="v5-cvv" placeholder="saved payment CVV" style="width:70px;background:#1f2937;color:#fff;border:1px solid #4b5563;border-radius:4px;padding:2px 4px;"></label>' +
            '<div style="margin-top:8px;">' +
            '<button id="v5-btn-test" style="margin-right:4px;">Test server</button>' +
            '<button id="v5-btn-sim" style="margin-right:4px;" title="TEST ONLY: posts a test alert for this product to the server">Simulate alert (test)</button>' +
            '<button id="v5-btn-stop">Stop</button></div>' +
            '<pre id="v5-log" style="margin:8px 0 0;max-height:120px;overflow:auto;background:#0b1220;color:#a5f3fc;font-size:11px;padding:6px;border-radius:4px;white-space:pre-wrap;"></pre>' +
            '<div style="color:#9ca3af;font-size:11px;margin-top:4px;">IDLE = no Target requests at all. When an alert arrives, this tab opens the product page itself. A Press &amp; Hold challenge pauses the bot for a MANUAL solve — it is never auto-solved.</div>';
        document.body.appendChild(div);
        panelEls.mode = div.querySelector('#v5-mode');
        panelEls.server = div.querySelector('#v5-server');
        panelEls.tcin = div.querySelector('#v5-tcin');
        panelEls.max = div.querySelector('#v5-max');
        panelEls.lastAlert = div.querySelector('#v5-last-alert');
        panelEls.lastAction = div.querySelector('#v5-last-action');
        panelEls.log = div.querySelector('#v5-log');
        var autoPlace = div.querySelector('#v5-auto-place');
        autoPlace.checked = autoPlaceOrderEnabled();
        autoPlace.addEventListener('change', function () {
            try { GM_setValue('v5_autoPlaceOrder', autoPlace.checked); } catch (e) {}
            log('Auto place order ' + (autoPlace.checked ? 'ON' : 'OFF — will stop before payment'));
        });
        var cvvInput = div.querySelector('#v5-cvv');
        cvvInput.value = getStoredCvv();
        cvvInput.addEventListener('change', function () {
            try { GM_setValue('v5_cvv', cvvInput.value); } catch (e) {}
            log('CVV saved in this browser profile only (never sent anywhere except Target checkout).');
        });
        div.querySelector('#v5-btn-test').addEventListener('click', function () { testServer(true); });
        div.querySelector('#v5-btn-sim').addEventListener('click', simulateAlert);
        div.querySelector('#v5-btn-stop').addEventListener('click', function () {
            state.running = !state.running;
            try { GM_setValue('v5_running', state.running); } catch (e) {}
            this.textContent = state.running ? 'Stop' : 'Start';
            log(state.running ? 'Bot resumed by user.' : 'Bot STOPPED by user. No further action will be taken.');
            if (state.running && state.mode === 'IDLE') idleLoop();
        });
        try { state.running = GM_getValue('v5_running', true) !== false; } catch (e) {}
        if (!state.running) div.querySelector('#v5-btn-stop').textContent = 'Start';
    }

    function renderPanel() {
        if (!panelEls.mode) return;
        panelEls.mode.textContent = state.mode;
        panelEls.mode.style.color = state.mode === 'ARMED' ? '#facc15' : state.mode === 'PAUSED' ? '#f87171' : state.mode === 'DONE' ? '#4ade80' : state.mode === 'FAILED' ? '#f87171' : '#e5e7eb';
        panelEls.server.textContent = state.serverOnline === null ? '… checking …' : (state.serverOnline ? '🟢 connected' : '🔴 OFFLINE');
        panelEls.server.style.color = state.serverOnline ? '#4ade80' : '#f87171';
        var tcin = getTabTcin();
        panelEls.tcin.textContent = tcin ? tcin + ' (' + getProductName(tcin) + ')' : '— (not a product page)';
        panelEls.max.textContent = state.serverMode === 'any' ? 'Any' : (tcin && getMaxPrice(tcin) > 0 ? getMaxPrice(tcin).toFixed(2) : '—');
        panelEls.lastAlert.textContent = state.lastAlertAt ? new Date(state.lastAlertAt).toLocaleTimeString() + ' — ' + (state.alert ? state.alert.title : '') : '—';
        panelEls.lastAction.textContent = state.lastAction || '—';
        panelEls.log.textContent = state.logLines.slice(-8).join('\n');
        var panel = document.getElementById('v5-buyer-panel');
        if (panel) panel.style.borderColor = state.mode === 'PAUSED' ? '#ef4444' : '#374151';
    }

    function setMode(mode) { state.mode = mode; renderPanel(); }

    // ------------------------------------------------- blocked sections (from v4.4)
    // NEVER click: "Find alternative", "Compare similar items",
    // "Guests also viewed" and every other recommendation area.
    var BLOCKED_SECTION_RE = /alternative|compare similar|guests also viewed|also viewed|similar items|shop similar|more to consider|you may also like|recommend/i;
    function isInBlockedSection(el) {
        if (!el || !el.closest) return false;
        var attrSel = [
            '[data-test*="alternative" i]', '[data-test*="compare" i]',
            '[data-test*="also-viewed" i]', '[data-test*="alsoViewed" i]',
            '[aria-label*="alternative" i]', '[aria-label*="compare similar" i]',
            '[aria-label*="also viewed" i]', '[aria-label*="similar items" i]'
        ].join(',');
        if (el.closest(attrSel)) return true;
        var tcin = getTabTcin();
        var node = el;
        for (var depth = 0; node && depth < 14; depth++, node = node.parentElement) {
            var dt = node.getAttribute && node.getAttribute('data-tcin');
            if (dt && tcin && dt !== tcin) return true;
            if (depth >= 1 && node.querySelector) {
                var hasH1 = node.querySelector('h1[data-test="product-title"], h1');
                if (!hasH1) {
                    var h = node.querySelector('h2, h3');
                    if (h && BLOCKED_SECTION_RE.test((h.textContent || '').trim())) return true;
                }
            }
        }
        return false;
    }

    function isImpostorOrCarouselElement(el, targetTcin) {
        if (!el) return true;
        var tcin = targetTcin || getTabTcin();
        if (isInBlockedSection(el)) return true;
        if (el.closest('#v5-buyer-panel')) return true;
        var elId = el.id || '';
        if (elId.indexOf('addToCartButtonOrTextIdFor') === 0) {
            if (tcin && elId.indexOf(tcin) === -1) return true; // another product's button
        }
        var badContainers = [
            '[data-test*="recommendation" i]', '[data-test*="carousel" i]',
            '[data-test*="ProductCard" i]', '[data-test*="product-card" i]',
            '[data-test*="frequently-bought" i]', '[data-test*="similar" i]',
            '[data-test*="sponsored" i]', '[data-test*="related" i]',
            '[data-test*="people-also" i]', '[data-test*="drawer-recommendations" i]',
            '[data-test*="alternative" i]', '[data-test*="compare" i]',
            'section[aria-label*="alternative" i]', 'section[aria-label*="compare similar" i]',
            'section[aria-label*="also viewed" i]', 'section[aria-label*="recommend" i]',
            'section[aria-label*="similar" i]', 'section[aria-label*="frequently bought" i]',
            'section[aria-label*="you might also like" i]', 'section[aria-label*="more to consider" i]',
            'section[aria-label*="customers also" i]', 'section[aria-label*="sponsored" i]',
            'section[aria-label*="carousel" i]', 'div[data-component="Carousel"]',
            'div[data-component="ProductCard"]', 'li[data-test*="carousel" i]',
            'ul[data-test*="carousel" i]', '[data-test="choose-options-drawer"]'
        ];
        if (el.closest(badContainers.join(','))) return true;
        return false;
    }

    function getMainBuyBox() {
        return $('[data-test="pdp-top-of-funnel"]') ||
            $('[data-test="product-summary"]') ||
            $('[data-test="fulfillment-section"]') ||
            $('div[data-component="ProductDetail"]') ||
            $('[data-test="product-detail-highlights"]')?.closest('main') ||
            $('main');
    }

    function dismissUnwantedDrawers() {
        var tcin = getTabTcin();
        var dialogs = $$('[role="dialog"], [aria-modal="true"]');
        for (var i = 0; i < dialogs.length; i++) {
            var drawer = dialogs[i];
            if (drawer.closest('#v5-buyer-panel') || !isVisible(drawer)) continue;
            var heading = $$('h1, h2, h3', drawer).find(function (h) {
                return (h.textContent || '').trim().toLowerCase().indexOf('choose options') === 0;
            });
            if (!heading) continue;
            var productLink = drawer.querySelector('a[href*="/p/"]');
            var drawerTcin = productLink ? extractTcin(productLink.href) : null;
            if (!drawerTcin || (tcin && drawerTcin === tcin)) continue;
            log('🛡️ Rogue "Choose options" drawer for TCIN ' + drawerTcin + ' — dismissing.');
            var closeBtn = drawer.querySelector('button[aria-label*="close" i], button[data-test="close-button"], button[data-test="modal-close-button"]');
            if (closeBtn) closeBtn.click();
        }
    }

    function getCurrentPrice() {
        var tcin = getTabTcin();
        var mainBuyBox = getMainBuyBox();
        var containers = [
            $('[data-test="product-price"]', mainBuyBox),
            $('[data-test="@web/Price/Large"]', mainBuyBox),
            $('div[data-test="product-price"]', mainBuyBox),
            $('span[data-test="product-price"]', mainBuyBox)
        ];
        var pc = null;
        for (var i = 0; i < containers.length; i++) {
            if (containers[i] && isVisible(containers[i]) && !isImpostorOrCarouselElement(containers[i], tcin)) { pc = containers[i]; break; }
        }
        if (!pc) return null;
        var rawText = ((pc.querySelector('span') || pc).textContent || pc.textContent || '').trim();
        var match = rawText.match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/);
        if (match) { var v = parseFloat(match[1].replace(/,/g, '')); return Number.isFinite(v) ? v : null; }
        return null;
    }

    // ------------------------------------------------- challenge (PerimeterX Press & Hold)
    // NEVER auto-solved. Pause + loud alert + wait for a MANUAL solve.
    // This check runs before the stock check, before the click, and inside
    // the checkout loop — the check v4.4's pollStock() was missing.
    function isBotChallengePresent() {
        var pxBox = document.getElementById('px-captcha') || document.querySelector('[data-test="px-captcha"]');
        if (pxBox && isVisible(pxBox) && pxBox.offsetHeight > 40) return true;
        var pressBtn = xpath("//button[not(ancestor::*[@id='v5-buyer-panel']) and (contains(., 'Press & hold') or contains(., 'Press and hold'))]");
        if (pressBtn && isVisible(pressBtn)) return true;
        var phrases = ['quick verification', 'press & hold to confirm you', 'press and hold to confirm',
            'sorry for the wait', 'verifying you are human', 'one moment please'];
        var els = Array.from(document.querySelectorAll('h1, h2, h3, p, div'));
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (document.getElementById('v5-buyer-panel') && document.getElementById('v5-buyer-panel').contains(el)) continue;
            var t = (el.textContent || '').toLowerCase();
            if (phrases.some(function (p) { return t.indexOf(p) !== -1; }) && isVisible(el)) return true;
        }
        return false;
    }

    function waitForChallengeClear() {
        // Resolves true when no challenge is present; waits indefinitely
        // for a manual solve (returns false only if the user stops the bot).
        return new Promise(function (resolve) {
            function check() {
                if (!state.running) return resolve(false);
                if (!isBotChallengePresent()) {
                    if (state.mode === 'PAUSED') {
                        log('✅ Challenge solved by hand. Resuming…');
                        setMode('ARMED');
                    }
                    state.challengeNotified = false;
                    return resolve(true);
                }
                if (state.mode !== 'PAUSED') {
                    setMode('PAUSED');
                    log('⚠️ Press & Hold / Quick verification detected — PAUSED. Solve it BY HAND, then the bot resumes on its own. (It is never auto-solved.)');
                    beep(5);
                    if (!state.challengeNotified) {
                        state.challengeNotified = true;
                        try { GM_notification({ title: 'V5: Press & Hold — solve it by hand', text: 'Target is asking for human verification. Solve it, the bot resumes automatically.', timeout: 15000 }); } catch (e) {}
                    }
                }
                renderPanel();
                setTimeout(check, 1500);
            }
            check();
        });
    }

    // ------------------------------------------------- Redsky stock check (from v4.4)
    var _storeIdCache = null;
    function getStoreId() {
        if (_storeIdCache) return _storeIdCache;
        try {
            var m = document.documentElement.innerHTML.match(/"(?:pricing_store_id|pricingStoreId|store_id)"\s*[:=]\s*"?(\d{2,5})"?/);
            if (m) { _storeIdCache = m[1]; return _storeIdCache; }
        } catch (e) {}
        _storeIdCache = '3991';
        return _storeIdCache;
    }

    function fetchRedskyJson(url) {
        return fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } })
            .then(function (r) { return r.text().then(function (txt) {
                if (r.status === 435 || /perimeterx|px-cdn/i.test(txt)) return { blocked: true, data: null };
                if (r.ok) { try { return { blocked: false, data: JSON.parse(txt) }; } catch (e) { return { blocked: false, data: null }; } }
                return { blocked: false, data: null };
            }); })
            .catch(function () {
                // GM transport fallback (carries the Tampermonkey session)
                return httpRequest({ method: 'GET', url: url, headers: { Accept: 'application/json' } })
                    .then(function (raw) {
                        if (/perimeterx|px-cdn/i.test(raw)) return { blocked: true, data: null };
                        try { return { blocked: false, data: JSON.parse(raw) }; } catch (e) { return { blocked: false, data: null }; }
                    })
                    .catch(function () { return { blocked: false, data: null }; });
            });
    }

    function scanRedskyPayload(data) {
        var statuses = [], price = null;
        var walk = function (node, depth) {
            if (!node || depth > 14) return;
            if (Array.isArray(node)) { node.forEach(function (n) { walk(n, depth + 1); }); return; }
            if (typeof node === 'object') {
                if (typeof node.availability_status === 'string') statuses.push(node.availability_status);
                if (price === null && typeof node.current_retail === 'number') price = node.current_retail;
                Object.values(node).forEach(function (v) { walk(v, depth + 1); });
            }
        };
        walk(data, 0);
        return { statuses: statuses, price: price };
    }

    function checkStockApiDetailed(tcin) {
        var storeId = getStoreId();
        var urls = [
            'https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1?key=' + REDSKY_KEY + '&channel=WEB&is_bot=false&tcin=' + tcin + '&page=%2Fp%2FA-' + tcin + '&pricing_store_id=' + storeId + '&store_id=' + storeId,
            'https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1?key=' + REDSKY_KEY + '&channel=WEB&is_bot=false&tcins=' + tcin + '&pricing_store_id=' + storeId + '&store_id=' + storeId + '&scheduled_delivery_store_id=' + storeId
        ];
        var sawBlocked = false;
        var chain = Promise.resolve(null);
        urls.forEach(function (url) {
            chain = chain.then(function (found) {
                if (found) return found;
                return fetchRedskyJson(url).then(function (res) {
                    if (res.blocked) { sawBlocked = true; return null; }
                    if (res.data) {
                        var scanned = scanRedskyPayload(res.data);
                        if (scanned.statuses.length) {
                            return { buyable: scanned.statuses.some(function (st) { return BUYABLE_STATUSES.has(st); }), blocked: false, statuses: scanned.statuses, price: scanned.price };
                        }
                    }
                    return null;
                });
            });
        });
        return chain.then(function (found) {
            return found || { buyable: false, blocked: sawBlocked, statuses: [], price: null };
        });
    }

    // ------------------------------------------------- Add-to-cart (from v4.4)
    function findATCButton() {
        var tcin = getTabTcin();
        if (tcin) {
            var specific = [
                'button#addToCartButtonOrTextIdFor' + tcin + ':not([disabled])',
                '#addToCartButtonOrTextIdFor' + tcin + ':not([disabled])'
            ];
            for (var i = 0; i < specific.length; i++) {
                var btn = $(specific[i]);
                if (btn && isVisible(btn) && !isDisabled(btn) && !isImpostorOrCarouselElement(btn, tcin)) return btn;
            }
        }
        // ONLY the main product's fulfillment section — the wider buy-box
        // contains the "Find alternative" carousel (verified live 2026-11-09).
        var mainBuyBox = getMainBuyBox();
        if (!mainBuyBox) return null;
        // NOTE: written as separate statements on purpose — a one-line
        // `A || B.closest ? C.closest('div') : null` parses the whole
        // `A || B.closest` as the ternary condition and throws when the
        // shipping cell is absent (bug found by test T6, 2026-11-20).
        var fulfillmentBox = $('[data-test="fulfillment-section"]', mainBuyBox) || null;
        if (!fulfillmentBox) {
            var shipCellEl = $('[data-test="fulfillment-cell-shipping"]', mainBuyBox);
            if (shipCellEl) fulfillmentBox = shipCellEl.closest('div');
        }
        var atcScope = fulfillmentBox || mainBuyBox;
        var shippingCell =
            $('button[data-test="fulfillment-cell-shipping"]:not([disabled])', mainBuyBox) ||
            $('input[type="radio"][value="SHIPPING"]', mainBuyBox);
        if (shippingCell && isVisible(shippingCell) && !isDisabled(shippingCell) && !isImpostorOrCarouselElement(shippingCell, tcin)) {
            var isSelected = shippingCell.getAttribute('aria-checked') === 'true' || shippingCell.classList.contains('selected') || shippingCell.checked;
            if (!isSelected) {
                var hasPending = $('button[data-test="shippingButton"], button[data-test="addToCartButton"]', mainBuyBox);
                if (hasPending) shippingCell.click();
            }
        }
        var candidates = [
            'button[data-test="shippingButton"]:not([disabled])',
            'button[data-test="shipItButton"]:not([disabled])',
            'button[data-test="orderPickupButton"]:not([disabled])',
            'button[data-test="addToCartButton"]:not([disabled])',
            'button[data-test="@web/Fulfillment/ShippingButton"]:not([disabled])'
        ];
        for (var s = 0; s < candidates.length; s++) {
            var btns = $$(candidates[s], atcScope);
            for (var b = 0; b < btns.length; b++) {
                if (btns[b] && isVisible(btns[b]) && !isDisabled(btns[b]) && !isImpostorOrCarouselElement(btns[b], tcin)) return btns[b];
            }
        }
        // Text buttons ONLY inside the fulfillment section. No fulfillment
        // section = fail safe, return null (never scan the whole buy-box).
        if (!fulfillmentBox) return null;
        var textButtons = $$('button:not([disabled])', fulfillmentBox);
        for (var t = 0; t < textButtons.length; t++) {
            var tb = textButtons[t];
            if (!isVisible(tb) || isDisabled(tb) || isImpostorOrCarouselElement(tb, tcin)) continue;
            var text = (tb.textContent || '').trim().toLowerCase();
            if (text === 'add to cart' || text === 'ship it' || text === 'preorder' || text === 'preorder now' ||
                text.indexOf('add to cart') === 0 || text.indexOf('preorder') === 0) return tb;
        }
        return null;
    }

    // ------------------------------------------------- server API (localhost only)
    // NOTE: this uses GM_xmlhttpRequest directly (not httpRequest) so that
    // non-2xx answers — e.g. 409 already_claimed — REJECT instead of
    // silently resolving. A claim conflict must stand the script down.
    function gmJson(method, url, data) {
        return new Promise(function (resolve, reject) {
            var gmXhr = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest :
                (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest : null;
            var done = function (status, text) {
                if (status >= 200 && status < 300) {
                    state.serverOnline = true; renderPanel();
                    try { resolve(JSON.parse(text || '{}')); } catch (e) { reject(new Error('bad JSON from server')); }
                } else {
                    var err = new Error('HTTP ' + status);
                    err.status = status;
                    try { err.body = JSON.parse(text || '{}'); } catch (e) {}
                    reject(err);
                }
            };
            if (gmXhr) {
                gmXhr({
                    method: method, url: url,
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    data: data ? JSON.stringify(data) : undefined,
                    timeout: 8000,
                    onload: function (res) { done(res.status, res.responseText); },
                    onerror: function () { state.serverOnline = false; renderPanel(); reject(new Error('server unreachable')); },
                    ontimeout: function () { state.serverOnline = false; renderPanel(); reject(new Error('server timeout')); }
                });
            } else {
                fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined })
                    .then(function (r) { return r.text().then(function (t) { done(r.status, t); }); })
                    .catch(function () { state.serverOnline = false; renderPanel(); reject(new Error('server unreachable')); });
            }
        });
    }
    function serverGet(path) {
        return gmJson('GET', SERVER_URL + path);
    }
    function serverPost(path, body) {
        return gmJson('POST', SERVER_URL + path, body);
    }
    function ackAlert(alertId, status, reason) {
        if (!alertId) return Promise.resolve(null);
        return serverPost('/ack', { alert_id: alertId, status: status, reason: reason })
            .catch(function (e) { log('⚠️ Could not ack alert ' + alertId + ' (' + status + '): ' + e.message); return null; });
    }
    function testServer(verbose) {
        return serverGet('/status').then(function (s) {
            state.serverOnline = true;
            state.serverMode = s.mode || 'selected';
            state.serverWatchlist = {};
            (s.watchlist || []).forEach(function (w) { state.serverWatchlist[w.tcin] = { name: w.name, maxPrice: w.max_price }; });
            renderPanel();
            log('✅ Server OK — mode: ' + state.serverMode + ' — watchlist: ' + s.watchlist.map(function (w) { return w.tcin + ' ($' + w.max_price + ')'; }).join(', ') + ', pending: ' + s.pending);
            if (verbose) beep(2);
            return true;
        }).catch(function () {
            state.serverOnline = false; renderPanel();
            log('🔴 Server OFFLINE — is start-server.bat running? The bot keeps waiting; it makes no Target requests while offline.');
            return false;
        });
    }
    function simulateAlert() {
        // TEST ONLY: posts a test alert for THIS tab's product to the server.
        // The script then picks it up and runs the real ARMED flow — on an
        // out-of-stock page that ends in failed:gone_before_buy and buys nothing.
        var tcin = getTabTcin();
        if (!tcin || !isWatched(tcin)) { log('⚠️ Simulate: this page is not a watched product (TCIN ' + (tcin || 'none') + '). Open a watched product page first — or switch the dashboard to Any-product mode.'); return; }
        var simPrice = getMaxPrice(tcin) > 0 ? getMaxPrice(tcin) : (getCurrentPrice() || 0);
        serverPost('/alert', {
            source: 'v5-test', title: '[TEST] Simulated alert — ' + getProductName(tcin),
            price: simPrice, qty: 'Test', retailer: 'Target',
            url: 'https://www.target.com/p/-/A-' + tcin, message_id: 'sim-' + Date.now()
        }).then(function (r) {
            log('🧪 Test alert posted: ' + JSON.stringify(r) + ' — the script will pick it up within ~1s.');
        }).catch(function () { log('🔴 Simulate failed — server offline.'); });
    }

    // ------------------------------------------------- cart + checkout
    function watchForCartConfirmation() {
        return new Promise(function (resolve) {
            var done = false;
            var finish = function (ok) { if (!done) { done = true; if (observer) observer.disconnect(); clearTimeout(timer); resolve(ok); } };
            var checkCart = function () {
                if (!state.running) return finish(false);
                dismissUnwantedDrawers();
                var currentTcin = state.alert ? state.alert.tcin : getTabTcin();
                // Fulfillment choice ONLY inside a visible dialog belonging to THIS product.
                var dialogs = $$('[role="dialog"], [aria-modal="true"], [data-test*="drawer" i], [data-test*="modal" i]')
                    .filter(function (d) { return isVisible(d) && !d.closest('#v5-buyer-panel') && !isInBlockedSection(d); });
                for (var i = 0; i < dialogs.length; i++) {
                    var dlg = dialogs[i];
                    var dlgLink = dlg.querySelector('a[href*="/p/"]');
                    var dlgTcin = dlgLink ? extractTcin(dlgLink.href) : null;
                    if (dlgTcin && currentTcin && dlgTcin !== currentTcin) continue;
                    var shipBtn =
                        $('button[data-test="fulfillment-cell-shipping"]:not([disabled])', dlg) ||
                        $('button[data-test="shipItButton"]:not([disabled])', dlg) ||
                        $('button[data-test="orderPickupButton"]:not([disabled])', dlg);
                    if (shipBtn && isVisible(shipBtn) && !isImpostorOrCarouselElement(shipBtn, currentTcin)) {
                        log('Selecting delivery/shipping option in drawer…');
                        shipBtn.click();
                    }
                }
                var declineBtn = xpath("//button[contains(text(),'Decline coverage') or contains(text(),'No thanks') or contains(text(),'Decline')]");
                if (declineBtn && isVisible(declineBtn)) { log('Declining protection plan…'); declineBtn.click(); }
                var viewCartBtn =
                    xpath("//a[contains(text(),'View cart')]") || xpath("//button[contains(text(),'View cart')]") ||
                    xpath("//a[contains(text(),'check out')]") || $('[data-test="view-cart-checkout"]');
                var picker = $('button[data-test="custom-quantity-picker"]');
                var addedHeading = xpath("//*[contains(text(),'Added to cart') or contains(text(),'added to your cart')]");
                if (viewCartBtn || (picker && (picker.innerText || '').toLowerCase().indexOf('in cart') !== -1) || addedHeading) {
                    log('✅ Cart confirmed — advancing to checkout…');
                    beep(2);
                    return finish(true);
                }
                return false;
            };
            if (checkCart()) return;
            var observer = new MutationObserver(checkCart);
            observer.observe(document.body, { childList: true, subtree: true });
            var timer = setTimeout(function () { log('⚠️ Cart confirmation timed out after ' + (CART_CONFIRM_TIMEOUT_MS / 1000) + 's.'); finish(false); }, CART_CONFIRM_TIMEOUT_MS);
        });
    }

    function clickATC(button) {
        state.atcRetries++;
        log('🛒 ATC click #' + state.atcRetries + '/' + ATC_MAX_RETRIES + ' (TCIN ' + getTabTcin() + ', re-verified at click time).');
        button.click();
        return watchForCartConfirmation().then(function (confirmed) {
            if (confirmed) {
                try { sessionStorage.setItem('v5_target_tcin', state.alert ? state.alert.tcin : getTabTcin()); } catch (e) {}
                log('→ Navigating to checkout…');
                window.location.href = 'https://www.target.com/checkout';
                return true;
            }
            if (state.atcRetries < ATC_MAX_RETRIES && state.running) {
                log('Cart confirmation timeout — retrying click…');
                var btn = findATCButton();
                if (btn) return clickATC(btn);
            }
            return false;
        });
    }

    function beginAddToCart(button) {
        // Click-time re-verification (v4.4 rule): refuse any button that is
        // an alternative / carousel / different-product button.
        if (!button || isImpostorOrCarouselElement(button, getTabTcin())) {
            log('🛡️ Blocked an ATC click that was NOT the main product button. Not clicking.');
            return Promise.resolve(false);
        }
        try { sessionStorage.setItem('v5_target_tcin', getTabTcin()); } catch (e) {}
        return clickATC(button);
    }

    function extractCartItemTcins() {
        var tcins = new Set();
        // ONLY real cart line items — a page-wide link scan would also pick
        // up "You may also like" carousels on the cart page.
        var items = $$('[data-test="cartItem"], [data-test="cart-item"], [data-test^="cartItem-"], [data-test^="cart-item-"]')
            .filter(function (el) { return !el.closest('[data-test*="recommendation" i], [data-test*="carousel" i], section[aria-label*="recommend" i], section[aria-label*="also like" i]'); });
        items.forEach(function (item) {
            var link = item.querySelector('a[href*="/p/"]');
            if (link) { var t = extractTcin(link.href); if (t) tcins.add(t); }
        });
        return tcins;
    }

    function hasOrderConfirmation() {
        var el = $('[data-test="orderConfirmation"], [data-test="order-confirmation"]');
        if (el && isVisible(el)) return true;
        var heading = xpath("//*[self::h1 or self::h2][contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'thank you for your order') or contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'order confirmation')]");
        return Boolean(heading && isVisible(heading));
    }

    function handleCheckoutPage() {
        log('Checkout page — watching for confirmation / errors. Place Order will be clicked at most ONCE, only if the cart holds only TCIN ' + (state.alert ? state.alert.tcin : getTabTcin()) + '.');
        var loop = setInterval(function () {
            if (!state.running) { clearInterval(loop); return; }
            if (!window.location.href.match(/\/checkout|\/co-/)) { clearInterval(loop); return; }
            // Challenge check inside the checkout loop too (the v4.4 gap fix).
            if (isBotChallengePresent()) {
                clearInterval(loop);
                waitForChallengeClear().then(function (ok) { if (ok) handleCheckoutPage(); });
                return;
            }
            if (hasOrderConfirmation()) {
                clearInterval(loop);
                setMode('DONE');
                log('🎉 ORDER CONFIRMED! Check your Target account/email for the order number and send Shariful a screenshot.');
                beep(5);
                var alertId = null;
                try { alertId = JSON.parse(sessionStorage.getItem('v5_pending_alert') || 'null'); } catch (e) {}
                if (alertId && alertId.id) ackAlert(alertId.id, 'done', 'order_confirmed');
                try { sessionStorage.removeItem('v5_pending_alert'); } catch (e) {}
                return;
            }
            for (var i = 0; i < $$('[data-test="boxEmptyMsg"], [data-test="error-message"], [data-test="cartEmptyMessage"]').length; i++) {
                var msgEl = $$('[data-test="boxEmptyMsg"], [data-test="error-message"], [data-test="cartEmptyMessage"]')[i];
                var t = (msgEl.textContent || '').toLowerCase();
                if (t.indexOf('removed') !== -1 || t.indexOf('empty') !== -1 || t.indexOf('no longer available') !== -1 || t.indexOf('sold out') !== -1) {
                    clearInterval(loop);
                    setMode('FAILED');
                    log('⚠️ Item was removed from cart / sold out during checkout.');
                    failCurrentAlert('checkout_sold_out');
                    return;
                }
            }
            // CVV for the saved payment method (stored in this profile only).
            var cvv = getStoredCvv();
            if (cvv) {
                var cvvField = $('input[name*="cvv" i], input[data-test*="cvv" i], input[autocomplete="cc-csc"]');
                if (cvvField && isVisible(cvvField) && !cvvField.value) {
                    setNativeValue(cvvField, cvv);
                    log('CVV entered.');
                    var confirmBtn = $('button[data-test*="confirm" i], button[data-test*="save" i]');
                    if (confirmBtn && !isDisabled(confirmBtn)) confirmBtn.click();
                    return;
                }
            }
            // Continue buttons (shipping -> payment -> review).
            var cont = $('button[data-test*="continue" i]:not([disabled])') ||
                xpath("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'continue') and not(@disabled)]");
            if (cont && isVisible(cont)) { cont.click(); log('Checkout: Continue clicked.'); return; }
            // Place Order — at most once, cart must hold only the expected TCIN.
            var placeBtn = $('button[data-test="placeOrderButton"]');
            if (placeBtn && !isDisabled(placeBtn) && isVisible(placeBtn)) {
                var expected = state.alert ? state.alert.tcin : null;
                try { expected = expected || JSON.parse(sessionStorage.getItem('v5_pending_alert') || 'null').tcin; } catch (e) {}
                expected = expected || sessionStorage.getItem('v5_target_tcin') || getTabTcin();
                var cartTcins = extractCartItemTcins();
                if (cartTcins.size && (cartTcins.size > 1 || !cartTcins.has(expected))) {
                    clearInterval(loop);
                    setMode('FAILED');
                    log('🛡️ WRONG ITEM in cart (' + Array.from(cartTcins).join(', ') + ' vs expected ' + expected + ') — Place Order ABORTED. Nothing was purchased.');
                    failCurrentAlert('wrong_item_blocked');
                    return;
                }
                if (cartTcins.size === 0) log('Note: cart line items were not readable on this page — proceeding only because the PDP click was TCIN-verified.');
                if (!autoPlaceOrderEnabled()) {
                    clearInterval(loop);
                    log('⏸️ Auto place order is OFF — the order is ready. Review it and click "Place order" yourself. (The alert stays claimed; confirmation will still be detected.)');
                    beep(5);
                    return;
                }
                if (!state.placeOrderAttempted) {
                    state.placeOrderAttempted = true;
                    placeBtn.click();
                    log('🛍️ Place Order submitted once. Waiting for confirmation…');
                    beep(2);
                }
            }
        }, 1000);
    }

    function handleCartPage() {
        log('Cart page — looking for the checkout button…');
        var tryClick = function () {
            var btn = $('button[data-test="checkout-button"], [data-test="checkout-button"]') ||
                xpath("//button[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'checkout')]");
            if (btn && !isDisabled(btn) && isVisible(btn)) { btn.click(); log('Checkout button clicked.'); return true; }
            return false;
        };
        if (tryClick()) return;
        var iv = setInterval(function () { if (!state.running || tryClick()) clearInterval(iv); }, 500);
    }

    function failCurrentAlert(reason) {
        var alert = state.alert;
        state.alert = null;
        try { sessionStorage.removeItem('v5_pending_alert'); } catch (e) {}
        setMode('FAILED');
        if (alert) ackAlert(alert.id, 'failed', reason);
        setTimeout(function () { if (state.running) { setMode('IDLE'); idleLoop(); } }, 3000);
        return Promise.resolve(false);
    }

    // ------------------------------------------------- ARMED flow
    function runArmed(alert) {
        setMode('ARMED');
        state.alert = alert;
        state.lastAlertAt = Date.now();
        try { sessionStorage.setItem('v5_pending_alert', JSON.stringify(alert)); } catch (e) {}
        log('🔔 Alert for TCIN ' + alert.tcin + ' (' + (alert.title || '') + ', $' + alert.price + ') — claiming and verifying…');
        // The claim and the buy flow have SEPARATE error handlers: a 409 on
        // the claim means another profile has it (stand down); an error
        // inside the buy flow must fail the alert, not masquerade as a
        // claim conflict (bug found by test T6, 2026-11-20).
        return serverPost('/ack', { alert_id: alert.id, status: 'claimed' }).then(function (r) {
            return runArmedClaimed(alert).catch(function (e) {
                log('⚠️ Error inside the buy flow: ' + (e && e.message ? e.message : e) + ' — failing this alert, buying nothing.');
                return failCurrentAlert('buy_flow_error');
            });
        }).catch(function (e) {
            // A 409 here means another profile already claimed it.
            log('⚠️ Alert ' + alert.id + ' could not be claimed (another profile may have it) — standing down.');
            state.alert = null;
            try { sessionStorage.removeItem('v5_pending_alert'); } catch (e2) {}
            setMode('IDLE');
            return false;
        });
    }

    function runArmedClaimed(alert) {
        var tcin = alert.tcin;
        // 1. Be on the right product page.
        if (getTabTcin() !== tcin) {
            var targetUrl = unwrapRedirectUrl(alert.url);
            if (!targetUrl || targetUrl.indexOf('target.com') === -1 || (targetUrl.match(/A-(\d+)/) || [])[1] !== tcin) {
                log('⚠️ Alert URL does not match TCIN ' + tcin + ' — aborting (never navigate to an unverified URL).');
                return failCurrentAlert('price_or_tcin_mismatch').then(function () { return false; });
            }
            log('Navigating to the alerted product page…');
            window.location.href = targetUrl;
            return Promise.resolve('navigating');
        }
        // 2. Challenge check FIRST.
        return waitForChallengeClear().then(function (ok) {
            if (!ok || !state.running) return false;
            // 3. Verify stock once (API + DOM). No polling, no reload loop.
            return checkStockApiDetailed(tcin).then(function (api) {
                if (api.statuses.length) log('Redsky statuses for ' + tcin + ': [' + api.statuses.join(', ') + ']' + (api.price ? ' price=$' + api.price : ''));
                if (api.blocked) log('⚠️ Redsky check was PerimeterX-blocked — relying on the DOM button only for this attempt.');
                var btn = findATCButton();
                if (!api.buyable && !btn) {
                    log('Out of stock on verification (API: ' + (api.statuses.join(',') || 'none') + ', no ATC button). The window may already be closed — buying nothing.');
                    failCurrentAlert(api.blocked ? 'stock_check_blocked' : 'gone_before_buy');
                    return false;
                }
                if (api.buyable && !btn) {
                    // One reload only, then re-check once.
                    var reloadedKey = 'v5_reloaded_for_' + alert.id;
                    if (!sessionStorage.getItem(reloadedKey)) {
                        try { sessionStorage.setItem(reloadedKey, '1'); } catch (e) {}
                        log('API says buyable but no ATC button in the DOM yet — one reload, then re-check…');
                        window.location.reload();
                        return 'reloading';
                    }
                    log('API said buyable but the ATC button never appeared after one reload — buying nothing.');
                    failCurrentAlert('button_not_ready');
                    return false;
                }
                // 4. Price + TCIN guard.
                var price = getCurrentPrice();
                if (price === null && api.price !== null) price = api.price;
                var maxPrice = getMaxPrice(tcin);
                if (price !== null && maxPrice > 0 && price > maxPrice) {
                    log('⚠️ Price $' + price + ' is above the $' + maxPrice + ' cap — aborting, buying nothing.');
                    failCurrentAlert('price_or_tcin_mismatch');
                    return false;
                }
                if (getTabTcin() !== tcin) {
                    log('⚠️ Page TCIN changed — aborting.');
                    failCurrentAlert('price_or_tcin_mismatch');
                    return false;
                }
                // 5. Click (exact product only, re-verified at click time).
                log('✅ In stock (price $' + (price !== null ? price : '?') + ') — clicking the exact-product button…');
                beep(3);
                return waitForChallengeClear().then(function (ok2) {
                    if (!ok2) return false;
                    return beginAddToCart(btn);
                });
            });
        });
    }

    // ------------------------------------------------- IDLE loop
    var idleTimer = null;
    var lastOfflineLog = 0;
    function idleLoop() {
        if (!state.running || state.mode !== 'IDLE') return;
        // Any target.com page works (homepage, search, any product page):
        // ask the server for the oldest pending alert for ANY product.
        // runArmed() claims it, and runArmedClaimed() opens the alerted
        // product's page if this tab is not already on it. Filtering
        // (watchlist / price cap / dedupe) already happened server-side,
        // so there is nothing to check here — a queued alert is a buy.
        serverGet('/next-any')
            .then(function (res) {
                if (!state.running || state.mode !== 'IDLE') return;
                if (res && res.status === 'pending' && res.alert) {
                    var tcin = getTabTcin();
                    log('🔔 Alert for TCIN ' + res.alert.tcin + ' — ' + (tcin === res.alert.tcin ? 'this page, claiming…' : 'opening its product page…'));
                    runArmed(res.alert);
                } else {
                    idleTimer = setTimeout(idleLoop, IDLE_POLL_MS);
                }
            })
            .catch(function () {
                state.serverOnline = false;
                renderPanel();
                if (Date.now() - lastOfflineLog > 30000) {
                    lastOfflineLog = Date.now();
                    log('🔴 Server offline — waiting (no Target requests while offline). Start the server with start-server.bat.');
                }
                idleTimer = setTimeout(idleLoop, 2000);
            });
    }

    // ------------------------------------------------- boot
    function boot() {
        buildPanel();
        renderPanel();
        testServer(false);
        // Re-read the buy mode + watchlist from the server every 30s, so
        // a dashboard change takes effect without reloading this tab.
        setInterval(function () { testServer(false); }, 30000);
        var href = window.location.href;
        if (href.indexOf('/checkout') !== -1 || href.indexOf('/co-') !== -1) {
            setMode('ARMED');
            handleCheckoutPage();
            return;
        }
        if (href.indexOf('/cart') !== -1) {
            setMode('ARMED');
            handleCartPage();
            return;
        }
        // Resume an in-progress alert after a navigation/reload.
        var pending = null;
        try { pending = JSON.parse(sessionStorage.getItem('v5_pending_alert') || 'null'); } catch (e) {}
        if (pending && pending.tcin === getTabTcin()) {
            state.alert = pending;
            state.lastAlertAt = Date.now();
            log('Resuming claimed alert ' + pending.id + ' for TCIN ' + pending.tcin + ' after navigation/reload…');
            runArmedClaimed(pending);
            return;
        }
        if (pending && pending.tcin) {
            // Claimed alert, but this tab landed on the wrong page (or the
            // homepage): open the alerted product's page and resume there.
            log('Claimed alert ' + pending.id + ' is for TCIN ' + pending.tcin + ' — opening its product page…');
            window.location.href = 'https://www.target.com/p/-/A-' + pending.tcin;
            return;
        }
        setMode('IDLE');
        log('⏳ Waiting for a Discord alert (any product). This tab will open the alerted product page itself. No Target requests while waiting.');
        idleLoop();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    // Test hook (used by the jsdom harness in tests/ — harmless in production).
    window.__v5buyer = {
        state: state,
        WATCHLIST: WATCHLIST,
        BUYABLE_STATUSES: BUYABLE_STATUSES,
        isInBlockedSection: isInBlockedSection,
        isImpostorOrCarouselElement: isImpostorOrCarouselElement,
        findATCButton: findATCButton,
        getCurrentPrice: getCurrentPrice,
        extractTcin: extractTcin,
        isBotChallengePresent: isBotChallengePresent,
        checkStockApiDetailed: checkStockApiDetailed,
        runArmedClaimed: runArmedClaimed,
        idleLoop: idleLoop
    };
})();
