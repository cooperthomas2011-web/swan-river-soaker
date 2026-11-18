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

const PORT = process.env.PORT || 3000;
// the game sits next to this file (index.html); a public/ folder also works
const PUBLIC = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, 'public');
const SKIP = new Set(['server.js', 'package.json', 'package-lock.json', 'render.yaml', 'README.md', 'leaderboard.json']);
const MAX_PLAYERS = 40;
const CHAT_RANGE = 80;   // metres: how close you must be to hear someone
const GIFT_RANGE = 30;   // metres: how close you must be to hand something over
const RAFT_RANGE = 25;   // metres: how close you must be to raft up
const SOAK_RANGE = 140;  // metres: the furthest a stream can possibly reach (big rooster tails)
const LB_FILE = path.join(__dirname, 'leaderboard.json');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, players: players.size })); }
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
  const me = { ws, presence: null, raft: null, lastP: 0, lastChat: 0, chatBurst: 0, soakT: new Map(), raftAsk: new Map() };
  players.set(id, me);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // tell the new player who is already on the river
  const others = [];
  for (const [pid, p] of players) if (pid !== id && p.presence) others.push([pid, p.presence]);
  sendTo(ws, { t: 'hello', id, peers: others, lb: lbSnapshot() });

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();
    switch (m.t) {
      case 'p': { // presence (position etc.)
        if (now - me.lastP < 30) return; me.lastP = now; // max ~33 updates/s per player
        if (typeof m.d !== 'object' || m.d === null) return;
        me.presence = m.d; if (m.d.g === 1) lbSeen(nameOf(me), cashOf(me));
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
  ws.on('close', () => { unraft(id, true); players.delete(id); broadcast(id, { t: 'bye', id }); });
  ws.on('error', () => { });
});

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
