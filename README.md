# Swan River Soaker – one game, Offline + Online

Everything is in this one folder:

```
index.html    the game (Offline and Online)
server.js     the online server (shares the river between players)
package.json  tells Render how to run it
render.yaml   Render's settings, filled in for you
```

## Put it on Render

These 4 files must be at the **top** of your GitHub repository, not inside a folder.
(If GitHub shows a folder you have to click into before you see `package.json`, Render can't find it.)

1. On github.com: open your repo → **Add file → Upload files** → drag in all 4 files → **Commit**.
   Delete any old copies inside folders.
2. On render.com, your service must be a **Web Service** (not a Static Site). Check:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Root Directory: leave **empty**
3. Press **Manual Deploy → Deploy latest commit**. When the log says
   `Swan River Soaker online server on port …` it's live.

Check it's running: open `https://swan-river-soaker-nsot-edition.onrender.com/health`. It shows `{"ok":true,...}`.

## Remaster Edition (newest)

**Bigger map:** the whole river and city are 1.5× bigger.

**Graphics**
- New **Max** setting (Settings → Graphics quality) renders at up to 2× resolution, so edges are sharp with no jaggies.
- On every setting the game picks the sharpest resolution your computer can run smoothly, and drops it a step if the frame rate falls.
- Real reflections on the water: buildings, boats, bridges and night lights show up in the river. Settings → Water reflections.
- Sharper clouds, grass and sand with real surface texture, longer view distance, and houses and trees all the way to the horizon.

**Perth landmarks**
- The CBD skyline along St Georges Terrace: Central Park, Brookfield Place, Bankwest Tower, QV1, Capital Square, Allendale Square, St Martins, Exchange Plaza and Council House.
- Matagarup Bridge, Crown Towers and Crown Metropol.
- Optus Stadium, now bronze, with an LED halo that lights up at night.
- The Old Mill, and the Elizabeth Quay bridge with the Spanda sculpture.
- The Mill Point Road towers in South Perth.
- Kings Park: the Fraser Avenue gums, the DNA Tower and the Federation Walkway.
- Cottesloe: the Indiana Tea House, the Norfolk pines and the groyne.

**Small details**
- Foreshore paths with lamps, benches, bins, palms and BBQs.
- Whole suburbs with streets, driveways, backyard pools and gardens.
- Red and green channel markers, and boats on swing moorings in the bays.
- Grass, reeds and limestone rocks along the banks.
- Black swans, pelicans, river dolphins, kayakers and stand-up paddlers.
- A Transperth ferry running between Elizabeth Quay and Mends Street.

**Smarter characters**
- Boats slow down near the banks (8-knot zone) and keep right when they meet head-on.
- Boats work out where you're heading and steer clear. Some race you, and their crews wave.
- People stop to film or wave when you rip past, run off after a soaking, step around each other and stop for a chat.
- Cars give way at intersections. The ferry gives way to you and waits at each jetty.

**Side camera:** press **P** to cycle the cameras to **Side**. It shows your jet ski, boat or seaplane side-on from a distance. **O** flips to the other side, the mouse wheel zooms in and out, and dragging the mouse orbits around.

**Graphics + frame rate update**
- Clouds are now proper puffy cumulus with sunlit tops and grey bases.
- The water is deeper blue, with a sparkling sun-glitter path and finer ripples.
- The sun has glare and a lens flare, the colours are warmer, white water churns behind the hull, and street lamps glow at night.
- The rooster tail is a powerful jet now: thick at the nozzle, widening as it climbs, curling over into a crown at the top and falling as a see-through curtain of spray, with haze rolling out over the water. Full trim now goes up to a steep ~62° fountain (it used to stop at 46°); mid trim is the same as before and the longest shot (~45°) sits just below full trim.
- Online, other players (and distant riders) show one rooster tail instead of three.
- The game is smoother. Each frame does far less work and scenery loads in small pieces, so there's less stutter. If your computer can't hold 60 fps, the resolution drops a little automatically.

**On a slow computer:** set Graphics quality to Medium or Low, or turn off Water reflections or Extra ground detail in Settings.

Note: everyone playing online needs the new version, because the bigger map moves every position. Deploy it the same way as before (steps above).

## What's new in the Final Edition

- **Online:** chat with anyone within 80 m (Enter), interact with a nearby player (G): raft up, give items or cash, mute.
  Spraying another player takes their money and gives it to you. The 🏆 leaderboard shows the richest players online and all-time; press L to hide it and just see who is online along the bottom.
- **White jet ski:** promo code `WHITE`. It's the Tuned Up in all white, does 500 km/h and has a rooster tail twice as big as any other.
- **Promo code `400`:** +$400,000 (once per save).
- **Fishing:** hold Space to charge your cast, bites come faster, and you fight fish on a catch bar. Sell, keep (cooler) or release.

Note: the all-time leaderboard is saved on the server, but Render's free plan wipes it when the server restarts or you redeploy.

## New: boats, seaplane and passengers

- **Aurum 72 super yacht** ($10M, 130 km/h, 72 m long). While it's equipped, getting sprayed online never costs you money.
- **Naiad 11.2 RIB** ($4M, twin 450 HP Yamahas, 325 km/h).
- **Seaplane:** win it in the garage auction (starts at $5M, runs 6 days, highest bid wins and the money disappears) or use code `seaplane69`.
  On the water hold ↓ past idle to reverse and steer with A/D. Flying: ↑/↓ throttle, W nose down, S nose up, A/D roll, P camera. Take off past ~120 km/h by holding S. Land on water only.
- **Passengers:** raft up, then G → Invite aboard. The owner drives; the KICK button at the bottom sends them back to their own vehicle. Passengers press G to leave.
- **Blue underwater lights** on every boat at night.
- **Code `67`:** +$5,000,000, use it as many times as you like.

Note: the auction runs on the server. Render's free plan can wipe saved bids when the server restarts or you redeploy, but the 6-day timer keeps going.

## Splash Coins (real money)

10 Splash Coins = $100,000 in game. Packs: 10 for $0.50, 50 for $1.00, 100 for $1.50, 500 for $4.50 (AUD).
Players buy them in the Splash Store (the 💧 counter under your cash, or the banner at the top of the garage) and swap them for cash.
Payments go through Stripe. Coins are stored on the server, not in the player's save file.

To switch payments on:
1. Create a Stripe account at stripe.com (you must be 18+, so a parent needs to own the account). Add the bank account the money should be paid into.
2. In Stripe go to Developers → API keys and copy the Secret key.
3. In Render open your service → Environment and add `STRIPE_SECRET_KEY` = that key. Start with the test key (sk_test_...) and pay with card 4242 4242 4242 4242 to try it.
4. (Recommended) In Stripe go to Developers → Webhooks → Add endpoint `https://YOUR-SITE.onrender.com/stripe/webhook` with the event `checkout.session.completed`. Copy its signing secret into Render as `STRIPE_WEBHOOK_SECRET`.
5. When everything works, swap the test key for the live key (sk_live_...).

`SPLASH_DEMO=1` makes purchases free and fake for trying things out. Never set it on the live game.

## Playing

- **Offline** works anywhere, even just opening `index.html` on its own.
- **Online** on the Render site drops you into the shared river. From anywhere else it takes you to the Render site first.
- Free Render sites sleep when nobody plays. The first load after that can take about a minute.
