"use strict";
const path = require("path");
const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 32);
const peers = new Map();

app.disable("x-powered-by");
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index-online.html")));
app.get("/health", (_req, res) => res.json({ ok: true, players: peers.size, maxPlayers: MAX_PLAYERS }));

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 8192 });
function send(ws, obj) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj, except) {
  const raw = JSON.stringify(obj);
  for (const p of peers.values()) if (p.ws !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
}
function cleanPresence(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return {};
  const out = {};
  const nums = ["x","z","y","h","sp","pt","rl","st","fl","tr"];
  for (const k of nums) if (Number.isFinite(Number(d[k]))) out[k] = Math.max(-100000, Math.min(100000, Number(d[k])));
  out.g = d.g === 1 ? 1 : null; out.v = d.v === 1 ? 1 : 0;
  out.id = String(d.id || "spark").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  out.n = String(d.n || "Player").replace(/[^A-Za-z0-9 _.\-]/g, "").trim().slice(0, 14);
  return out;
}

wss.on("connection", (ws) => {
  if (peers.size >= MAX_PLAYERS) { ws.close(1013, "server full"); return; }
  const id = crypto.randomBytes(8).toString("hex");
  const peer = { id, ws, presence: {}, windowStart: Date.now(), count: 0 };
  peers.set(id, peer);
  send(ws, { type: "welcome", id, peers: [...peers.values()].filter(p => p.id !== id).map(p => ({ id: p.id, presence: p.presence })) });

  ws.on("message", raw => {
    const now = Date.now();
    if (now - peer.windowStart > 1000) { peer.windowStart = now; peer.count = 0; }
    if (++peer.count > 35) return;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "presence") return;
      peer.presence = cleanPresence(msg.data);
      broadcast({ type: "presence", id, data: peer.presence }, ws);
    } catch (_) {}
  });
  ws.on("close", () => { peers.delete(id); broadcast({ type: "leave", id }); });
  ws.on("error", () => {});
});

setInterval(() => {
  for (const p of peers.values()) {
    if (p.ws.isAlive === false) { p.ws.terminate(); continue; }
    p.ws.isAlive = false; p.ws.ping();
  }
}, 30000).unref();
wss.on("connection", ws => { ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; }); });

server.listen(PORT, "0.0.0.0", () => console.log(`Swan River Soaker server running on port ${PORT}`));
