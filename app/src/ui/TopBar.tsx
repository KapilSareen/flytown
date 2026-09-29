import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../store';
import { useUi } from './uiStore';
import { fmtClock, fmtInt } from './labels';
import { FlipNum } from './motion';
import { IconEye, IconFollow, IconInfo, IconPause, IconPlay } from './icons';

const SPEEDS = [0.5, 1, 2, 4];
const BRAIN_SPEEDS = [0.1, 0.25, 0.5, 1];

/** Sun / moon on a shallow arc: 6h rises left, 18h sets right, night goes below. */
function DayArc({ hour }: { hour: number }) {
  const day = hour >= 6 && hour < 18;
  const t = day ? (hour - 6) / 12 : ((hour + 6) % 24) / 12;
  const a = Math.PI * (1 - t);
  const cx = 32 + 26 * Math.cos(a);
  const cy = 22 - 16 * Math.sin(a);
  return (
    <svg className="arc" width="64" height="26" viewBox="0 0 64 26" aria-hidden>
      <path d="M6 22a26 16 0 0 1 52 0" fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="1" />
      <line x1="2" y1="22" x2="62" y2="22" stroke="rgba(255,255,255,.14)" strokeWidth="1" />
      {day
        ? <><circle cx={cx} cy={cy} r="5" fill="rgba(245,181,68,.25)" /><circle cx={cx} cy={cy} r="3" fill="#f5b544" /></>
        : <circle cx={cx} cy={cy} r="2.6" fill="none" stroke="rgba(236,238,242,.7)" strokeWidth="1.2" />}
    </svg>
  );
}

/** Population popover: size + sex ratio, debounced into worldApi.setPopulation. */
function PopulationControl({ males, females }: { males: number; females: number }) {
  const api = useStore((s) => s.worldApi);
  const max = useStore((s) => s.maxPopulation);
  const total = males + females;
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(total);
  const [ratio, setRatio] = useState(total ? females / total : 0.5);
  const dirty = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);

  // follow the world while the user is not dragging
  useEffect(() => { if (!dirty.current) { setN(total); setRatio(total ? females / total : 0.5); } }, [total, females]);
  // debounce 250 ms -> setPopulation
  useEffect(() => {
    if (!dirty.current) return;
    const t = setTimeout(() => { api?.setPopulation(n, ratio); dirty.current = false; }, 250);
    return () => clearTimeout(t);
  }, [n, ratio, api]);
  // close on outside click / Esc
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
      <button className={`chip pop${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" title="Population: click to resize the town" disabled={!api}>
        <span className="sex">♂</span><FlipNum value={males} />
        <span className="sep" />
        <span className="sex">♀</span><FlipNum value={females} />
      </button>
      {open && (
        <div className="glass popover" role="dialog" aria-label="Population">
          <div className="prow">
            <label htmlFor="pop-n">People</label>
            <input id="pop-n" type="range" min={2} max={max} step={1} value={n}
              onChange={(e) => { dirty.current = true; setN(+e.target.value); }} />
            <span className="num">{n}<em>/{max}</em></span>
          </div>
          <div className="prow">
            <label htmlFor="pop-r">Ratio</label>
            <input id="pop-r" type="range" min={0} max={1} step={0.05} value={ratio}
              onChange={(e) => { dirty.current = true; setRatio(+e.target.value); }} />
            <span className="num"><b>♂</b>{100 - fPct}% <b>♀</b>{fPct}%</span>
          </div>
          <div className="phint">Limited to {max} by measured brain speed.</div>
        </div>
      )}
    </div>
  );
}

const CL: [number, number][] = [[4, 10], [12, 4], [20, 12], [10, 18], [22, 20]];
const CLL: [number, number][] = [[0, 1], [1, 2], [0, 3], [3, 2], [2, 4], [3, 4]];

/** Wordmark: gradient display caps, a hairline that breathes with the selected citizen's spikes, a neuron cluster. */
function Brand({ live }: { live: number }) {
  return (
    <div className="brand" style={{ '--live': live } as CSSProperties}>
      <svg className="cluster" width="26" height="24" viewBox="0 0 26 24" aria-hidden>
        {CLL.map(([a, b], i) => <line key={i} x1={CL[a][0]} y1={CL[a][1]} x2={CL[b][0]} y2={CL[b][1]} strokeWidth="1" />)}
        {CL.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i === 2 ? 2.4 : 1.7} style={{ animationDelay: `${i * 0.35}s` }} />)}
      </svg>
      <div className="wordwrap">
        <span className="word">DROSOPOLIS</span>
        <span className="rule" />
        <span className="sub">a town of people with fly brains</span>
      </div>
    </div>
  );
}

export function TopBar() {
  const timeOfDay = useStore((s) => s.timeOfDay);
  const day = useStore((s) => s.day);
  const citizens = useStore((s) => s.citizens);
  const paused = useStore((s) => s.paused);
  const speed = useStore((s) => s.speed);
  const brainSpeed = useStore((s) => s.brainSpeed);
  const perf = useStore((s) => s.perf);
  const fps = useStore((s) => s.fps);
  const cameraMode = useStore((s) => s.cameraMode);
  const selectedId = useStore((s) => s.selectedId);
  const spikeCount = useStore((s) => (s.focus && s.focus.agentId === s.selectedId ? s.focus.spikes.length : 0));
  const api = useStore((s) => s.worldApi);
  const setAboutOpen = useUi((s) => s.setAboutOpen);

  let males = 0;
  for (const c of citizens) if (c.sex === 'male') males++;
  const females = citizens.length - males;
  const live = selectedId === null ? 0 : Math.min(1, spikeCount / 120);

  return (
    <header className="glass topbar enter">
      <Brand live={live} />

      <div className="group hide-sm">
        <div className="daytime" title="Time of day in Drosopolis">
          <DayArc hour={timeOfDay} />
          <div className="t">
            <FlipNum value={fmtClock(timeOfDay)} />
            <span className="d">Day <FlipNum value={day} className="d" /></span>
          </div>
        </div>
      </div>

      <PopulationControl males={males} females={females} />

      <div className="grow" />

      <div className="group">
        <button
          className={`btn icon${paused ? ' is-on' : ''}`}
          onClick={() => api?.setPaused(!paused)}
          disabled={!api}
          aria-label={paused ? 'Play' : 'Pause'}
          title={paused ? 'Play (Space)' : 'Pause (Space)'}
        >
          {paused ? <IconPlay /> : <IconPause />}
        </button>
        <div className="seg" role="group" aria-label="World speed" title="World speed (1–4)">
          {SPEEDS.map((x) => (
            <button key={x} className={speed === x ? 'is-on' : ''} onClick={() => api?.setSpeed(x)} disabled={!api}>
              <span className="num">{x}×</span>
            </button>
          ))}
        </div>
        <div className="seg hide-sm" role="group" aria-label="Brain speed" title="brain ms per world ms">
          {BRAIN_SPEEDS.map((x) => (
            <button key={x} className={brainSpeed === x ? 'is-on accent' : ''} onClick={() => api?.setBrainSpeed(x)} disabled={!api}>
              <span className="num">{x}×</span>
            </button>
          ))}
        </div>
      </div>

      <div className="chip hide-md" title="fps · simulation ms per brain ms · active neurons">
        <span className="num">{fps.toFixed(0)}</span><span>fps</span>
        <span className="sep" />
        <span className="num">{perf ? perf.msPerSimMs.toFixed(2) : '–'}</span><span>ms</span>
        <span className="sep" />
        <span className="num">{perf ? fmtInt(perf.activeNeurons) : '–'}</span><span>active</span>
      </div>

      <div className="seg" role="group" aria-label="Camera">
        <button className={cameraMode === 'god' ? 'is-on' : ''} onClick={() => api?.follow(null)} disabled={!api} title="God view (Esc)">
          <IconEye size={14} /> <span className="hide-sm">God</span>
        </button>
        <button
          className={cameraMode === 'follow' ? 'is-on' : ''}
          onClick={() => selectedId !== null && api?.follow(selectedId)}
          disabled={!api || selectedId === null}
          title="Follow selected (F)"
        >
          <IconFollow size={14} /> <span className="hide-sm">Follow</span>
        </button>
      </div>

      <button className="btn icon ghost" onClick={() => setAboutOpen(true)} aria-label="About" title="About: what is real here">
        <IconInfo />
      </button>
    </header>
  );
}
