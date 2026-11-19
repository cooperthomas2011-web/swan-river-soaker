// Splash Coins – the real-money currency.
// Players pay through Stripe Checkout (card, Apple Pay, Google Pay). The coins live here on the server, not in the
// player's browser, so nobody can give themselves coins by editing their save.
//
// Setup (Render → your service → Environment):
//   STRIPE_SECRET_KEY      sk_live_... (or sk_test_... while testing) from dashboard.stripe.com → Developers → API keys
//   STRIPE_WEBHOOK_SECRET  whsec_...  (optional but recommended) from Developers → Webhooks, endpoint https://YOUR-SITE/stripe/webhook,
//                          event "checkout.session.completed"
//   SPLASH_DEMO=1          ONLY for trying it out without Stripe: purchases are free and fake. Never set this on the live game.
//
// Every paid purchase also carries the player's Splash ID in Stripe, so if this server's file is ever wiped
// (Render's free plan wipes files on restart/redeploy) a player's bought coins are rebuilt from Stripe automatically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY = process.env.STRIPE_SECRET_KEY || '';
const WH = process.env.STRIPE_WEBHOOK_SECRET || '';
const DEMO = process.env.SPLASH_DEMO === '1' && !KEY;
const FILE = path.join(__dirname, 'splash.json');
const CURRENCY = 'aud';
// coins -> price in cents
const PACKS = { p10: { coins: 10, cents: 50 }, p50: { coins: 50, cents: 100 }, p100: { coins: 100, cents: 150 }, p500: { coins: 500, cents: 450 } };
const CASH_PER_COIN = 10000; // 10 coins = $100,000 in game
// Stripe product tax code (needed for Managed Payments, where Stripe handles GST): Video Games - downloaded - non subscription - with limited rights
const TAX_CODE = process.env.STRIPE_TAX_CODE || 'txcd_10201001';

let DB = { ids: {}, sessions: {} };
try { DB = JSON.parse(fs.readFileSync(FILE, 'utf8')); DB.ids = DB.ids || {}; DB.sessions = DB.sessions || {}; } catch (e) { }
let saveT = null;
function save() { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(FILE, JSON.stringify(DB), () => { }), 300); }

const ID_RE = /^[A-Z0-9]{12}$/;
function acct(id) { return DB.ids[id] || (DB.ids[id] = { bought: 0, spent: 0, synced: false }); }
function bal(a) { return Math.max(0, a.bought - a.spent); }

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function body(req, max = 1e5) { return new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > max) { no(new Error('too big')); req.destroy(); } }); req.on('end', () => ok(d)); req.on('error', no); }); }

// ---- Stripe REST calls (no extra npm packages needed: Node 18+ has fetch) ----
function form(obj, pre = '', out = []) {
  for (const [k, v] of Object.entries(obj)) { const key = pre ? pre + '[' + k + ']' : k; if (v !== null && typeof v === 'object') form(v, key, out); else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v)); }
  return out.join('&');
}
async function stripe(method, p, params) {
  const r = await fetch('https://api.stripe.com/v1/' + p + (method === 'GET' && params ? '?' + form(params) : ''), {
    method, headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: method === 'POST' ? form(params || {}) : undefined
  });
  const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe error ' + r.status); return j;
}

// credit a paid Checkout Session exactly once
function creditSession(s) {
  if (!s || s.payment_status !== 'paid' || DB.sessions[s.id]) return false;
  const id = s.metadata && s.metadata.sid, coins = +(s.metadata && s.metadata.coins);
  if (!ID_RE.test(id || '') || !(coins > 0)) return false;
  DB.sessions[s.id] = { id, coins, t: Date.now() }; acct(id).bought += coins; save(); return true;
}
// after a wipe: rebuild what this Splash ID has bought from Stripe
async function syncFromStripe(id) {
  const a = acct(id); if (a.synced || !KEY) return; a.synced = true;
  try {
    let total = 0, page = null;
    do {
      const q = { query: "metadata['sid']:'" + id + "' AND status:'succeeded'", limit: 100 }; if (page) q.page = page;
      const r = await stripe('GET', 'payment_intents/search', q);
      for (const pi of r.data) total += +(pi.metadata && pi.metadata.coins) || 0;
      page = r.has_more ? r.next_page : null;
    } while (page);
    if (total > a.bought) { a.bought = total; save(); }
  } catch (e) { a.synced = false; console.warn('splash sync', e.message); }
}

async function handle(req, res, url) {
  try {
    const p = url.pathname;
    if (p === '/splash/config') return json(res, 200, { enabled: !!KEY || DEMO, demo: DEMO, test: KEY.startsWith('sk_test_'), currency: CURRENCY, cashPerCoin: CASH_PER_COIN, packs: Object.entries(PACKS).map(([k, v]) => ({ id: k, coins: v.coins, cents: v.cents })) });

    if (p === '/splash/balance') {
      const id = String(url.searchParams.get('id') || ''); if (!ID_RE.test(id)) return json(res, 400, { error: 'bad id' });
      await syncFromStripe(id); const a = acct(id);
      // the player's browser remembers what it has spent too, so a wiped server can never hand spent coins back twice... or lose them
      const ls = Math.floor(+url.searchParams.get('spent') || 0); if (ls > a.spent && ls <= a.bought) { a.spent = ls; save(); }
      return json(res, 200, { balance: bal(a), bought: a.bought, spent: a.spent });
    }

    if (p === '/splash/checkout' && req.method === 'POST') {
      const b = JSON.parse(await body(req) || '{}'), id = String(b.id || ''), pack = PACKS[b.pack];
      if (!ID_RE.test(id) || !pack) return json(res, 400, { error: 'bad request' });
      if (DEMO) { const a = acct(id); a.bought += pack.coins; save(); return json(res, 200, { demo: true, balance: bal(a), coins: pack.coins }); }
      if (!KEY) return json(res, 503, { error: 'Payments are not set up on this server yet' });
      const origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;
      const meta = { sid: id, coins: String(pack.coins) };
      const s = await stripe('POST', 'checkout/sessions', {
        mode: 'payment',
        line_items: { 0: { quantity: 1, price_data: { currency: CURRENCY, unit_amount: pack.cents, product_data: { name: pack.coins + ' Splash Coins', tax_code: TAX_CODE, description: 'Swan River Soaker in-game currency (worth ' + '$' + (pack.coins * CASH_PER_COIN).toLocaleString('en-AU') + ' in game)' } } } },
        metadata: meta, payment_intent_data: { metadata: meta, description: pack.coins + ' Splash Coins' }, client_reference_id: id,
        success_url: origin + '/?splash=ok&session_id={CHECKOUT_SESSION_ID}', cancel_url: origin + '/?splash=cancel'
      });
      return json(res, 200, { url: s.url });
    }

    if (p === '/splash/confirm' && req.method === 'POST') { // the player comes back from Stripe: check the payment with Stripe ourselves
      const b = JSON.parse(await body(req) || '{}'), id = String(b.id || ''), sid = String(b.session || '');
      if (!ID_RE.test(id) || !/^cs_[A-Za-z0-9_]{10,200}$/.test(sid) || !KEY) return json(res, 400, { error: 'bad request' });
      const already = !!DB.sessions[sid], s = await stripe('GET', 'checkout/sessions/' + sid);
      if (s.metadata && s.metadata.sid !== id) return json(res, 403, { error: 'This purchase belongs to another Splash ID' });
      const added = creditSession(s);
      return json(res, 200, { paid: s.payment_status === 'paid', coins: (added || already) ? +s.metadata.coins : 0, balance: bal(acct(id)) });
    }

    if (p === '/splash/spend' && req.method === 'POST') { // swap coins for in-game cash
      const b = JSON.parse(await body(req) || '{}'), id = String(b.id || ''), coins = Math.floor(+b.coins || 0);
      if (!ID_RE.test(id) || coins <= 0 || coins > 1e7) return json(res, 400, { error: 'bad request' });
      await syncFromStripe(id); const a = acct(id);
      if (bal(a) < coins) return json(res, 200, { ok: false, balance: bal(a), error: 'Not enough Splash Coins' });
      a.spent += coins; save(); return json(res, 200, { ok: true, coins, cash: coins * CASH_PER_COIN, balance: bal(a), spent: a.spent });
    }

    if (p === '/stripe/webhook' && req.method === 'POST') { // Stripe tells us about a payment even if the player closed the tab
      const raw = await body(req, 1e6);
      if (WH) {
        const sig = String(req.headers['stripe-signature'] || ''), parts = Object.fromEntries(sig.split(',').map(x => x.split('=')));
        const exp = crypto.createHmac('sha256', WH).update(parts.t + '.' + raw).digest('hex');
        if (!parts.v1 || exp.length !== parts.v1.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(parts.v1)) || Math.abs(Date.now() / 1000 - +parts.t) > 600) return json(res, 400, { error: 'bad signature' });
        const ev = JSON.parse(raw); if (ev.type === 'checkout.session.completed') creditSession(ev.data.object);
      } else if (KEY) { // no webhook secret: never trust the body, look the session up with Stripe instead
        const ev = JSON.parse(raw), id = ev && ev.data && ev.data.object && ev.data.object.id;
        if (ev.type === 'checkout.session.completed' && /^cs_/.test(id || '')) creditSession(await stripe('GET', 'checkout/sessions/' + id));
      }
      return json(res, 200, { received: true });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { console.warn('splash', e.message); return json(res, 500, { error: e.message }); }
}

module.exports = { handle };
