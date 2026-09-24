# Repository Guidelines

## Project Overview

This is a browser Tetris app with singleplayer and two-seat realtime multiplayer. `spec.txt` is the original design journal. The multiplayer room service is a Cloudflare Worker and Durable Object; gameplay still runs locally. Do not add accounts, a second networking backend, or extra modes without a concrete requirement.

## Architecture & Data Flow

`app/page.tsx` mounts client-side `components/GameSession.tsx`, which switches between singleplayer and multiplayer, owns sound preferences and event feedback. `components/GameView.tsx` owns the singleplayer HUD, preview rails, and overlays; `components/MultiplayerSession.tsx` owns room identity, reconnection, snapshot transport, and match lifecycle; `components/MultiplayerView.tsx` renders lobby, countdown, two boards, touch controls, and results. `src/controller/gameController.ts` owns input and fixed-step scheduling; `src/game/engine.ts` owns deterministic gameplay and emits explicit `GameEvent` snapshots. `worker/index.ts` handles HTTP/WebSocket entry; `worker/room.ts` persists room authority, countdowns, outcomes, and delayed garbage in a Durable Object. The engine has no DOM, React, storage, or network dependency.

## Key Directories

`app/` contains the Next route, layout, and global tokens. `components/` contains the client lifecycle bridges and responsive views. `src/game/` contains shared contracts, engine, and rules tests; `src/controller/` contains input/timing and tests; `src/multiplayer/` contains the wire protocol and browser transport; `src/render/` contains canvas drawing/effects; `src/presentation/` contains feedback contracts and audio; `worker/` contains Cloudflare room authority.

## Development Commands

Use Node 22+ and npm: `npm ci`, `npm run dev` (web app at `http://localhost:3000`), `npm run dev:multiplayer` (local Worker at `http://localhost:8787`), `npm test`, `npm run typecheck`, `npm run build`, and `npm run start` (after build). Singleplayer works without the Worker. Local multiplayer needs both dev processes; production uses the deployed `tetris-multiplayer.generalmalit07.workers.dev` Worker by default. `NEXT_PUBLIC_MULTIPLAYER_API_URL` overrides that endpoint when building another frontend. The Worker `ALLOWED_ORIGIN` in `wrangler.jsonc` permits the exact production Vercel origin; update it if the web origin changes.

## Code Conventions & Common Patterns

Keep the engine rules independent of rendering and wall time. The engine mutates its `GameState`; controller subscribers receive the same object, so React bridges shallow-copy the outer state before `setGame`. Board rows 0–1 are hidden spawn rows; 2–21 are visible. Once a piece first contacts the ground, its 500 ms lock timer keeps running through airborne floor kicks; successful grounded transforms can reset it at most 15 times. `createGame(seed)` gives reproducible seven-bag runs; ordinary solo games get a new seed in the controller, and multiplayer rounds use a shared server seed. Canvas is rendered from state, never used to decide collisions. Preserve keyboard focus rules, singleplayer blur-to-pause, multiplayer no-pause, and listener/RAF disposal. Styling uses component CSS modules plus tokens in `app/globals.css`.

Keep the frame tight to the 10×20 canvas and Hold/Next shapes centered by occupied bounds inside black wells. Both multiplayer boards show Hold and the next five pieces; snapshots carry `held` and five `queue` entries. Presentation consumes controller `subscribeEvents`; never infer clears from score deltas. Clear-row coordinates precede compaction and include hidden rows. Combo counts consecutive clearing placements and adds no scoring bonus. Clear transient effects on pause/restart/game-over; stop effect RAFs when idle. Respect reduced motion. Music and SFX have independent 0–100 controls, default off, and must not create/resume an audio context outside a user gesture. Storage/audio failures must leave gameplay usable.

Multiplayer identities use sessionStorage reconnect tokens and localStorage display names. The Durable Object decides seats, readiness, start, winner, rematch, and garbage; each browser sends validated board snapshots at four per second and locally simulates its seeded board. Clears emit placement-stamped attacks; incoming garbage cancels first, the rest arrives after five seconds in groups of at most four. Reconnect within ten seconds or forfeit; refreshed clients restore board and bag state. `src/multiplayer/protocol.ts` is the shared wire contract. Client simulation is trusted for clear claims, not server-authoritative anti-cheat.

## Important Files

- `src/game/contracts.ts`, `src/game/engine.ts` — board/state contract and deterministic gameplay rules.
- `src/controller/gameController.ts`, `src/render/canvasRenderer.ts` — time/input and read-only canvas paint.
- `components/GameSession.tsx`, `components/GameView.tsx`, `components/MultiplayerSession.tsx`, `components/MultiplayerView.tsx` — browser lifecycle and player UI.
- `src/multiplayer/protocol.ts`, `src/multiplayer/client.ts`, `worker/index.ts`, `worker/room.ts`, `wrangler.jsonc` — wire contract, client transport, and room service.
- `package.json`, `vitest.config.ts`, `tsconfig.json` — scripts, tests, and strict TypeScript.

## Runtime/Tooling Preferences

Next.js 16, React 19, TypeScript 5, Tailwind CSS 4, Vitest 5, Wrangler 4, and npm are checked in via `package.json`/`package-lock.json`. Use the lockfile (`npm ci`); do not add a second package manager or backend. Cloudflare credentials are only needed for deployment, not local `wrangler dev`.

## Testing & QA

Run `npm test` for engine/controller regressions and `npm run typecheck` plus `npm run build` before shipping. Browser QA covers solo gameplay and desktop/phone multiplayer: room create/join, ready countdown, two boards with Hold/Next previews, attacks and garbage, topout/winner, rematch, reconnect/forfeit, centered board proportions, and touch controls. Best score and audio levels use `tetris-best-score`, `tetris-music-volume`, and `tetris-sfx-volume` localStorage keys; the old `tetris-sound-enabled` key migrates only when volume keys are absent. Solo controls: arrows move/soft drop/rotate, X/Z rotate, Space hard drops, C holds, P/Escape pause. Multiplayer cannot pause, and its phone layout has on-screen controls.
