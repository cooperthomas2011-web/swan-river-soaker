// Swan River Soaker – online server
// Serves the game (index.html) and runs the shared river:
//  - every player sends their position ~15 times a second and the server passes it on to everyone else
//  - proximity chat: what you type only reaches players close to you
//  - raft-ups, gifts (items + cash) and soaks (spraying someone takes their money) between nearby players
//  - leaderboard: richest players online now + the richest ever seen (saved to leaderboard.json)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const splash = require('./splash'); // Splash Coins (real-money currency, Stripe)

const PORT = process.env.PORT || 3000;
// the game sits next to this file (index.html); a public/ folder also works
const PUBLIC = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, 'public');
const SKIP = new Set(['server.js', 'package.json', 'package-lock.json', 'render.yaml', 'README.md', 'leaderboard.json', 'auction.json', 'splash.js', 'splash.json']);
const MAX_PLAYERS = 40;
const CHAT_RANGE = 80;   // metres: how close you must be to hear someone
const GIFT_RANGE = 30;   // metres: how close you must be to hand something over
const RAFT_RANGE = 25;   // metres: how close you must be to raft up
const SOAK_RANGE = 140;  // metres: the furthest a stream can possibly reach (big rooster tails)
const LB_FILE = path.join(__dirname, 'leaderboard.json');
const AUC_FILE = path.join(__dirname, 'auction.json');
const AUC_START = 5000000, AUC_STEP = 100000, AUC_LEN = (+process.env.AUCTION_MINUTES || 6 * 24 * 60) * 60 * 1000, AUC_E0 = Date.UTC(2026, 10, 19, 4, 0, 0); // rounds run back to back, 6 days each

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, players: players.size })); }
  if (url.pathname.startsWith('/splash/') || url.pathname === '/stripe/webhook') return splash.handle(req, res, url);
  if (url.pathname === '/leaderboard') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(JSON.stringify(lbSnapshot())); }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC) || SKIP.has(path.basename(file)) || file.includes('node_modules')) { res.writeHead(404); return res.end('Not found'); }
  if (url.pathname === '/' || !path.extname(file)) file = path.join(PUBLIC, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---- shared river ----
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
const players = new Map(); // id -> { ws, presence, raft, lastP, lastChat, chatBurst, soakT }
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function sendTo(ws, obj) { if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function broadcast(fromId, obj) { const msg = JSON.stringify(obj); for (const [id, p] of players) if (id !== fromId) sendTo(p.ws, msg); }
function cleanName(n) { return String(n || '').replace(/[^A-Za-z0-9 _.\-]/g, '').trim().slice(0, 14) || 'Player'; }
function nameOf(p) { return cleanName(p && p.presence && p.presence.n); }
function posOf(p) { const d = p && p.presence; return d && typeof d.x === 'number' && typeof d.z === 'number' && d.g === 1 ? d : null; }
function dist(a, b) { const pa = posOf(a), pb = posOf(b); if (!pa || !pb) return Infinity; return Math.hypot(pa.x - pb.x, pa.z - pb.z); }
function cashOf(p) { const c = p && p.presence && p.presence.$; return typeof c === 'number' && isFinite(c) && c >= 0 ? Math.floor(Math.min(c, 1e15)) : 0; }
function money(n) { return Math.floor(Math.max(0, Math.min(+n || 0, 1e15))); }
const ITEM_RE = /^(beer|pie|chips|booga|sharktooth|surfwax|lure|nsotcap|fish:[a-z0-9_]{1,40}:\d{1,4}(\.\d{1,2})?)$/;

function unraft(id, tell) {
  const p = players.get(id); if (!p || !p.raft) return;
  const other = players.get(p.raft); p.raft = null;
  if (other && other.raft === id) { other.raft = null; if (tell) sendTo(other.ws, { t: 'unrafted', id, n: nameOf(p) }); }
}

wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'River is full'); return; }
  const id = newId();
  const me = { ws, presence: null, raft: null, host: null, invAsk: new Map(), lastP: 0, lastChat: 0, chatBurst: 0, soakT: new Map(), raftAsk: new Map() };
  players.set(id, me);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // tell the new player who is already on the river
  const others = [];
  for (const [pid, p] of players) if (pid !== id && p.presence) others.push([pid, p.presence]);
  sendTo(ws, { t: 'hello', id, peers: others, lb: lbSnapshot(), auc: aucState() });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();
    switch (m.t) {
      case 'p': { // presence (position etc.)
        if (now - me.lastP < 30) return; me.lastP = now; // max ~33 updates/s per player
        if (typeof m.d !== 'object' || m.d === null) return;
        me.presence = m.d; if (m.d.g === 1) { lbSeen(nameOf(me), cashOf(me)); aucDeliver(id, me); }
        broadcast(id, { t: 'p', id, d: m.d });
        return;
      }
      case 'c': { // proximity chat
        let txt = String(m.m || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160); if (!txt) return;
        // flood control: about 5 quick messages, then one every 1.2 s
        me.chatBurst = Math.max(0, me.chatBurst - (now - me.lastChat) / 1200); if (me.chatBurst > 5) { sendTo(ws, { t: 'csys', m: 'Slow down a bit!' }); return; }
        me.chatBurst++; me.lastChat = now;
        const msg = JSON.stringify({ t: 'c', id, n: nameOf(me), m: txt }); let heard = 0;
        for (const [pid, p] of players) { if (pid === id) continue; if (dist(me, p) <= CHAT_RANGE) { sendTo(p.ws, msg); heard++; } }
        sendTo(ws, { t: 'cme', m: txt, heard });
        return;
      }
      case 'raft': { // ask someone to raft up
        const o = players.get(m.to); if (!o || o === me) return;
        if (dist(me, o) > RAFT_RANGE) return sendTo(ws, { t: 'note', m: 'Get closer to raft up' });
        if (o.raft) return sendTo(ws, { t: 'note', m: nameOf(o) + ' is already rafted up' });
        me.raftAsk.set(m.to, now); sendTo(o.ws, { t: 'raftreq', from: id, n: nameOf(me) });
        return;
      }
      case 'raftyes': { // accept a raft-up request: the asker ties up alongside the one who accepted
        const o = players.get(m.to); if (!o || o === me) return;
        const asked = o.raftAsk.get(id); if (!asked || now - asked > 30000) return sendTo(ws, { t: 'note', m: 'That raft-up request expired' });
        o.raftAsk.delete(id);
        if (dist(me, o) > RAFT_RANGE + 15) return sendTo(ws, { t: 'note', m: 'Too far apart to raft up' });
        unraft(id, true); unraft(m.to, true);
        me.raft = m.to; o.raft = id;
        sendTo(ws, { t: 'rafted', id: m.to, n: nameOf(o), anchor: true });
        sendTo(o.ws, { t: 'rafted', id, n: nameOf(me), anchor: false });
        return;
      }
      case 'raftno': { const o = players.get(m.to); if (o) { o.raftAsk.delete(id); sendTo(o.ws, { t: 'note', m: nameOf(me) + ' said no to rafting up' }); } return; }
      case 'unraft': unraft(id, true); return;
      case 'invite': { // invite your raft-up partner aboard your boat
        const o = players.get(m.to); if (!o || me.raft !== m.to) return sendTo(ws, { t: 'note', m: 'Raft up with them first to invite them aboard' });
        me.invAsk.set(m.to, now); sendTo(o.ws, { t: 'invreq', from: id, n: nameOf(me) }); return;
      }
      case 'invyes': { // accept: I become a passenger on their boat
        const o = players.get(m.to); if (!o) return; const asked = o.invAsk.get(id); if (!asked || now - asked > 30000) return sendTo(ws, { t: 'note', m: 'That invite expired' });
        o.invAsk.delete(id); unraft(id, false); leaveBoat(id, false); me.host = m.to;
        sendTo(ws, { t: 'aboard', host: m.to, n: nameOf(o) }); sendTo(o.ws, { t: 'paxon', id, n: nameOf(me) }); return;
      }
      case 'invno': { const o = players.get(m.to); if (o) { o.invAsk.delete(id); sendTo(o.ws, { t: 'note', m: nameOf(me) + ' said no thanks' }); } return; }
      case 'kick': { const o = players.get(m.to); if (o && o.host === id) { o.host = null; sendTo(o.ws, { t: 'kicked', id, n: nameOf(me) }); sendTo(ws, { t: 'paxoff', id: m.to, n: nameOf(o) }); } return; }
      case 'leaveboat': leaveBoat(id, true); return;
      case 'auc': sendTo(ws, { t: 'auc', auc: aucState(id) }); return;
      case 'bid': { const r = aucBid(id, me, m.amt); sendTo(ws, r.ok ? { t: 'note', m: 'Bid placed: $' + r.amt.toLocaleString() } : { t: 'bidfail', m: r.m }); return; }
      case 'aucpaid': { const w = AUC.winners.find(x => x.round === m.round && !x.paid && x.n.toLowerCase() === nameOf(me).toLowerCase()); if (w) { w.paid = true; aucSave(); } return; }
      case 'aucfail': { const w = AUC.winners.find(x => x.round === m.round && !x.paid && x.n.toLowerCase() === nameOf(me).toLowerCase()); if (w) { aucNext(w); aucSave(); } return; }
      case 'gift': { // hand over an item or cash
        const o = players.get(m.to), item = typeof m.item === 'string' && ITEM_RE.test(m.item) ? m.item : null, cash = money(m.cash);
        if (!item && !cash) return;
        if (!o || o === me || (dist(me, o) > GIFT_RANGE && me.raft !== m.to)) return sendTo(ws, { t: 'giftfail', item, cash, m: 'Get closer to hand that over' });
        sendTo(o.ws, { t: 'gift', from: id, n: nameOf(me), item, cash });
        sendTo(ws, { t: 'giftok', item, cash, n: nameOf(o) });
        return;
      }
      case 'soak': { // my stream is hitting someone
        const o = players.get(m.to); if (!o || o === me || me.raft === m.to) return;
        const last = me.soakT.get(m.to) || 0; if (now - last < 250) return; me.soakT.set(m.to, now);
        if (dist(me, o) > SOAK_RANGE) return;
        sendTo(o.ws, { t: 'soak', from: id, n: nameOf(me) });
        return;
      }
      case 'soakpaid': { // the soaked player reports what they lost; it goes to whoever soaked them
        const o = players.get(m.to); if (!o || o === me) return; const amt = money(m.amt); if (!amt) return;
        sendTo(o.ws, { t: 'paid', from: id, n: nameOf(me), amt });
        return;
      }
    }
  });
  ws.on('close', () => { unraft(id, true); leaveBoat(id, true); dropPax(id); players.delete(id); broadcast(id, { t: 'bye', id }); });
  ws.on('error', () => { });
});

function leaveBoat(id, tell) { const p = players.get(id); if (!p || !p.host) return; const h = players.get(p.host); p.host = null; if (tell) { sendTo(p.ws, { t: 'kicked', self: true }); if (h) sendTo(h.ws, { t: 'paxoff', id, n: nameOf(p), left: true }); } }
function dropPax(hostId) { const h = players.get(hostId); for (const [pid, p] of players) if (p.host === hostId) { p.host = null; sendTo(p.ws, { t: 'kicked', id: hostId, n: nameOf(h), gone: true }); } }

// ---- seaplane auction ----
// One seaplane per 6-day round. Highest bid when the round ends wins and pays (the money just leaves the game).
// If the winner can no longer afford it, it goes to the next highest bidder.
let AUC = { round: -1, bids: [], winners: [] }; try { AUC = Object.assign(AUC, JSON.parse(fs.readFileSync(AUC_FILE, 'utf8'))); } catch (e) { }
const aucRound = (t = Date.now()) => Math.floor((t - AUC_E0) / AUC_LEN);
const aucEnds = r => AUC_E0 + (r + 1) * AUC_LEN;
function aucSave() { fs.writeFile(AUC_FILE, JSON.stringify(AUC), () => { }); }
function aucTop() { return AUC.bids.length ? AUC.bids[AUC.bids.length - 1] : null; }
function aucTick() {
  const r = aucRound(); if (AUC.round === r) return;
  if (AUC.round >= 0 && AUC.bids.length) { const order = []; for (let i = AUC.bids.length - 1; i >= 0; i--) if (!order.some(b => b.n.toLowerCase() === AUC.bids[i].n.toLowerCase())) order.push(AUC.bids[i]); AUC.winners.push({ round: AUC.round, n: order[0].n, amt: order[0].amt, queue: order.slice(1), paid: false, t: Date.now() }); AUC.winners = AUC.winners.slice(-20); }
  AUC.round = r; AUC.bids = []; aucSave(); broadcast(null, { t: 'auc', auc: aucState() });
}
function aucNext(w) { const nx = w.queue.shift(); if (nx) { w.n = nx.n; w.amt = nx.amt; } else w.paid = true; }
function aucState(id) {
  aucTick(); const top = aucTop(), p = id && players.get(id), nm = p ? nameOf(p).toLowerCase() : '';
  const last = AUC.winners.length ? AUC.winners[AUC.winners.length - 1] : null;
  return { round: AUC.round, endsAt: aucEnds(AUC.round), now: Date.now(), start: AUC_START, step: AUC_STEP, top: top ? { n: top.n, amt: top.amt } : null, count: AUC.bids.length, recent: AUC.bids.slice(-5).reverse().map(b => ({ n: b.n, amt: b.amt })), mine: nm ? (AUC.bids.filter(b => b.n.toLowerCase() === nm).pop() || {}).amt || 0 : 0, last: last ? { n: last.n, amt: last.amt, paid: last.paid } : null };
}
function aucBid(id, p, amt) {
  aucTick(); amt = Math.floor(+amt || 0); const top = aucTop(), min = top ? top.amt + AUC_STEP : AUC_START, nm = nameOf(p);
  if (nm === 'Player') return { m: 'Pick a player name before bidding' };
  if (!isFinite(amt) || amt < min) return { m: 'Bid at least $' + min.toLocaleString() };
  if (amt > cashOf(p)) return { m: "You don't have that much money" };
  if (top && top.n.toLowerCase() === nm.toLowerCase() && amt <= top.amt) return { m: 'You are already the top bidder' };
  const prev = top; AUC.bids.push({ n: nm, amt, t: Date.now() }); if (AUC.bids.length > 400) AUC.bids.splice(0, AUC.bids.length - 400); aucSave();
  if (prev && prev.n.toLowerCase() !== nm.toLowerCase()) for (const [, q] of players) if (nameOf(q).toLowerCase() === prev.n.toLowerCase()) sendTo(q.ws, { t: 'outbid', n: nm, amt });
  broadcast(null, { t: 'auc', auc: aucState() }); return { ok: true, amt };
}
function aucDeliver(id, p) {
  if (p.aucT && Date.now() - p.aucT < 20000) return; const nm = nameOf(p).toLowerCase();
  const w = AUC.winners.find(x => !x.paid && x.n.toLowerCase() === nm); if (!w) return; p.aucT = Date.now(); sendTo(p.ws, { t: 'aucwin', round: w.round, amt: w.amt });
}
setInterval(aucTick, 30000);

// ---- leaderboard ----
// online: everyone on the river right now, richest first. allTime: the most money each name has ever had while online.
let ALL = {}; try { ALL = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')) || {}; } catch (e) { ALL = {}; }
let lbDirty = false;
function lbSeen(name, cash) {
  if (!name || name === 'Player') return; const k = name.toLowerCase(), cur = ALL[k];
  if (!cur || cash > cur.c) { ALL[k] = { n: name, c: cash, t: Date.now() }; lbDirty = true; }
}
function lbSnapshot() {
  const on = []; for (const [id, p] of players) if (posOf(p)) on.push({ id, n: nameOf(p), c: cashOf(p) });
  on.sort((a, b) => b.c - a.c);
  const all = Object.values(ALL).sort((a, b) => b.c - a.c).slice(0, 10).map(r => ({ n: r.n, c: r.c }));
  return { on: on.slice(0, 20), all };
}
setInterval(() => { if (players.size) broadcast(null, { t: 'lb', lb: lbSnapshot() }); }, 2000);
setInterval(() => {
  if (!lbDirty) return; lbDirty = false;
  // keep the file small: the top 200 names
  const keep = Object.entries(ALL).sort((a, b) => b[1].c - a[1].c).slice(0, 200); ALL = Object.fromEntries(keep);
  fs.writeFile(LB_FILE, JSON.stringify(ALL), () => { });
}, 15000);

// drop dead connections and keep idle ones open through proxies
setInterval(() => {
  for (const [id, p] of players) {
    if (!p.ws.isAlive) { p.ws.terminate(); unraft(id, true); players.delete(id); broadcast(id, { t: 'bye', id }); continue; }
    p.ws.isAlive = false; try { p.ws.ping(); } catch (e) { }
  }
}, 20000);

server.listen(PORT, '0.0.0.0', () => console.log('Swan River Soaker online server on port ' + PORT));
