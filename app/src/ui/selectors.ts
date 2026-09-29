// Narrow store slices with value equality, so a 12 Hz `citizens` publish re-renders only
// what visibly changed. Selectors return primitives or store objects; no fresh objects.
import { useRef, useSyncExternalStore } from 'react';
import { useStore, type CitizenView, type StoreState } from '../store';

/** useStore with a custom equality: the snapshot keeps its previous reference while
 *  `equality` says nothing changed, so React skips the render. Built on React's own
 *  useSyncExternalStore; no extra dependency. */
export function useSel<T>(selector: (s: StoreState) => T, equality: (a: T, b: T) => boolean = Object.is): T {
  const cache = useRef<{ has: boolean; v: T }>({ has: false, v: undefined as T });
  const snap = () => {
    const next = selector(useStore.getState());
    const c = cache.current;
    if (c.has && equality(c.v, next)) return c.v;
    cache.current = { has: true, v: next };
    return next;
  };
  return useSyncExternalStore(useStore.subscribe, snap, snap);
}

const q = (v: number, step: number) => Math.round(v / step);

/** Roster row: name, sex, action, hair colour, body state quantised to 0.05. */
export function rowEq(a: CitizenView | undefined, b: CitizenView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.name === b.name && a.sex === b.sex && a.action === b.action
    && a.palette.hair === b.palette.hair
    && q(a.hunger, 0.05) === q(b.hunger, 0.05) && q(a.dust, 0.05) === q(b.dust, 0.05)
    && q(a.energy, 0.05) === q(b.energy, 0.05) && q(a.injury, 0.05) === q(b.injury, 0.05);
}

/** God slot chip: identity, name, sex, palette. */
export function slotEq(a: CitizenView | undefined, b: CitizenView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.name === b.name && a.sex === b.sex
    && a.palette.skin === b.palette.skin && a.palette.hair === b.palette.hair && a.palette.top === b.palette.top;
}

const arrEq = (a: Float32Array, b: Float32Array, step: number) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (q(a[i], step) !== q(b[i], step)) return false;
  return true;
};

/** Inspector body: everything it renders from the citizen, inputs/outputs/body quantised to 0.02. */
export function fullEq(a: CitizenView | undefined, b: CitizenView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.name === b.name && a.sex === b.sex && a.thought === b.thought
    && a.bondWith === b.bondWith
    && q(a.hunger, 0.02) === q(b.hunger, 0.02) && q(a.dust, 0.02) === q(b.dust, 0.02)
    && q(a.energy, 0.02) === q(b.energy, 0.02) && q(a.injury, 0.02) === q(b.injury, 0.02)
    && arrEq(a.inputs, b.inputs, 0.02) && arrEq(a.outputs, b.outputs, 0.02);
}

/** Inspector header/foot only: what is not driven through refs. */
export function headEq(a: CitizenView | undefined, b: CitizenView | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.name === b.name && a.sex === b.sex && a.thought === b.thought && a.bondWith === b.bondWith;
}

export const findCitizen = (s: StoreState, id: number | null) => (id === null ? undefined : s.citizens.find((c) => c.id === id));

export const useCitizenRow = (id: number) => useSel((s) => findCitizen(s, id), rowEq);
export const useSlotCitizen = (id: number | null) => useSel((s) => findCitizen(s, id), slotEq);
export const useCitizenFull = (id: number) => useSel((s) => findCitizen(s, id), fullEq);
export const useCitizenHead = (id: number) => useSel((s) => findCitizen(s, id), headEq);

/** Comma-joined ids: a string, so the roster list only re-renders when order/membership changes. */
export const useCitizenIdSig = () => useSel((s) => { let out = ''; for (const c of s.citizens) out += (out ? ',' : '') + c.id; return out; });
/** "id:name" per line, for the event ticker's actor links. */
export const useNameSig = () => useSel((s) => { let out = ''; for (const c of s.citizens) out += c.id + ':' + c.name + '\n'; return out; });
/** males << 12 | total, packed into one number so nothing allocates. */
export const useSexCounts = () => useSel((s) => { let m = 0; for (const c of s.citizens) if (c.sex === 'male') m++; return (m << 12) | s.citizens.length; });
export const unpackCounts = (v: number) => ({ males: v >> 12, total: v & 4095 });
