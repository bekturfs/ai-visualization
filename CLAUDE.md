# CLAUDE.md — context for agent sessions

## What this repo is

**Starry Ride** — a first-person night-drive arcade game in the browser, and nothing
else. Modelled on a reference reel: neon light trails, a red-glow instrument cluster,
a starry sky that morphs between chapters. Full spec: `docs/GAME.md`.

The repo previously held a set of AI/neural-network visualizations. They were deleted
deliberately, on the owner's explicit instruction, and live on in git history (branch
`master`, up to commit `69eee4b`). Do not resurrect them unless asked.

**Read `PROGRESS.md` first.** It is the live checklist and the handoff point between
sessions — what is done, what is in flight, what is next. Update it in the same commit
as the code it describes.

## Commands

```bash
npm install
npm run dev                     # vite dev server, :5173
npm run build                   # tsc -b && vite build — must pass clean before any commit
npm run preview                 # serve dist/ on :4173
npm run shots                   # scripts/ride-shoot.mjs — needs preview running
```

Chromium is preinstalled at `/opt/pw-browsers/`; never run `playwright install`.
`scripts/ride-shoot.mjs` reads `CHROME_PATH`, `BASE_URL`, `OUT_DIR`, `QUICK=1`. It
launches with SwiftShader flags because headless has no GPU, plays a real run, and
exits non-zero if it saw a console error, a dead WebGL context or horizontal overflow
on a 390px viewport.

Typecheck one file in isolation (useful while a module is being written):

```bash
npx tsc --noEmit --strict --noUnusedLocals --noUnusedParameters \
  --target ES2022 --module ESNext --moduleResolution bundler \
  --lib ES2022,DOM,DOM.Iterable --jsx react-jsx --skipLibCheck \
  --verbatimModuleSyntax --moduleDetection force --allowImportingTsExtensions <FILE>
```

## Conventions that matter

- TypeScript is `strict` **plus** `noUnusedLocals` / `noUnusedParameters` and
  `verbatimModuleSyntax` — type-only imports need `import type`, and a deliberately
  unused parameter must start with `_`.
- Tailwind 4, theme tokens in `src/index.css` (`bg`, `panel`, `edge`, `ink`, `muted`,
  `accent`, `hot`, `amber`, `ok`), repainted for the night palette. The neon values the
  scene uses live in `src/game/config.ts` — that file is the single source of truth for
  colour, and nothing should hardcode a hex that belongs there.
- `base: "./"` — the build must work from any subpath, so no absolute asset URLs.
  There is no router: `src/main.tsx` renders `src/Ride.tsx` directly.
- Comments in Russian, identifiers in English. Match that.
- **No assets, ever.** No images, audio files, fonts or models. Textures are drawn to a
  canvas at startup; sound is synthesised in WebAudio. If a change would add a binary
  file, find another way.
- No new runtime dependencies. Bloom uses `three/addons/postprocessing/*`, which ships
  with `three` and is typed by `@types/three`.

## Architecture in one paragraph

State is **one mutable object** (`Game` in `src/game/types.ts`) held in a ref, never in
React state — the render loop must not re-render React. `engine.ts` mutates it (`step`),
scene components read it inside `useFrame` and move their own objects, the HUD samples it
at ~12 Hz, and the dashboard needles are driven straight from refs in a rAF loop. The
world scrolls past a camera parked at the origin looking down −Z: a point at road
distance `s` and lateral offset `lane` renders at `(localX(s, lane, g.s, g.x),
localY(s, y, g.s), localZ(s, g.s))` from `road.ts`, so absolute distance never enters
float-sensitive math. Scenery is a **deterministic function of a hashed cell index**, not
stored state, so any module can ask what is at distance `s` without synchronisation.
Modules never import each other — only `types` / `config` / `road` / `rng` / `num` — and
the two places that would need to (engine→worldGen, scene→worldGen) are bridged in
`Ride.tsx` via `setWorldHook` and generator props.
