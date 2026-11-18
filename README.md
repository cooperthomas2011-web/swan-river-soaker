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

## What's new in the Final Edition

- **Online:** chat with anyone within 80 m (Enter), interact with a nearby player (G): raft up, give items or cash, mute.
  Spraying another player takes their money and gives it to you. The 🏆 leaderboard shows the richest players online and all-time; press L to hide it and just see who is online along the bottom.
- **White jet ski:** promo code `WHITE`. It's the Tuned Up in all white, does 500 km/h and has a rooster tail twice as big as any other.
- **Promo code `400`:** +$400,000 (once per save).
- **Fishing:** hold Space to charge your cast, bites come faster, and you fight fish on a catch bar. Sell, keep (cooler) or release.

Note: the all-time leaderboard is saved on the server, but Render's free plan wipes it when the server restarts or you redeploy.

## Playing

- **Offline** works anywhere, even just opening `index.html` on its own.
- **Online** on the Render site drops you into the shared river. From anywhere else it takes you to the Render site first.
- Free Render sites sleep when nobody plays. The first load after that can take about a minute.
