// UI-only state (panel visibility, god slots, modal flags). Never simulation truth —
// that lives in ../store and is only changed through worldApi.
import { create } from 'zustand';

const ONBOARD_KEY = 'flytown.onboarded.v1';

const readOnboarded = () => {
  try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch { return false; }
};

export interface UiState {
  rosterOpen: boolean;
  aboutOpen: boolean;
  onboardingOpen: boolean;
  advancedOpen: boolean;
  slotA: number | null;
  slotB: number | null;
  setRosterOpen(v: boolean): void;
  setAboutOpen(v: boolean): void;
  dismissOnboarding(): void;
  reopenOnboarding(): void;
  setAdvancedOpen(v: boolean): void;
  setSlotA(id: number | null): void;
  setSlotB(id: number | null): void;
  /** Feed a selection into the slots: first fills A, a different one fills B. */
  offerSelection(id: number): void;
}

export const useUi = create<UiState>((set, get) => ({
  rosterOpen: true,
  aboutOpen: false,
  onboardingOpen: !readOnboarded(),
  advancedOpen: false,
  slotA: null,
  slotB: null,
  setRosterOpen: (rosterOpen) => set({ rosterOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  dismissOnboarding: () => {
    try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* private mode */ }
    set({ onboardingOpen: false });
  },
  reopenOnboarding: () => set({ onboardingOpen: true, aboutOpen: false }),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
  setSlotA: (slotA) => set({ slotA }),
  setSlotB: (slotB) => set({ slotB }),
  offerSelection: (id) => {
    const { slotA, slotB } = get();
    if (slotA === null) { set({ slotA: id, slotB: slotB === id ? null : slotB }); return; }
    if (id === slotA) return;
    set({ slotB: id });
  },
}));
