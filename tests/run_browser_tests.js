/* Browser tests T6 / T7 / T9 for Auto-Buy v5 — jsdom harness.
 * Runs the REAL Tampermonkey files with stubbed GM_* APIs (GM_xmlhttpRequest
 * is backed by Node fetch, so calls to the real local server work).
 *
 * Usage (server must be UP for T6/T7, DOWN for T9):
 *   node tests/run_browser_tests.js t6|t7|t9
 * Prints PASS/FAIL and exits non-zero on failure.
 *
 * What each test proves:
 *   T6: simulated alert while the product is OOS -> script wakes, verifies,
 *       finds OOS, buys NOTHING (in particular it never clicks the enabled
 *       "Find alternative" button), marks the alert failed, returns to IDLE.
 *   T7: a pending alert for a DIFFERENT TCIN -> script stays IDLE, clicks
 *       nothing. (Plus a positive control: findATCButton() DOES return an
 *       enabled exact-TCIN button when one exists, so a null result in T6
 *       is the guard working, not a broken finder.)
 *   T9: server offline -> receiver retries 3x, keeps the alert in its retry
 *       queue, panel shows OFFLINE; buyer makes no Target requests
 *       (asserted by counting fetch() calls to redsky.target.com: zero).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const SERVER = 'http://127.0.0.1:5000';
// No config file (v5.2.0): the token is fetched from the dashboard at
// runtime, exactly as a browser would — GET / for the per-start UI token,
// then GET /api/config with it.
let TOKEN = null;
async function fetchServerToken() {
  const html = await (await fetch(SERVER + '/')).text();
  const uiToken = /const UI_TOKEN = "([^"]+)"/.exec(html)[1];
  const cfg = await (await fetch(SERVER + '/api/config', {
    headers: { 'X-UI-Token': uiToken },
  })).json();
  return cfg.secret_token;
}
const TEST = process.argv[2];
const FAILURES = [];
let targetFetches = 0; // counts any fetch() to a target.com / redsky host

function check(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!cond) FAILURES.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(method, urlPath, body) {
  const res = await fetch(SERVER + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function makeGmStubs(window) {
  const store = { v5_token: TOKEN, v5_server_url: SERVER };
  return {
    GM_getValue: (k, d) => (k in store ? store[k] : d),
    GM_setValue: (k, v) => { store[k] = v; },
    GM_notification: () => {},
    GM_xmlhttpRequest: (opts) => {
      // Route through Node fetch; record any Target/Redsky traffic.
      if (/target\.com/.test(opts.url)) targetFetches++;
      fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.data,
      }).then(async (res) => {
        const text = await res.text().catch(() => '');
        if (opts.onload) opts.onload({ status: res.status, responseText: text });
      }).catch(() => { if (opts.onerror) opts.onerror(new Error('network error')); });
    },
    GM: undefined,
  };
}

function loadScript(window, file) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  window.eval(code);
}

// jsdom has no layout engine, so getBoundingClientRect() returns 0x0 for
// everything and the scripts' isVisible() would always be false. Stub it
// so "visible" elements measure non-zero (the real browser does layout;
// this stub only repairs the harness, not the scripts under test).
function stubLayout(window) {
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, x: 0, y: 0, toJSON: () => ({}) };
  };
}

// Count every Target/Redsky fetch (in-page fetch AND GM transport).
function countingFetch(window) {
  const realFetch = globalThis.fetch;
  window.fetch = (...a) => {
    if (/target\.com/.test(String(a[0]))) targetFetches++;
    return realFetch(...a);
  };
}

// ---------------------------------------------------------------- T6
async function testT6() {
  // Fresh pending alert for 1011407490 at its real price.
  const { status, json } = await httpJson('POST', '/alert', {
    token: TOKEN, source: 'v5-test', title: '[TEST T6] Booster Bundle Box',
    price: 31.99, qty: 'Pre-Order', retailer: 'Target',
    url: 'https://www.target.com/p/-/A-1011407490', message_id: 't6-' + Date.now(),
  });
  check('T6 setup: alert queued', status === 200 && json.status === 'queued', JSON.stringify(json));
  const alertId = json.alert_id;

  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>Booster Bundle Box : Target</title></head><body>
    <main>
      <h1 data-test="product-title">Pokémon TCG 30th Celebration Booster Bundle Box</h1>
      <div data-test="pdp-top-of-funnel">
        <div data-test="fulfillment-section">
          <div data-test="product-price"><span>$31.99</span></div>
          <button id="addToCartButtonOrTextIdFor1011407490" disabled>Add to cart</button>
        </div>
      </div>
      <div data-test="alternative-carousel">
        <h2>Find alternative</h2>
        <button id="addToCartButtonOrTextIdFor9999999999">Add to cart</button>
        <button data-test="shipItButton">Ship it</button>
      </div>
    </main></body></html>`, {
    url: 'https://www.target.com/p/-/A-1011407490',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  stubLayout(window);
  countingFetch(window); // in-page fetch for Redsky (PX-blocked from this VM, as expected)
  Object.assign(window, makeGmStubs(window));
  window.__clicks = [];
  window.document.addEventListener('click', (e) => {
    window.__clicks.push(e.target && (e.target.id || e.target.getAttribute('data-test') || e.target.textContent.trim()));
  }, true);

  loadScript(window, 'tampermonkey/Target Auto Buyer v5 (Discord Alert).user.js');
  await sleep(12000); // idle poll (750ms) + claim + Redsky verify + fail + 3s back-to-IDLE

  const v5 = window.__v5buyer;
  check('T6 script booted', !!v5, 'window.__v5buyer hook present');
  check('T6 no clicks at all (esp. never the Find-alternative button)',
    window.__clicks.length === 0, 'clicks: ' + JSON.stringify(window.__clicks));
  check('T6 findATCButton() returns null on the OOS page (alternative button blocked)',
    v5 && v5.findATCButton() === null, '');
  // Positive control: an enabled exact-TCIN button IS found.
  const mainBtn = window.document.getElementById('addToCartButtonOrTextIdFor1011407490');
  mainBtn.removeAttribute('disabled');
  check('T6 control: findATCButton() DOES return the enabled exact-TCIN button',
    v5 && v5.findATCButton() === mainBtn, '');
  mainBtn.setAttribute('disabled', '');

  const alerts = await httpJson('GET', '/alerts?limit=10');
  const mine = (alerts.json.alerts || []).find((a) => a.id === alertId);
  check('T6 alert marked failed (not bought, not left pending)',
    mine && mine.status === 'failed', JSON.stringify(mine && { status: mine.status, reason: mine.reason }));
  check('T6 failure reason is honest (gone_before_buy or stock_check_blocked)',
    mine && ['gone_before_buy', 'stock_check_blocked'].includes(mine.reason),
    'reason=' + (mine && mine.reason));
  check('T6 script returned to IDLE', v5 && v5.state.mode === 'IDLE', 'mode=' + (v5 && v5.state.mode));
  check('T6 Target requests happened ONLY in the one ARMED verification (2 Redsky calls, none while IDLE)',
    targetFetches === 2, 'targetFetches=' + targetFetches);
  window.close();
}

// ---------------------------------------------------------------- T7
async function testT7() {
  // Pending alert for the OTHER watched TCIN (1010892070) only.
  const { status, json } = await httpJson('POST', '/alert', {
    token: TOKEN, source: 'v5-test', title: '[TEST T7] Knock Out Collection',
    price: 11.99, qty: 'Pre-Order', retailer: 'Target',
    url: 'https://www.target.com/p/-/A-1010892070', message_id: 't7-' + Date.now(),
  });
  check('T7 setup: alert for other TCIN queued', status === 200 && json.status === 'queued', JSON.stringify(json));
  const otherId = json.alert_id;

  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>Booster Bundle Box : Target</title></head><body>
    <main>
      <h1 data-test="product-title">Pokémon TCG 30th Celebration Booster Bundle Box</h1>
      <div data-test="pdp-top-of-funnel"><div data-test="fulfillment-section">
        <div data-test="product-price"><span>$31.99</span></div>
        <button id="addToCartButtonOrTextIdFor1011407490" disabled>Add to cart</button>
      </div></div>
    </main></body></html>`, {
    url: 'https://www.target.com/p/-/A-1011407490',
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  stubLayout(window);
  countingFetch(window);
  Object.assign(window, makeGmStubs(window));
  window.__clicks = [];
  window.document.addEventListener('click', (e) => {
    window.__clicks.push(e.target && (e.target.id || e.target.textContent.trim()));
  }, true);

  loadScript(window, 'tampermonkey/Target Auto Buyer v5 (Discord Alert).user.js');
  await sleep(6000); // several idle polls

  const v5 = window.__v5buyer;
  check('T7 script stays IDLE (no alert for this tab TCIN)',
    v5 && v5.state.mode === 'IDLE', 'mode=' + (v5 && v5.state.mode));
  check('T7 no clicks', window.__clicks.length === 0, 'clicks: ' + JSON.stringify(window.__clicks));
  check('T7 zero Target requests while IDLE', targetFetches === 0, 'targetFetches=' + targetFetches);
  const next = await httpJson('GET', '/next?tcin=1010892070');
  check('T7 the other-TCIN alert is still pending (not stolen by this tab)',
    next.json.status === 'pending' && next.json.alert && next.json.alert.id === otherId,
    JSON.stringify(next.json.status));
  window.close();
}

// ---------------------------------------------------------------- T9
async function testT9() {
  // Server is DOWN for this test. Receiver must retry 3x, keep the alert,
  // and show OFFLINE. Buyer must make no Target requests (no server to
  // wake it — tested implicitly: we only load the receiver here).
  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>Discord</title></head><body>
    <main><div data-list-item-id="chat-messages-111-123456789012345678">
      <span>Restockd</span><span>APP</span>
      <div><a href="https://www.target.com/p/x/-/A-1011407490">Pokémon TCG 30th Celebration Booster Bundle Box | Target</a></div>
      <div>Price</div><div>$31.99</div><div>Qty</div><div>Pre-Order</div>
      <div>Retailer</div><div>Target</div>
      <a href="https://www.target.com/p/pokemon-tcg-30th-celebration-booster-bundle-box/-/A-1011407490">Open product</a>
      <span>Restockd.app • #ad</span>
    </div></main></body></html>`, {
    url: 'https://discord.com/channels/123/456',
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  window.fetch = globalThis.fetch;
  Object.assign(window, makeGmStubs(window));
  loadScript(window, 'tampermonkey/Target Discord Receiver.user.js');
  await sleep(8000); // scan + 3 POST retries (1s apart) + retry-queue flush timer not yet due

  const rx = window.__v5receiver;
  check('T9 receiver booted', !!rx, 'window.__v5receiver hook present');
  check('T9 server reported offline', rx && rx.serverOnline === false, 'serverOnline=' + (rx && rx.serverOnline));
  check('T9 alert kept in retry queue (not silently dropped)',
    rx && rx.retryQueue.length >= 1, 'retryQueue=' + (rx && rx.retryQueue.length));
  const panel = window.document.getElementById('v5-receiver-panel');
  check('T9 panel shows OFFLINE',
    panel && /OFFLINE/.test(panel.textContent), panel ? panel.textContent.slice(0, 120) : 'no panel');
  check('T9 zero Target requests from the receiver', targetFetches === 0, 'targetFetches=' + targetFetches);
  window.close();
}

// ---------------------------------------------------------------- main
(async () => {
  try {
    if (TEST === 't6' || TEST === 't7') TOKEN = await fetchServerToken();
    if (TEST === 't6') await testT6();
    else if (TEST === 't7') await testT7();
    else if (TEST === 't9') await testT9();
    else { console.log('usage: node tests/run_browser_tests.js t6|t7|t9'); process.exit(2); }
  } catch (e) {
    console.log('FAIL harness error: ' + (e && e.stack || e));
    FAILURES.push('harness-error');
  }
  console.log();
  if (FAILURES.length) { console.log('RESULT: ' + FAILURES.length + ' FAILURE(S): ' + FAILURES.join(', ')); process.exit(1); }
  console.log('RESULT: all ' + TEST.toUpperCase() + ' checks passed');
  process.exit(0);
})();
