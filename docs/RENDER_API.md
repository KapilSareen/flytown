# Render API — what the world exposes to a renderer

The simulation lives in `app/src/world/`. A renderer (Pixi in `src/render/`, Three.js in
`src/render3d/`) reads the live world state every frame and never mutates it. The React HUD
reads the zustand store (12 Hz snapshots) instead; both views share the same field names.

```ts
import { getWorld, startWorld, type WorldState } from '../world/world';
const world = await startWorld();      // idempotent; App.tsx already calls it
// per frame:
const w = getWorld()!;                 // same object for the whole session
```

## How behaviour is produced (so the animation matches the intent)

```
brain outputs (12 channels, 0..1)  --EMA 1.5 s + body state-->  drives (drives.ts)
drives  --score, hysteresis, 8-40 s commitment-->  goal (goals.ts)
goal    --state machine with phases + timers-->  action / actionPhase / motion request
motion  --A* path, steady pace, collision-->  x, y, heading, speed (world.ts)
```

Drives are the brain's readouts, smoothed and modulated by the body; they choose goals, they
are never per-frame reflexes. God actions start goals directly (`forced`).

## `WorldState` (live, mutated at 60 Hz by the world loop)

| field | type | meaning |
|---|---|---|
| `agents` | `Agent[]` | all citizens (spawn order; ids stable, never reused) |
| `city` | `City` | static town geometry (below) |
| `time` | s | world seconds (scaled by the speed multiplier) |
| `hour` | 0..24 | time of day; a game day is 360 real s at speed 1 (1 game hour = 15 s) |
| `day` | int | day counter |
| `daylight` | 0..1 | `daylightAt(hour)`: sunrise 5.5–7.5, sunset 18–20 |
| `fx` | `Fx[]` | one-shot effect queue `{ kind: 'hearts'|'sparks'|'puff'|'godRing'|'flash', x, y, id? }`. Drain it (`w.fx.length = 0`) each frame after emitting particles. `sparks` = a landed punch (at the victim), `hearts` = bond / sitting together, `puff` = grooming start, `godRing` = a god action on citizen `id`. |
| `seatOwner` | `(id \| null)[]` | occupant of each `city.seats[i]` |
| `fps` | number | measured by the world loop |
| `brain.kind` | `'mock' \| 'lif'` | which brain is running |

Sun/shadow helpers in `src/render/daynight.ts` (`sunAt(hour)` → shadow angle/length, tint,
night strength) are renderer-agnostic.

## `Agent` (`src/world/agent.ts`)

| field | type | meaning |
|---|---|---|
| `id`, `name`, `sex` | | `sex: 'male' \| 'female'` |
| `x`, `y` | px | feet position; world is 2400 × 1600, y down |
| `heading` | rad | movement direction (0 = +x, π/2 = +y) |
| `facing` | rad | where the body should face: partner/opponent/table during interactions, else `heading` |
| `speed` | px/s | signed along heading; max walking speed 80 |
| `speedNorm` | 0..2.5 | `|speed| / 80` for walk-cycle blending (>1 = dash) |
| `goal` | `GoalState \| null` | `goal.name`, `goal.phase`, `goal.partner`, `goal.spot`, `goal.forced` |
| `action` | `Action` | `'idle'|'walk'|'eat'|'groom'|'sing'|'court'|'fight'|'escape'|'sleep'|'backup'|'hurt'` |
| `actionT` | s | seconds since `action` last changed (phases do not reset it) |
| `actionPhase` | string | sub-phase (table below) |
| `motion` | `Motion` | `{mode:'stand'|'path'|'direct'|'dash'|'orbit', …}` — what the legs are doing |
| `face` | `Pt \| null` | point the citizen turns toward while standing |
| `target` | id \| null | partner/opponent id while interacting |
| `bondWith` | id \| null | "in love" partner (walk together, sit together; lasts ~2 game hours) |
| `seat` | index \| null | `city.seats` index while eating |
| `hurtUntil` | s | `time < hurtUntil` ⇒ flash the body (a blow just landed) |
| `threat` | `Pt \| null` | what a flee is running from |
| `body` | `{hunger,dust,energy,injury}` | 0..1 |
| `drives` | `Drives` | `hunger, cleanliness, romance, hostility, fear, fatigue, social, wander` (0..1) |
| `palette` | `{skin,hair,top,bottom}` | CSS hex, curated 12-set |
| `hairStyle` | 0..5 | crop, side part, curly, bob, long, bun |
| `home` | `Pt` | sidewalk spot in front of their house |
| `radius` | px | 10 (citizen–citizen circle) |

`CitizenView` in the store mirrors `goal` (name), `actionT`, `actionPhase`, `speedNorm`,
`facing`, `drives`, `thought` and the body/palette fields.

### Goals and their phases (`goal.name` → `action/actionPhase` sequence)

| goal | phases | notes |
|---|---|---|
| `wander` | `walk/walk` → `idle/lookAround` (2–6 s) | stroll to a time-of-day POI at pace 0.6; bonded followers use `walk/together`, `idle/together` |
| `eatOut` | `walk/approach` → `idle/sit` (1.5 s) → `eat/eat` (15–25 s) → `idle/sit` (linger 5 s) → `walk/leave` | claims a `city.seats` chair (facing its table); market = standing slot: `approach` → `eat` → `leave`. Events "X sits down at …" / "X grabs a bite at …" / "X finishes lunch". Bonded partners take the same table. |
| `groom` | `walk/approach` (step aside to a bench) → `groom/groom` (4–6 s) | dust drains |
| `court` (male) | `walk/approach` → `sing/sing` (4–8 s, facing her) → `court/dance` (3 s, orbits her at 28 px) → bond ; or → `idle/turnedDown` (3 s) | events "X sings to Y", "X got turned down by Y", "X and Y fell in love" |
| `courted` (female) | `idle/idle` → `idle/listen` (faces him) → `court/dance` | `singHeardUntil` is set while he sings |
| `bond` (both) | `walk/together` → `idle/sitTogether` (20 s on a park bench, hearts every 6 s) | then `bondWith` persists ~2 game hours while they stroll together |
| `confront` (both) | `walk/approach` (`idle/squareUp` for the one already there) → `fight/stare` (2 s, 30 px apart) → 3–5 exchanges: striker `fight/strike` (0.3 s lunge) → `fight/recoil`; victim `fight/guard` → `fight/stagger` (+ `hurtUntil`, knockback, `sparks`) → resolution: winner `idle/strut` (3 s), loser → `flee` | events "X and Y square up", "X punches Y", "X wins; Y flees" |
| `flee` | `escape/crouch` (0.12 s) → `escape/dash` (1.5 s; 6 s on panic) → `idle/lookBack` (1 s) | dash at 2.3 × max speed away from `threat` |
| `rest` | `walk/approach` (home or bench) → `sleep/lie` (2 s) → `sleep/sleep` → `sleep/wake` (2 s, stretch) | events "X heads home" / "X heads for a bench" |
| `chat` | `walk/approach` (lead) / `idle/listen` → `sing/talk` ⇄ `idle/listen` (turns 1.5–2.5 s, 6–10 s total) | "talking" = alternating song bubbles; event "X and Y chat" |
| `bar` | `walk/walk` → `idle/hangOut` (20–60 s, evenings) | chats start between people hanging out |
| `festival` | `walk/walk` → party: `sing/talk` \| `sing/sing` \| `court/dance` bouts of 3–6 s | dance beat: 120 bpm on `actionT` |
| — | `hurt/hurt` | punish / stray hit while not fighting |

## `City` (`src/world/city.ts`) — static geometry (px)

| field | type | meaning |
|---|---|---|
| `w`, `h` | 2400, 1600 | world size |
| `margin` 50, `roadW` 60, `sidewalkW` 26 | | layout constants |
| `blocks` | `Block[]` | 4 × 3 grid; `{x,y,w,h,col,row,kind:'buildings'|'plaza'|'park', inner}` |
| `roadsH`, `roadsV` | `Rect[]` | asphalt strips; the block rects are sidewalks |
| `buildings` | `Building[]` | `{x,y,w,h, kind:'house'|'shop'|'cafe'|'market'|'bar'|'kiosk', roof:'terracotta'|'flat'|'green'|'glass'|'shop', floors, color, door:{x,y}, name?}`; `door` is on the sidewalk-facing edge; venue terrace POIs sit ~34 px outside the door |
| `food` | `Poi[]` | `[Café Lumen, Café Ombra, Corner Market]`; index = `Seat.venue` |
| `seats` | `Seat[]` | `{x, y, venue, table, facing, standing}` — café chairs (2 per table, 3 tables per café, chair 12 px from its table) and 5 standing market slots; place chairs/tables exactly here |
| `obstacleBuckets` | `Obstacle[][]` | the same obstacles bucketed on a 120 px hash (`bucketIndex(x, y)` from city.ts); use `obstacles` for placement |
| `obstacles` | `Obstacle[]` | everything citizens cannot walk through: `{kind:'rect', tag, x,y,w,h}` or `{kind:'circle', tag, x,y,r, venue?, table?}` with `tag ∈ building|fountain|pond|tree|lamp|bench|planter|table|stall`. Props must be placed exactly at these (tree trunk r 4, lamp post r 3, bench 24×8, planter 24×12, table r 6, fountain basin r 33, pond ellipse approximated by r·0.85) |
| `bar` | `Poi` | evening attractor (terrace of The Giant Fibre) |
| `garbage`, `benches`, `fountain`, `pond`, `trees`, `lamps`, `planters`, `bikeracks` | `Poi[]` | props (`r` = canopy radius for trees, light radius for lamps) |
| `plazaCenter`, `parkCenter` | `Pt` | |
| `pois` | `Poi[]` | all of the above in one list (`kind` discriminates) |
| `grid` | `Uint8Array` | walkability at `CELL` = 20 px: 0 blocked, 1 sidewalk, 2 road, 3 park; `GRID_W × GRID_H` = 120 × 80. Blocked from `obstacles` |

Helpers: `walkable(city,x,y)`, `cellAt`, `inRect`, `findPath(city, from, to)` (`pathing.ts`).

## Store publishing and telemetry

- `store.citizens` is published at 6 Hz and only when something visible changed; each
  `CitizenView` object is cached per citizen and keeps its reference while its visible state
  (position to 1 px, action/phase/goal, body to 0.01, drives to 0.05, thought, …) is unchanged,
  so memoized rows skip. `inputs`/`outputs` are copied only for the selected citizen; everyone
  else carries a shared empty buffer. `drives` is a fresh small object when it changed.
- `timeOfDay`, `day`, `fps`, `perf` are published in a separate `set` at 4 Hz; `focus` only
  when the report object changes.
- `window.__world.perf` (browser) / `world.perf` (headless): EMA ms per step for `senses`,
  `brain` (pool call + drives), `goals`, `move`, `collision`, `body`, `stepTotal`, plus `publish`
  ms, `frameMs`, `steps` and cumulative `pathPlans`. Headless (mock brain): 0.08 ms/step at 14
  citizens, 0.15 ms/step at 30. The loop caps catch-up at 3 fixed steps per frame.
- Live renderers should read `world.agents` directly (60 Hz), not the store snapshots.

## Collision guarantees (world.ts)

- Citizen–citizen: hard circle separation (r 10) with yielding: the faster one takes the push,
  standers hold, seated diners are immovable; walkers also sidestep people ahead of them.
- Citizen–obstacle: after every step each citizen is clamped out of every `obstacle` (body r 8);
  a diner ignores only their own table, a market eater only the stall.
- Path following re-plans when blocked for 1 s and gives up (stands) if blocked again within 4 s.
- `src/world/collision.test.ts` asserts zero penetrations and no pair closer than 8 px over 2 game hours.

## Camera and selection (store, not world)

`useStore.getState()` gives `selectedId`, `followId`, `cameraMode: 'god' | 'follow'`,
`paused`, `speed`, `brainSpeed`, `timeOfDay`, `day`. A renderer owns its camera and should
honour `cameraMode`/`followId` (lock on that citizen, zoom in, lead in the heading direction)
and call `worldApi.select(id)` / `worldApi.follow(id)` on click / double-click; dragging or
wheeling in follow mode should call `worldApi.setCameraMode('god')`. `src/render/camera.ts` is
a reference implementation.

## Events

`store.events` (last 200): `{ id, t, kind, text, actors }`, kinds
`love | fight | eat | escape | groom | sleep | sing | god | info`. God actions: `fight`, `love`,
`feed`, `scare`, `dust`, `sleep`, `riot(around, radius)`, `festival()`, `loveWave()`,
`panic(around)`, `calm()`, `reward`, `punish`, `inject`, `silence`, `modulate`, `spawn`, `remove`.

## Three.js renderer conventions (`src/render3d/`)

World `(x, y)` maps to scene `(x, z)`; up is `+y`; 1 world px = 1 scene unit. Citizens are
~50 units tall (1.25x stylised); buildings 60–180. The renderer places props **only** where the
city geometry puts them, so `city.obstacles` already covers everything a citizen could bump:
chairs on every `city.seats` entry (rotated to `facing`), one table + parasol per `(venue, table)`
12 px in front of the chairs (= the `table` obstacle), the market stall on the `stall` obstacle
rect, benches rotated toward the nearest of plaza/park centre (still 24 × 8), fountain basin
r 33, trees / lamps / planters / bike racks on their POIs. Extras that are visual only and sit
inside existing obstacles: café awnings over doors, the neon sign, garbage bins at
`garbage[0] + (−10, +6) / (−22, +8)` (r 5, on the sidewalk corner), and festival light poles
at the plaza's `inner` corners (inset 8, r 1.5) plus a mast on the fountain.

Animation reads `action`, `actionPhase`, `actionT`, `speedNorm`, `facing`, `hurtUntil`,
`seat` (a `city.seats` index while eating: chair → seated poses, `standing` → pick-and-bite at
the stall) and these phase names: fight `approach|circle|stare|guard|strike|recoil|stagger|flee`,
idle `listen|bond|strut|sit|sitTogether|squareUp|hangOut|turnedDown|lookBack|lookAround`,
sing `sing|talk` (no song ring for `talk`), court `approach|circle|dance|bond`, escape
`crouch|dash`, sleep `lie|sleep|wake`, eat-out `approach|sit|eat|linger|leave`. Unknown phases
fall back to the action's default pose. Festival string lights switch on
when the world exposes `festivalUntil > time` or `crowdEvent.kind === 'festival'` (optional
fields, read if present) or when 4+ citizens are in the `dance` phase.
