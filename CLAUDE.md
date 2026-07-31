# CLAUDE.md — context for agent sessions

## What this repo is

Two things live side by side:

1. **AI visualizations** (`src/pages/*.tsx` except `Ride.tsx`) — interactive explainers
   about neural networks and LLMs. Russian UI, English terms in parentheses. Each page:
   guided story → live sandbox → self-checking challenges. Do not break these.
2. **Starry Ride** (`src/game/**`, `src/pages/Ride.tsx`) — a first-person night-drive
   arcade game, route `/ride`. Modelled on a specific reference reel: neon light trails,
   red-glow Mercedes dashboard, morphing starry sky. Full spec: `docs/GAME.md`.

## Working on the game

**Read `PROGRESS.md` first.** It is the live checklist and the handoff point between
sessions — it says what is done, what is in flight, and what is next. Update it in the
same commit as the code it describes.

## Commands

```bash
npm install
npm run dev                     # vite dev server, :5173
npm run build                   # tsc -b && vite build — must pass clean before any commit
npm run preview                 # serve dist/ on :4173
node scripts/shoot.mjs          # Playwright screenshot sweep (needs preview running)
node scripts/ride-shoot.mjs     # game-specific: plays a run, shoots frames, dumps console errors
```

Chromium is preinstalled at `/opt/pw-browsers/`; never run `playwright install`.
`scripts/shoot.mjs` reads `CHROME_PATH`, `BASE_URL`, `OUT_DIR`.

## Conventions that matter

- TypeScript is `strict` **plus** `noUnusedLocals` / `noUnusedParameters` and
  `verbatimModuleSyntax` — type-only imports need `import type`. Unused params break
  the build, so prefix deliberately-unused ones with `_`.
- Tailwind 4, theme tokens in `src/index.css` (`bg`, `panel`, `edge`, `ink`, `muted`,
  `accent`, `hot`, `amber`, `ok`). Use tokens, not raw hex, in site chrome. The game is
  the exception: it has its own neon palette in `src/game/config.ts`.
- Hash routing (`HashRouter`) and `base: "./"` — the build must work from any subpath,
  so no absolute asset URLs.
- Comments in the codebase are Russian. Match that.
- Shared UI (`Layout`, `Card`, `Btn`, `Seg`, `SliderRow`) lives in `src/components/ui.tsx`.
  `ROUTE_ORDER` there drives prev/next navigation.
- No new runtime dependencies without a reason. Bloom uses `three/addons/postprocessing/*`,
  which ships with `three` and is typed by `@types/three`.

## Game architecture in one paragraph

State is **one mutable object** (`Game` in `src/game/types.ts`) held in a ref, never in
React state — the render loop must not re-render React. `engine.ts` mutates it (`step`),
scene components read it inside `useFrame` and push their own objects around. The HUD
samples it at ~12 Hz. The world scrolls past a camera parked at the origin: a point at
road distance `s` and lateral offset `lane` renders at
`(localX(s, lane, camS, camX), localY(...), localZ(s, camS))` from `road.ts`, so absolute
distance never enters float-sensitive math. Props (trees, lamps, town lights) are
**deterministic functions of a hashed cell index**, not stored state, so any module can
ask what is at distance `s` without synchronisation.
