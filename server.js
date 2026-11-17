// Swan River Soaker – online server
// Serves the game (public/index.html) and runs the shared river:
// every player sends their position ~15 times a second and the server passes it on to everyone else.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// the game sits next to this file (index.html); a public/ folder also works
const PUBLIC = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, 'public');
const SKIP = new Set(['server.js', 'package.json', 'package-lock.json', 'render.yaml', 'README.md']);
const MAX_PLAYERS = 40;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, players: players.size })); }
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
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
const players = new Map(); // id -> { ws, presence }
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function sendTo(ws, msg) { if (ws.readyState === 1) ws.send(msg); }
function broadcast(fromId, obj) { const msg = JSON.stringify(obj); for (const [id, p] of players) if (id !== fromId) sendTo(p.ws, msg); }

wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'River is full'); return; }
  const id = newId();
  players.set(id, { ws, presence: null });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // tell the new player who is already on the river
  const others = [];
  for (const [pid, p] of players) if (pid !== id && p.presence) others.push([pid, p.presence]);
  sendTo(ws, JSON.stringify({ t: 'hello', id, peers: others }));

  let last = 0;
  ws.on('message', raw => {
    const now = Date.now(); if (now - last < 30) return; last = now; // max ~33 updates/s per player
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || m.t !== 'p' || typeof m.d !== 'object' || m.d === null) return;
    const p = players.get(id); if (!p) return;
    p.presence = m.d;
    broadcast(id, { t: 'p', id, d: m.d });
  });
  ws.on('close', () => { players.delete(id); broadcast(id, { t: 'bye', id }); });
  ws.on('error', () => { });
});

// drop dead connections and keep idle ones open through proxies
setInterval(() => {
  for (const [id, p] of players) {
    if (!p.ws.isAlive) { p.ws.terminate(); players.delete(id); broadcast(id, { t: 'bye', id }); continue; }
    p.ws.isAlive = false; try { p.ws.ping(); } catch (e) { }
  }
}, 20000);

server.listen(PORT, '0.0.0.0', () => console.log('Swan River Soaker online server on port ' + PORT));
