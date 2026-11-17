# Swan River Soaker Online Server

## Run locally
1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Run `npm start`.
4. Open `http://localhost:3000` on each device on the same network.

## Deploy free
Upload these files to a Node.js host that supports WebSockets, such as Render. Use `npm install` as the build command and `npm start` as the start command. The server allows 32 connected players by default. Set the `MAX_PLAYERS` environment variable to change the hard cap.

Offline mode is unchanged and does not connect to the server. Online mode connects to `/ws` on the same host as the game.
