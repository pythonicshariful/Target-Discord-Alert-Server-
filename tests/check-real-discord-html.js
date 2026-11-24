// T16: run the Discord Receiver against the REAL Restockd channel HTML
// the user pasted (workspace/user/files/pasted-text.txt — Nov 6-13 2026
// messages). The real messages differ from the synthetic test message in
// two ways the old code got wrong (v5.4.2 fixes both):
//   1. links go through a howl.link tracking redirect, not target.com;
//   2. embed fields run together with no separator in textContent
//      ("Price$59.99Qty>= 10RetailerTargetView on Target…").
// Expects: every forwarded alert has the REAL product URL, a clean retailer
// ("Target") and a clean qty (">= 10" / "Pre-Order").
// Usage: node tests/check-real-discord-html.js   (from the repo root, or
// anywhere — paths below are absolute)
const fs = require('fs');
let JSDOM;
try {
    ({ JSDOM } = require('jsdom'));
} catch (e) {
    // jsdom lives in the shared test env, not in the repo.
    ({ JSDOM } = require('/home/hatch/workspace/.v5test/node_modules/jsdom'));
}

const html = fs.readFileSync('/home/hatch/workspace/user/files/pasted-text.txt', 'utf8');
const receiverSrc = fs.readFileSync(
    '/home/hatch/workspace/target-discord-alert-v5/tampermonkey/Target Discord Receiver.user.js', 'utf8');

const dom = new JSDOM(html, {
    url: 'https://discord.com/channels/1493097869782024232/1493097869782024232',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
});
const { window } = dom;

const posts = [];
const store = { v5_server_url: 'http://127.0.0.1:5000' };
window.GM_getValue = (k, d) => (k in store ? store[k] : d);
window.GM_setValue = (k, v) => { store[k] = v; };
window.GM_xmlhttpRequest = (o) => {
    if ((o.url || '').includes('/alert')) {
        posts.push(JSON.parse(o.data || '{}'));
        setTimeout(() => o.onload && o.onload({ status: 200, responseText: JSON.stringify({ ok: true, queued: true }) }), 5);
    } else {
        setTimeout(() => o.onload && o.onload({ status: 200, responseText: JSON.stringify({ ok: true, watchlist: [], mode: 'selected' }) }), 5);
    }
};
window.GM_addStyle = () => {};
window.eval(receiverSrc);

const failures = [];
function check(name, cond, detail) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : '  — ' + (detail || '')));
    if (!cond) failures.push(name);
}

setTimeout(() => {
    check('T16 at least 3 real alerts forwarded', posts.length >= 3, 'got ' + posts.length);
    const first = posts[0] || {};
    check('T16 first alert is the Nov 6 04:21 Mega Evolution ETB',
        first.price === 59.99 && first.message_id === 'discord-1568208814971424810',
        JSON.stringify(first));
    check('T16 every alert URL is the REAL product URL (no howl.link)',
        posts.every(p => /^https:\/\/www\.target\.com\/p\/-\/A-\d{6,}$/.test(p.url || '')),
        (posts.find(p => !/^https:\/\/www\.target\.com\/p\/-\/A-\d{6,}$/.test(p.url || '')) || {}).url);
    check('T16 first alert URL is the unwrapped product page',
        first.url === 'https://www.target.com/p/-/A-1012793604', first.url);
    check('T16 every retailer is exactly "Target" (not the next field label)',
        posts.every(p => p.retailer === 'Target'),
        JSON.stringify(posts.find(p => p.retailer !== 'Target')));
    check('T16 every qty is clean (">= 10" or "Pre-Order")',
        posts.every(p => p.qty === '>= 10' || p.qty === 'Pre-Order'),
        JSON.stringify(posts.find(p => p.qty !== '>= 10' && p.qty !== 'Pre-Order')));
    check('T16 every price is a number', posts.every(p => typeof p.price === 'number'));
    console.log(failures.length ? `RESULT: ${failures.length} FAILURE(S)` : 'RESULT: all T16 checks passed');
    process.exit(failures.length ? 1 : 0);
}, 4000);
