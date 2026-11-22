// Swan River Soaker – where the server keeps its data (leaderboard, seaplane auction, Splash Coins).
//
// It picks the first of these that is set up:
//   1. DATABASE_URL  – a Postgres database (any provider). Data survives restarts, redeploys and the free plan going to sleep.
//   2. DATA_DIR      – a folder on a persistent disk (Render paid plans: attach a disk and set DATA_DIR to its mount path).
//   3. nothing set   – files next to server.js. Fine on your own computer, but on Render's free plan these are WIPED
//                      every time the server sleeps (15 minutes with nobody online) or redeploys.
//
// Everything is loaded into memory once at start-up (await store.ready), read with store.load(key) and written with store.save(key, obj).
const fs = require('fs');
const path = require('path');

const URL_ = process.env.DATABASE_URL || '';
const DIR = process.env.DATA_DIR || '';
const mode = URL_ ? 'postgres' : DIR ? 'disk' : 'local';
const folder = DIR || __dirname;
const cache = new Map();
const timers = new Map();
let pool = null, chain = Promise.resolve();

const fileOf = key => path.join(folder, key + '.json');
const oldFile = key => path.join(__dirname, key + '.json');
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

async function init() {
  if (mode === 'postgres') {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1|sslmode=disable/.test(URL_);
    pool = new Pool({ connectionString: URL_, ssl: local ? false : { rejectUnauthorized: false }, max: 3, keepAlive: true });
    await pool.query('CREATE TABLE IF NOT EXISTS soaker_kv (k text PRIMARY KEY, v jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())');
    const r = await pool.query('SELECT k, v FROM soaker_kv');
    for (const row of r.rows) cache.set(row.k, row.v);
  } else {
    if (mode === 'disk') try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { }
    for (const f of (() => { try { return fs.readdirSync(folder); } catch (e) { return []; } })()) if (f.endsWith('.json') && /^(leaderboard|auction|splash)\.json$/.test(f)) { const v = readJson(path.join(folder, f)); if (v) cache.set(f.slice(0, -5), v); }
  }
  // first run on new storage: bring across anything still in the old files next to server.js
  if (mode !== 'local') for (const key of ['leaderboard', 'auction', 'splash']) if (!cache.has(key)) { const v = readJson(oldFile(key)); if (v) { cache.set(key, v); write(key); } }
  console.log('[storage] using ' + (mode === 'postgres' ? 'Postgres (DATABASE_URL)' : mode === 'disk' ? 'persistent disk at ' + folder : 'local files (wiped when Render\'s free plan sleeps; set DATABASE_URL or DATA_DIR to keep data)'));
}

function write(key) {
  const v = cache.get(key); if (v === undefined) return;
  if (mode === 'postgres') {
    const json = JSON.stringify(v);
    chain = chain.then(() => pool.query('INSERT INTO soaker_kv (k, v, updated) VALUES ($1, $2::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()', [key, json])).catch(e => console.error('[storage] save failed for ' + key + ':', e.message));
  } else {
    const f = fileOf(key), tmp = f + '.tmp', json = JSON.stringify(v);
    fs.writeFile(tmp, json, err => { if (err) return console.error('[storage] save failed for ' + key + ':', err.message); fs.rename(tmp, f, () => { }); });
  }
}

const ready = init().catch(e => { console.error('[storage] could not start (' + e.message + '). Check DATABASE_URL / DATA_DIR. Falling back to memory only for now.'); });

module.exports = {
  mode, ready,
  load(key) { return cache.has(key) ? cache.get(key) : null; },
  save(key, obj, delay = 300) { cache.set(key, obj); clearTimeout(timers.get(key)); timers.set(key, setTimeout(() => { timers.delete(key); write(key); }, delay)); },
  flush() { for (const [key, t] of timers) { clearTimeout(t); write(key); } timers.clear(); return chain; }
};
