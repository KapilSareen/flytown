// Follow without a selection: pick whoever is doing the most interesting thing,
// and cycle through the town on repeated presses.
import { useStore, type Action, type CitizenView } from '../store';

const INTEREST: Record<Action, number> = {
  fight: 6, hurt: 6, court: 5, sing: 5, escape: 4, eat: 3, groom: 2, walk: 1, backup: 1, idle: 0, sleep: 0,
};

/** Most interesting citizen; ties go to the first in roster order (we cannot know the screen centre here). */
export function pickInteresting(citizens: CitizenView[]): CitizenView | undefined {
  let best: CitizenView | undefined;
  let score = -1;
  for (const c of citizens) {
    const s = INTEREST[c.action] ?? 0;
    if (s > score) { score = s; best = c; }
  }
  return best;
}

const follow = (id: number) => {
  const api = useStore.getState().worldApi;
  if (!api) return;
  api.select(id);
  api.follow(id);
};

/** Follow the selection, or auto-pick one; when already following, move on to the next citizen. */
export function followAuto(): void {
  const s = useStore.getState();
  if (!s.worldApi || s.citizens.length === 0) return;
  if (s.followId !== null && s.cameraMode === 'follow') { cycleFollow(1); return; }
  const id = s.selectedId ?? pickInteresting(s.citizens)?.id;
  if (id !== undefined) follow(id);
}

/** Step to the next (+1) or previous (-1) citizen in roster order and follow them. */
export function cycleFollow(dir: 1 | -1): void {
  const s = useStore.getState();
  const n = s.citizens.length;
  if (!s.worldApi || n === 0) return;
  const cur = s.followId ?? s.selectedId;
  const i = cur === null ? -1 : s.citizens.findIndex((c) => c.id === cur);
  const next = i < 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n;
  follow(s.citizens[next].id);
}
