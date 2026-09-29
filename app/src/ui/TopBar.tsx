import { memo, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useUi } from './uiStore';
import { fmtClock, fmtInt } from './labels';
import { followAuto } from './followPick';
import { unpackCounts, useSexCounts } from './selectors';
import { IconEye, IconFollow, IconInfo, IconPause, IconPlay } from './icons';

const SPEEDS = [0.5, 1, 2, 4];
const BRAIN_SPEEDS = [0.1, 0.25, 0.5, 1];
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Sun / moon on a shallow arc, eased in a rAF loop that writes attributes directly: no React state. */
const DayArc = memo(function DayArc() {
  const sun = useRef<SVGGElement>(null);
  const moon = useRef<SVGCircleElement>(null);
  useEffect(() => {
    let raf = 0, cur = useStore.getState().timeOfDay, last = performance.now();
    const still = reduced();
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
      const target = useStore.getState().timeOfDay;
      cur = still || Math.abs(cur - target) > 6 ? target : cur + (target - cur) * Math.min(1, 3 * dt);
      const day = cur >= 6 && cur < 18;
      const t = day ? (cur - 6) / 12 : ((cur + 6) % 24) / 12;
      const a = Math.PI * (1 - t);
      const cx = (32 + 26 * Math.cos(a)).toFixed(2), cy = (22 - 16 * Math.sin(a)).toFixed(2);
      if (sun.current) { sun.current.style.display = day ? '' : 'none'; sun.current.setAttribute('transform', `translate(${cx} ${cy})`); }
      if (moon.current) { moon.current.style.display = day ? 'none' : ''; moon.current.setAttribute('cx', cx); moon.current.setAttribute('cy', cy); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <svg className="arc" width="64" height="26" viewBox="0 0 64 26" aria-hidden>
      <path d="M6 22a26 16 0 0 1 52 0" fill="none" stroke="rgba(30,25,20,.14)" strokeWidth="1" />
      <line x1="2" y1="22" x2="62" y2="22" stroke="rgba(30,25,20,.18)" strokeWidth="1" />
      <g ref={sun}><circle r="5" fill="rgba(230,155,31,.3)" /><circle r="3" fill="#e69b1f" /></g>
      <circle ref={moon} r="2.6" fill="none" stroke="rgba(30,25,20,.55)" strokeWidth="1.2" style={{ display: 'none' }} />
    </svg>
  );
});

/** Mark: a minimal fly whose body glows with the selected citizen's spikes (written via a ref, not state). */
const Brand = memo(function Brand() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => useStore.subscribe((s) => {
    const live = s.focus && s.focus.agentId === s.selectedId ? Math.min(1, s.focus.spikes.length / 120) : 0;
    ref.current?.style.setProperty('--live', live.toFixed(2));
  }), []);
  return (
    <div className="brand" ref={ref}>
      <svg className="mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <path className="wing" d="M8 9C6.2 6.4 3.2 4.2 1.4 4.6c-.9.3-.6 2 .5 3.1C3.4 9.3 6 10 8 9z" />
        <path className="wing" d="M10 9c1.8-2.6 4.8-4.8 6.6-4.4.9.3.6 2-.5 3.1C14.6 9.3 12 10 10 9z" />
        <circle className="body" cx="9" cy="9.6" r="2.3" />
        <path d="M9 12v3.2" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" opacity="0.7" />
      </svg>
      <div className="wordwrap">
        <span className="word">Flytown</span>
        <span className="rule" />
        <span className="sub">a town of people with fly brains</span>
      </div>
    </div>
  );
});

/** Clock text changes once per game minute; day rarely. */
const Clock = memo(function Clock() {
  const clock = useStore((s) => fmtClock(s.timeOfDay));
  const day = useStore((s) => s.day);
  return (
    <div className="daytime" title="Time of day in Flytown">
      <DayArc />
      <div className="t">
        <span className="num clock">{clock}</span>
        <span className="d">Day <span className="num d">{day}</span></span>
      </div>
    </div>
  );
});

/** Perf digits sampled at 2 Hz from the store, outside React's subscription path. */
const PerfChip = memo(function PerfChip() {
  const snap = () => { const s = useStore.getState(); return { fps: Math.round(s.fps), ms: s.perf ? s.perf.msPerSimMs.toFixed(2) : '–', active: s.perf ? fmtInt(s.perf.activeNeurons) : '–' }; };
  const [v, setV] = useState(snap);
  useEffect(() => {
    const t = setInterval(() => setV((prev) => { const n = snap(); return prev.fps === n.fps && prev.ms === n.ms && prev.active === n.active ? prev : n; }), 500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="chip hide-md" title="fps · simulation ms per brain ms · active neurons">
      <span className="num w3">{v.fps}</span><span>fps</span>
      <span className="sep" />
      <span className="num w4">{v.ms}</span><span>ms</span>
      <span className="sep" />
      <span className="num w6">{v.active}</span><span>active</span>
    </div>
  );
});

/** Population chip + popover: size and sex ratio, debounced into worldApi.setPopulation. */
const PopulationControl = memo(function PopulationControl() {
  const { males, total } = unpackCounts(useSexCounts());
  const females = total - males;
  const hasApi = useStore((s) => s.worldApi !== null);
  const max = useStore((s) => s.maxPopulation);
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(total);
  const [ratio, setRatio] = useState(total ? females / total : 0.5);
  const dirty = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => { if (!dirty.current) { setN(total); setRatio(total ? females / total : 0.5); } }, [total, females]);
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => { useStore.getState().worldApi?.setPopulation(n, ratio); dirty.current = false; }, 250);
    return () => clearTimeout(t);
  }, [n, ratio]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const fPct = Math.round(ratio * 100);
  return (
    <div className="popwrap hide-md" ref={wrap}>
      <button className={`chip pop${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" title="Population: click to resize the town" disabled={!hasApi}>
        <span className="sex">♂</span><span className="num cnt">{males}</span>
        <span className="sep" />
        <span className="sex">♀</span><span className="num cnt">{females}</span>
      </button>
      {open && (
        <div className="glass popover" role="dialog" aria-label="Population">
          <div className="prow">
            <label htmlFor="pop-n">People</label>
            <input id="pop-n" type="range" min={2} max={max} step={1} value={n} onChange={(e) => { dirty.current = true; setN(+e.target.value); }} />
            <span className="num">{n}<em>/{max}</em></span>
          </div>
          <div className="prow">
            <label htmlFor="pop-r">Ratio</label>
            <input id="pop-r" type="range" min={0} max={1} step={0.05} value={ratio} onChange={(e) => { dirty.current = true; setRatio(+e.target.value); }} />
            <span className="num"><b>♂</b>{100 - fPct}% <b>♀</b>{fPct}%</span>
          </div>
          <div className="phint">Limited to {max} by measured brain speed.</div>
        </div>
      )}
    </div>
  );
});

/** Play / speed / brain speed. */
const Transport = memo(function Transport() {
  const paused = useStore((s) => s.paused);
  const speed = useStore((s) => s.speed);
  const brainSpeed = useStore((s) => s.brainSpeed);
  const hasApi = useStore((s) => s.worldApi !== null);
  const api = () => useStore.getState().worldApi;
  return (
    <div className="group">
      <button className={`btn icon${paused ? ' is-on' : ''}`} onClick={() => api()?.setPaused(!paused)} disabled={!hasApi} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (Space)' : 'Pause (Space)'}>
        {paused ? <IconPlay /> : <IconPause />}
      </button>
      <div className="seg" role="group" aria-label="World speed" title="World speed (1–4)">
        {SPEEDS.map((x) => (
          <button key={x} className={speed === x ? 'is-on' : ''} onClick={() => api()?.setSpeed(x)} disabled={!hasApi}><span className="num">{x}×</span></button>
        ))}
      </div>
      <div className="seg hide-sm" role="group" aria-label="Brain speed" title="brain ms per world ms">
        {BRAIN_SPEEDS.map((x) => (
          <button key={x} className={brainSpeed === x ? 'is-on accent' : ''} onClick={() => api()?.setBrainSpeed(x)} disabled={!hasApi}><span className="num">{x}×</span></button>
        ))}
      </div>
    </div>
  );
});

const Camera = memo(function Camera() {
  const cameraMode = useStore((s) => s.cameraMode);
  const hasSelection = useStore((s) => s.selectedId !== null);
  const hasCitizens = useStore((s) => s.citizens.length > 0);
  const hasApi = useStore((s) => s.worldApi !== null);
  return (
    <div className="seg" role="group" aria-label="Camera">
      <button className={cameraMode === 'god' ? 'is-on' : ''} onClick={() => useStore.getState().worldApi?.follow(null)} disabled={!hasApi} title="God view (Esc)">
        <IconEye size={14} /> <span className="hide-sm">God</span>
      </button>
      <button
        className={cameraMode === 'follow' ? 'is-on' : ''}
        onClick={followAuto}
        disabled={!hasApi || !hasCitizens}
        title={cameraMode === 'follow' ? 'Next citizen (F or ]; [ goes back)' : hasSelection ? 'Follow the selected citizen (F)' : 'Follow whoever is doing the most interesting thing (F)'}
      >
        <IconFollow size={14} /> <span className="hide-sm">Follow</span>
      </button>
    </div>
  );
});

export const TopBar = memo(function TopBar() {
  return (
    <header className="glass topbar enter">
      <Brand />
      <div className="group hide-sm"><Clock /></div>
      <PopulationControl />
      <div className="grow" />
      <Transport />
      <PerfChip />
      <Camera />
      <button className="btn icon ghost" onClick={() => useUi.getState().setAboutOpen(true)} aria-label="About" title="About: what is real here">
        <IconInfo />
      </button>
    </header>
  );
});
