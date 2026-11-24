// T18: the dashboard must not clobber a mode choice the user picked but
// has not saved yet (v5.4.3).
//
// BUG (reported 2026-11-24): the dashboard auto-refreshes every 10 s
// (setInterval(loadAll, 10000)) and loadAll() reset the "What to buy"
// radio to the server's CURRENT mode. So if the user clicked "Any
// product" and took more than 10 s to press "Save choice" — reading the
// warning, hesitating — the tick silently flipped the radio back to
// "Selected products only", and Save then saved "selected". To the user
// it looked like "no matter how much I set any product, it always stays
// selected, even after saving".
//
// This test loads the REAL served dashboard page in jsdom (real UI token,
// real fetch), clicks the "any" radio, runs loadAll() again (simulating
// the 10 s tick), and asserts the choice survives; then saves and asserts
// /status reports "any", and that a later loadAll() still shows "any".
// Needs the server UP on http://127.0.0.1:5000 (fresh DB, default mode
// is "any" in v5.4.3 — the test asserts that too).
let JSDOM;
try {
    ({ JSDOM } = require('jsdom'));
} catch (e) {
    ({ JSDOM } = require('/home/hatch/workspace/.v5test/node_modules/jsdom'));
}

const BASE = 'http://127.0.0.1:5000';
const failures = [];
function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  — ' + (detail || '')));
    if (!cond) failures.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function status() {
    const r = await fetch(BASE + '/status');
    return r.json();
}

(async () => {
    const st0 = await status();
    check('T18 fresh DB defaults to any-product mode', st0.mode === 'any', 'mode=' + st0.mode);

    const html = await (await fetch(BASE + '/')).text();
    // The dashboard script must PARSE at all: v5.4.3 fixed a real syntax
    // error in it (a mis-escaped quote in the watchlist Remove button)
    // that killed the whole script — no loadAll, no Save — so every
    // refresh showed the hardcoded "selected" radio again.
    const scriptText = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
    let parseOk = true, parseErr = '';
    try { new Function(scriptText); } catch (e) { parseOk = false; parseErr = e.message; }
    check('T18 dashboard script parses (no syntax error)', parseOk, parseErr);
    const dom = new JSDOM(html, {
        url: BASE + '/',
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        beforeParse(window) {
            // node fetch needs an absolute URL; a real browser resolves
            // the dashboard's relative "/api/…" paths against the page.
            window.fetch = (url, opts) => fetch(new URL(url, 'http://127.0.0.1:5000'), opts);
            window.confirm = () => true; // user clicks OK on the any-mode warning
        },
    });
    const { window } = dom;
    const { document } = window;
    // wait for the first loadAll() to fill the page
    for (let i = 0; i < 40; i++) {
        if (document.getElementById('mode-note') && document.getElementById('mode-note').textContent) break;
        await sleep(100);
    }
    const anyRadio = document.querySelector('input[name="buy-mode"][value="any"]');
    const selRadio = document.querySelector('input[name="buy-mode"][value="selected"]');
    check('T18 dashboard loaded with the any radio checked (server default)',
        anyRadio && anyRadio.checked, 'any.checked=' + (anyRadio && anyRadio.checked));

    // Simulate the user switching to "selected" (the reverse direction —
    // the bug is symmetric), then a 10 s tick firing before Save.
    selRadio.checked = true;
    selRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
    await window.loadAll(); // the 10 s auto-refresh tick
    check('T18 an unsaved radio choice survives the auto-refresh tick',
        selRadio.checked && !anyRadio.checked,
        'selected.checked=' + selRadio.checked + ' any.checked=' + anyRadio.checked);

    // Save it, then check the server and the page agree.
    await window.setMode();
    const st1 = await status();
    check('T18 saving the choice persists on the server', st1.mode === 'selected', 'mode=' + st1.mode);
    await window.loadAll();
    check('T18 after save, the tick shows the saved choice',
        selRadio.checked && !anyRadio.checked, 'selected.checked=' + selRadio.checked);

    // Switch back to "any" and save, so the test leaves the server in its
    // default state for whatever runs next.
    anyRadio.checked = true;
    anyRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
    await window.loadAll(); // another tick before Save — must not flip it back
    check('T18 an unsaved "any" choice also survives the tick',
        anyRadio.checked && !selRadio.checked,
        'any.checked=' + anyRadio.checked + ' selected.checked=' + selRadio.checked);
    await window.setMode();
    const st2 = await status();
    check('T18 switching back to any persists', st2.mode === 'any', 'mode=' + st2.mode);
    await window.loadAll();
    check('T18 after save, the tick shows "any"',
        anyRadio.checked && !selRadio.checked, 'any.checked=' + anyRadio.checked);

    console.log(failures.length ? `RESULT: ${failures.length} FAILURE(S)` : 'RESULT: all T18 checks passed');
    process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('T18 ERROR', e); process.exit(1); });
