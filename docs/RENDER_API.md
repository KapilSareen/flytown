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

## `WorldState` (live, mutated at 60 Hz by the world loop)

| field | type | meaning |
|---|---|---|
| `agents` | `Agent[]` | all citizens (order = spawn order; ids are stable, never reused) |
| `city` | `City` | static town geometry (below) |
| `time` | s | world seconds (scaled by the speed multiplier) |
| `hour` | 0..24 | time of day; a game day is 360 real s at speed 1 |
| `day` | int | day counter |
| `daylight` | 0..1 | `daylightAt(hour)`: sunrise 5.5–7.5, sunset 18–20 |
| `fx` | `Fx[]` | one-shot effect queue: `{ kind: 'hearts'|'sparks'|'puff'|'godRing'|'flash', x, y, id? }`. The renderer drains it (`w.fx.length = 0`) each frame after emitting particles. `sparks` = a landed punch (at the victim), `hearts` = bond, `puff` = grooming start / dust, `godRing` = a god action on citizen `id`. |
| `fps` | number | measured by the world loop |
| `brain.kind` | `'mock' \| 'lif'` | which brain is running |

Sun/shadow helpers in `src/render/daynight.ts` (`sunAt(hour)` → shadow angle/length, tint,
night strength) are renderer-agnostic and may be reused.

## `Agent` (`src/world/agent.ts`) — fields a renderer needs

| field | type | meaning |
|---|---|---|
| `id`, `name`, `sex` | | `sex: 'male' \| 'female'` |
| `x`, `y` | px | world position of the feet; world is 2400 × 1600, y down |
| `heading` | rad | movement direction (0 = +x, π/2 = +y) |
| `facing` | rad | where the body should face: toward the opponent/partner in fights and courtship, otherwise `heading` |
| `speed` | px/s | signed along heading (negative = backing up); `maxSpeed` = 80 |
| `speedNorm` | 0..2 | `|speed| / 80` for walk-cycle blending (>1 when dashing/lunging) |
| `action` | `Action` | `'idle'|'walk'|'eat'|'groom'|'sing'|'court'|'fight'|'escape'|'sleep'|'backup'|'hurt'` |
| `actionT` | s | seconds since `action` last changed |
| `actionPhase` | string | sub-phase (table below) |
| `target` | id \| null | who they are courting / fighting / listening to |
| `bondWith` | id \| null | "in love" partner (they walk together for 60 s) |
| `hurtUntil` | s | `time < hurtUntil` ⇒ flash the body (a blow just landed) |
| `body` | `{hunger,dust,energy,injury}` | 0..1 each |
| `palette` | `{skin,hair,top,bottom}` | CSS hex strings from a curated 12-set |
| `hairStyle` | 0..5 | crop, side part, curly, bob, long, bun |
| `radius` | px | 10, for collision/selection |
| `vx`, `vy` | px/s | last-step velocity |
| `escapeFrom` | `{x,y}` \| null | what they are fleeing from |

### Action phases (`actionPhase`)

| action | phases (in order) | notes |
|---|---|---|
| `walk` | `walk` \| `approach` | `approach` when heading to food / a bench / a partner / a fight or courtship target |
| `idle` | `idle` \| `listen` \| `bond` | `listen`: a female standing still while being sung to (face `target`); `bond`: the 1.2 s after falling in love |
| `eat` | `eat` | on a food tile; lean forward + bob |
| `groom` | `groom` | hands to head; dust decreases |
| `sing` | `sing` | male, ~2.5 s, facing `target`; song ripples |
| `court` | `approach` → `sing` (as action `sing`) → `circle` → `bond` | `circle`: orbits the female at ~30 px for 2 s; `bond`: both face each other 1.5 s, hearts |
| `fight` | `approach` → (`strike` → `recoil`) / (`guard` → `stagger`) … | blows every 0.6 s; `strike` lasts 0.25 s then the blow lands on the other (`stagger`, `hurtUntil`, knockback, `sparks` fx); striker goes `recoil` 0.35 s; `guard` while waiting. Fight ends after ~6 s or 8 blows: loser gets `escape`, winner `idle` |
| `escape` | `crouch` (0.12 s) → `dash` | dash at 2.3 × max speed away from `escapeFrom`; motion streaks |
| `sleep` | `lie` (0.8 s) → `sleep` → `wake` (0.8 s) | lying on a bench (or in place after god.sleep); Z's during `sleep` |
| `backup` | `backup` | walking backwards briefly |
| `hurt` | `hurt` | flash/shake (punish, fight loss aftermath) |

`actionT` resets when `action` changes, not on phase changes; phases are short and their
durations are listed above if a renderer wants to normalise.

## `City` (`src/world/city.ts`) — static geometry (px)

| field | type | meaning |
|---|---|---|
| `w`, `h` | 2400, 1600 | world size |
| `margin` (50), `roadW` (60), `sidewalkW` (26) | | layout constants |
| `blocks` | `Block[]` | 4 × 3 grid; `{x,y,w,h,col,row,kind:'buildings'|'plaza'|'park', inner}`; `inner` = block minus sidewalk ring |
| `roadsH`, `roadsV` | `Rect[]` | road strips (asphalt); sidewalks are the block rects |
| `buildings` | `Building[]` | `{x,y,w,h, kind:'house'|'shop'|'cafe'|'market'|'bar'|'kiosk', roof:'terracotta'|'flat'|'green'|'glass'|'shop', floors:1..3, color, door:{x,y}, name?}` — hard obstacles; `door` is on the sidewalk-facing edge; venues have a terrace POI ~34 px outside the door |
| `food` | `Poi[]` | Café Lumen, Café Ombra (kind `cafe`), Corner Market (`market`): odorFood emitters, standing within `r` = on food |
| `bar` | `Poi` | evening attractor (terrace of The Giant Fibre) |
| `garbage` | `Poi[]` | bitter-taste corner |
| `benches` | `Poi[]` | sleep spots (`r` 18); drawn horizontal, 24 × 8 |
| `fountain` | `Poi` | plaza centre, basin r ≈ 33 (blocked) |
| `pond` | `Poi` | park, ellipse `r` × `0.7 r` (blocked) |
| `trees` | `Poi[]` | canopy radius `r` |
| `lamps` | `Poi[]` | street lamps at block corners; `r` = light radius |
| `planters`, `bikeracks` | `Poi[]` | props |
| `plazaCenter`, `parkCenter` | `Pt` | |
| `pois` | `Poi[]` | everything above in one list (`kind` discriminates) |
| `grid` | `Uint8Array` | walkability at `CELL` = 20 px: 0 blocked, 1 sidewalk, 2 road, 3 park; `GRID_W` × `GRID_H` = 120 × 80 |

Helpers: `walkable(city,x,y)`, `cellAt`, `inRect`, and `findPath(city, from, to)` in `pathing.ts`.

## Camera and selection (store, not world)

`useStore.getState()` gives `selectedId`, `followId`, `cameraMode: 'god' | 'follow'`,
`paused`, `speed`, `brainSpeed`, `timeOfDay`, `day`. A renderer owns its own camera and
should honour `cameraMode`/`followId` (lock on that citizen, zoom in, lead in the heading
direction) and call `worldApi.select(id)` / `worldApi.follow(id)` on click / double-click;
dragging or wheeling in follow mode should call `worldApi.setCameraMode('god')`. The Pixi
camera in `src/render/camera.ts` is a reference implementation of these rules.

## Events

`store.events` (last 200): `{ id, t, kind, text, actors }` with kinds
`love | fight | eat | escape | groom | sleep | sing | god | info`. Fights emit "X and Y square
up", "X punches Y" (first and every third blow), "X wins; Y retreats".
