import { Profiler, useEffect, type ProfilerOnRenderCallback } from 'react';
import { useStore } from '../store';
import { useUi } from './uiStore';
import { TopBar } from './TopBar';
import { Roster } from './Roster';
import { Inspector } from './Inspector';
import { GodPanel } from './GodPanel';
import { EventLog } from './EventLog';
import { Onboarding } from './Onboarding';
import { LoadingScreen } from './LoadingScreen';
import { About } from './About';
import { installDevMock } from './devMock';
import { castTownPower } from './townPowers';
import { cycleFollow, followAuto } from './followPick';
import './hud.css';

const SPEED_KEYS: Record<string, number> = { '1': 0.5, '2': 1, '3': 2, '4': 4 };
const TOWN_KEYS = { r: 'riot', p: 'festival', l: 'loveWave', x: 'panic', c: 'calm' } as const;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const s = useStore.getState();
      const api = s.worldApi;
      if (!api) return;
      if (e.key === ' ') { e.preventDefault(); api.setPaused(!s.paused); return; }
      if (e.key === 'f' || e.key === 'F') { followAuto(); return; }
      if (e.key === ']') { cycleFollow(1); return; }
      if (e.key === '[') { cycleFollow(-1); return; }
      if (e.key === 'Escape') {
        const ui = useUi.getState();
        if (ui.aboutOpen) { ui.setAboutOpen(false); return; }
        if (s.cameraMode === 'follow' || s.followId !== null) api.follow(null);
        else if (s.selectedId !== null) api.select(null);
        return;
      }
      const sp = SPEED_KEYS[e.key];
      if (sp !== undefined) { api.setSpeed(sp); return; }
      const town = TOWN_KEYS[e.key.toLowerCase() as keyof typeof TOWN_KEYS];
      if (town) castTownPower(town);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** 1.5 s HUD-wide vignette after a town power. Keyed on the counter so repeats re-trigger. */
function Flash() {
  const flash = useUi((s) => s.flash);
  if (!flash) return null;
  return <div key={flash.n} className={`flash ${flash.tone}`} aria-hidden />;
}

// Dev profiling hook: when `window.__hudCommits` is an array, every commit's actual render
// duration is pushed to it (a no-op in production builds, where Profiler is inert).
declare global { interface Window { __hudCommits?: number[] } }
const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => { window.__hudCommits?.push(actualDuration); };

export function HUD() {
  const ready = useStore((s) => s.ready);
  useHotkeys();
  useEffect(() => { installDevMock(); }, []);

  return (
    <Profiler id="hud" onRender={onRender}>
    <div className="hud" data-theme="light">
      {!ready && <LoadingScreen />}
      {ready && (
        <>
          <Flash />
          <TopBar />
          <Roster />
          <Inspector />
          <GodPanel />
          <EventLog />
          <Onboarding />
        </>
      )}
      <About />
    </div>
    </Profiler>
  );
}

export default HUD;
