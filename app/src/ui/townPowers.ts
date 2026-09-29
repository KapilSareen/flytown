// Town-scale god powers: one definition shared by the dock buttons and the hotkeys.
import { useStore } from '../store';
import { useUi, type FlashTone } from './uiStore';

export interface TownPower {
  key: 'riot' | 'festival' | 'loveWave' | 'panic' | 'calm';
  label: string;
  hotkey: string;
  tone: FlashTone;
  /** One line: what happens, in the visitor's words. */
  hint: (aroundName: string | null) => string;
}

export const TOWN_POWERS: TownPower[] = [
  { key: 'riot', label: 'Riot', hotkey: 'R', tone: 'red',
    hint: (a) => `Everyone near ${a ?? 'the plaza'} starts fighting, and brawls spread` },
  { key: 'festival', label: 'Festival', hotkey: 'P', tone: 'amber',
    hint: () => 'The whole town heads to the plaza for music, chatter and dancing' },
  { key: 'loveWave', label: 'Love wave', hotkey: 'L', tone: 'pink',
    hint: () => 'Every man sings to the nearest woman; the town falls in love at once' },
  { key: 'panic', label: 'Panic', hotkey: 'X', tone: 'red',
    hint: (a) => `A looming threat at ${a ?? 'the plaza'}: everyone flees from it` },
  { key: 'calm', label: 'Calm', hotkey: 'C', tone: 'cool',
    hint: () => 'Heal every injury and silence aggression for half a minute' },
];

/** Fire a town power. Uses slot A as the centre when it is set. Returns false if no world yet. */
export function castTownPower(key: TownPower['key']): boolean {
  const api = useStore.getState().worldApi;
  if (!api) return false;
  const { slotA, triggerFlash } = useUi.getState();
  const p = TOWN_POWERS.find((x) => x.key === key)!;
  switch (key) {
    case 'riot': api.god.riot(slotA); break;
    case 'festival': api.god.festival(); break;
    case 'loveWave': api.god.loveWave(); break;
    case 'panic': api.god.panic(slotA); break;
    case 'calm': api.god.calm(); break;
  }
  triggerFlash(p.tone);
  return true;
}
