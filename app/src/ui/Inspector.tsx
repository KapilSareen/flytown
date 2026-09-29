import { memo, useEffect, useMemo, useRef, type CSSProperties, type RefObject } from 'react';
import { INPUT_CHANNELS, OUTPUT_CHANNELS, type BrainManifest, type FocusReport, type OutputChannel, type Sex } from '../brain/types';
import { useStore } from '../store';
import { SpikeRaster } from './SpikeRaster';
import { INPUT_LABELS, fmtInt, outputLabel, regionColor, sexGlyph, type Tone } from './labels';
import { findCitizen, useCitizenHead, useSel } from './selectors';
import { IconClose, IconFollow } from './icons';

const cssVar = (v: number, c?: string) => ({ '--v': Math.max(0, Math.min(1, v)), ...(c ? { '--c': c } : {}) }) as CSSProperties;

const DRIVE_TONE: Partial<Record<OutputChannel, Tone>> = { aggression: 'fight', courtship: 'love', sing: 'love', sleep: 'sleep' };
const GLOW: Record<Tone, string> = { neutral: 'transparent', accent: 'transparent', fight: 'rgba(217,67,47,.4)', love: 'rgba(230,155,31,.42)', sleep: 'rgba(63,111,216,.38)' };
const BODY_KEYS = ['hunger', 'dust', 'energy', 'injury'] as const;

/** Senses, drives and body: a static skeleton whose bars are written in place from a
 *  store subscription (coalesced to one rAF), so a 12 Hz publish costs no React render. */
const LiveBars = memo(function LiveBars({ id, sex, sectionRef }: { id: number; sex: Sex; sectionRef: RefObject<HTMLElement | null> }) {
  const inB = useRef<(HTMLSpanElement | null)[]>([]);
  const inV = useRef<(HTMLSpanElement | null)[]>([]);
  const outRow = useRef<(HTMLDivElement | null)[]>([]);
  const outB = useRef<(HTMLSpanElement | null)[]>([]);
  const outV = useRef<(HTMLSpanElement | null)[]>([]);
  const bodyB = useRef<(HTMLSpanElement | null)[]>([]);
  const chipRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0, dirty = true, lastDom = -2;
    const q = (v: number) => Math.round(Math.max(0, Math.min(1, v || 0)) * 100);
    const apply = () => {
      const c = findCitizen(useStore.getState(), id);
      if (!c) return;
      for (let i = 0; i < INPUT_CHANNELS.length; i++) {
        const p = q(c.inputs[i]);
        inB.current[i]?.style.setProperty('--v', (p / 100).toFixed(2));
        const t = inV.current[i]; if (t && t.textContent !== String(p)) t.textContent = String(p);
      }
      let dom = -1, domV = 0.05;
      for (let i = 0; i < OUTPUT_CHANNELS.length; i++) {
        const v = c.outputs[i] ?? 0;
        if (OUTPUT_CHANNELS[i] !== 'clock' && v > domV) { domV = v; dom = i; }
        const p = q(v);
        outB.current[i]?.style.setProperty('--v', (p / 100).toFixed(2));
        const t = outV.current[i]; if (t && t.textContent !== String(p)) t.textContent = String(p);
      }
      for (let i = 0; i < BODY_KEYS.length; i++) bodyB.current[i]?.style.setProperty('--v', c[BODY_KEYS[i]].toFixed(2));
      if (dom !== lastDom) {
        if (lastDom >= 0) outRow.current[lastDom]?.classList.remove('is-dominant');
        if (dom >= 0) outRow.current[dom]?.classList.add('is-dominant');
        lastDom = dom;
        const ch = dom >= 0 ? OUTPUT_CHANNELS[dom] : null;
        const tone: Tone = ch ? (DRIVE_TONE[ch] ?? 'accent') : 'neutral';
        const chip = chipRef.current;
        if (chip) {
          chip.style.display = ch ? '' : 'none';
          chip.textContent = ch ? outputLabel(ch, sex) : '';
          chip.className = `dom-chip ${tone}`;
          chip.style.animation = 'none'; void chip.offsetWidth; chip.style.animation = '';   // replay the slide-in
        }
        const glow = ch === 'courtship' || ch === 'aggression' || ch === 'sleep' ? GLOW[tone] : 'transparent';
        const sec = sectionRef.current;
        if (sec) { sec.style.setProperty('--glow', glow); sec.style.setProperty('--glow-a', glow === 'transparent' ? '0' : '1'); }
      }
    };
    const frame = () => { raf = 0; if (dirty) { dirty = false; apply(); } };
    const schedule = () => { dirty = true; if (!raf) raf = requestAnimationFrame(frame); };
    schedule();
    const unsub = useStore.subscribe(schedule);
    return () => { unsub(); if (raf) cancelAnimationFrame(raf); };
  }, [id, sex, sectionRef]);

  return (
    <>
      <div className="sec">
        <div className="sh"><span className="t">Senses</span><span className="u">input drive</span></div>
        <div className="two-col">
          {INPUT_CHANNELS.map((ch, i) => (
            <div key={ch} className="bar-row">
              <span className="l">{INPUT_LABELS[ch]}</span>
              <span className="b" ref={(el) => { inB.current[i] = el; }} style={cssVar(0)} />
              <span className="v num" ref={(el) => { inV.current[i] = el; }}>0</span>
            </div>
          ))}
        </div>
      </div>
      <div className="sec">
        <div className="sh">
          <span className="t">Drives</span>
          <span ref={chipRef} className="dom-chip" style={{ display: 'none' }} />
        </div>
        <div className="two-col">
          {OUTPUT_CHANNELS.map((ch, i) => (
            <div key={ch} className="bar-row lum" ref={(el) => { outRow.current[i] = el; }}>
              <span className="l">{outputLabel(ch, sex)}</span>
              <span className="b" ref={(el) => { outB.current[i] = el; }} style={cssVar(0)} />
              <span className="v num" ref={(el) => { outV.current[i] = el; }}>0</span>
            </div>
          ))}
        </div>
      </div>
      <div className="sec" style={{ paddingBottom: 14 }}>
        <div className="sh"><span className="t">Body</span><span className="u">slow state, stands in for neuromodulation</span></div>
        <div className="body-state">
          {BODY_KEYS.map((k, i) => (
            <div key={k}><span className="l">{k.charAt(0).toUpperCase() + k.slice(1)}</span><span className={`b ${k}`} ref={(el) => { bodyB.current[i] = el; }} style={cssVar(0)} /></div>
          ))}
        </div>
        <BondLine id={id} />
      </div>
    </>
  );
});

const BondLine = memo(function BondLine({ id }: { id: number }) {
  const bondName = useSel((s) => { const c = findCitizen(s, id); if (!c || c.bondWith === null) return ''; return s.citizens.find((x) => x.id === c.bondWith)?.name ?? 'someone'; });
  return bondName ? <div className="bond">In love with {bondName}</div> : null;
});

const R = 20, C = 26;
function arcPath(i: number, n: number): { d: string; color: string } {
  const gap = 0.05;
  const a0 = (i / n) * Math.PI * 2 - Math.PI / 2 + gap;
  const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2 - gap;
  const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0);
  const x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return { d: `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`, color: regionColor(i) };
}

/** Everything driven by `focus` (12 Hz+): rendered once as a static skeleton, then
 *  updated in place from a store subscription + one rAF per report. No React state. */
const LiveFocus = memo(function LiveFocus({ manifest, agentId }: { manifest: BrainManifest; agentId: number }) {
  const regionNames = useMemo(() => Object.keys(manifest.regions), [manifest]);
  const arcs = useMemo(() => regionNames.map((_, i) => arcPath(i, regionNames.length)), [regionNames]);
  const hzRef = useRef<HTMLSpanElement>(null);
  const cntRef = useRef<HTMLSpanElement>(null);
  const arcRefs = useRef<(SVGPathElement | null)[]>([]);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const valRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const scaleRef = useRef<HTMLSpanElement>(null);
  const typeNameRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const typeHzRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const typesEmptyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let latest: FocusReport | null = null;
    let dirty = false;
    let raf = 0;
    let hzCur = 0, hzTarget = 0, last = performance.now();
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const apply = (f: FocusReport) => {
      const rates = f.regionRates;
      let max = 20, sum = 0;
      for (let i = 0; i < rates.length; i++) { if (rates[i] > max) max = rates[i]; sum += rates[i]; }
      hzTarget = rates.length ? sum / rates.length : 0;
      const scale = Math.ceil(max / 10) * 10;
      if (scaleRef.current) scaleRef.current.textContent = `Hz, 0–${scale}`;
      if (cntRef.current) cntRef.current.textContent = `${f.spikes.length} this window`;
      for (let i = 0; i < regionNames.length; i++) {
        const v = Math.min(1, (rates[i] ?? 0) / scale);
        barRefs.current[i]?.style.setProperty('--v', v.toFixed(3));
        const vt = valRefs.current[i]; if (vt) vt.textContent = (rates[i] ?? 0).toFixed(1);
        const a = arcRefs.current[i];
        if (a) { a.setAttribute('opacity', (0.12 + 0.88 * v).toFixed(3)); a.style.filter = v > 0.5 ? `drop-shadow(0 0 3px ${arcs[i].color})` : 'none'; }
      }
      const top = f.topTypes;
      if (typesEmptyRef.current) typesEmptyRef.current.style.display = top.length ? 'none' : '';
      for (let i = 0; i < 8; i++) {
        const t = top[i];
        const n = typeNameRefs.current[i], h = typeHzRefs.current[i];
        if (n) { n.textContent = t ? (manifest.types[t.typeId] ?? `#${t.typeId}`) : ''; n.style.display = t ? '' : 'none'; }
        if (h) { h.textContent = t ? t.hz.toFixed(1) : ''; h.style.display = t ? '' : 'none'; }
      }
    };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (dirty && latest) { dirty = false; apply(latest); }
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now;
      const d = hzTarget - hzCur;
      if (d !== 0) {
        hzCur = still || Math.abs(d) < 0.02 ? hzTarget : hzCur + d * Math.min(1, 6 * dt);
        if (hzRef.current) hzRef.current.textContent = hzCur.toFixed(1);
      }
    };
    const take = (f: FocusReport | null) => { if (f && f.agentId === agentId && f !== latest) { latest = f; dirty = true; } };
    take(useStore.getState().focus);
    const unsub = useStore.subscribe((s) => take(s.focus));
    raf = requestAnimationFrame(frame);
    return () => { unsub(); cancelAnimationFrame(raf); };
  }, [agentId, manifest, regionNames, arcs]);

  return (
    <>
      <div className="hero">
        <div className="readouts">
          <div className="hz">
            <span className="big"><span ref={hzRef}>0.0</span><em>Hz</em></span>
            <span className="l">mean rate across regions</span>
          </div>
          <span className="spacer" />
          <svg className="brainglyph" width="52" height="52" viewBox="0 0 52 52" role="img" aria-label="Region activity">
            <circle className="ring" cx={C} cy={C} r={R} />
            {arcs.map((a, i) => (
              <path key={regionNames[i]} ref={(el) => { arcRefs.current[i] = el; }} className="arc" d={a.d} stroke={a.color} opacity={0.12}>
                <title>{regionNames[i]}</title>
              </path>
            ))}
            <circle className="core" cx={C} cy={C} r={9} />
          </svg>
        </div>
        <div className="sh" style={{ marginBottom: 6 }}><span className="t">Spikes</span><span className="u" ref={cntRef}>waiting for brain</span></div>
        <div className="raster-wrap"><SpikeRaster manifest={manifest} agentId={agentId} /></div>
        <div className="raster-legend">
          {regionNames.map((r, i) => <span key={r}><i style={{ '--c': regionColor(i) } as CSSProperties} />{r}</span>)}
        </div>
      </div>

      <div className="sec">
        <div className="sh"><span className="t">Regions</span><span className="u" ref={scaleRef}>Hz, 0–20</span></div>
        {regionNames.map((r, i) => (
          <div key={r} className="bar-row">
            <span className="l">{r}</span>
            <span className="b" ref={(el) => { barRefs.current[i] = el; }} style={cssVar(0, regionColor(i))} />
            <span className="v num" ref={(el) => { valRefs.current[i] = el; }}>0.0</span>
          </div>
        ))}
      </div>

      <div className="sec">
        <div className="sh"><span className="t">Top firing cell types</span><span className="u">Hz</span></div>
        <div className="muted" style={{ fontSize: 12 }} ref={typesEmptyRef}>Nothing firing yet.</div>
        <div className="types">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <span className="tn" ref={(el) => { typeNameRefs.current[i] = el; }} style={{ display: 'none' }} />
              <span className={`th${i === 0 ? ' hot' : ''}`} ref={(el) => { typeHzRefs.current[i] = el; }} style={{ display: 'none' }} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
});

/** Header, thought, live panels, follow. Re-renders only on name / sex / thought / bond changes. */
const Body = memo(function Body({ id, manifest }: { id: number; manifest: BrainManifest }) {
  const c = useCitizenHead(id);
  const following = useStore((s) => s.followId === id);
  const hasApi = useStore((s) => s.worldApi !== null);
  const sectionRef = useRef<HTMLElement>(null);
  if (!c) return null;
  const api = () => useStore.getState().worldApi;

  return (
    <section ref={sectionRef} className="inspector enter" aria-label={`Inspector: ${c.name}`} style={{ '--glow': 'transparent', '--glow-a': 0 } as CSSProperties}>
      <div className="halo" aria-hidden />
      <div className="glass body">
        <div className="ihead">
          <div className="who">
            <div className="name">{c.name} <span className="glyph">{sexGlyph(c.sex)}</span></div>
            <div className="meta">
              Neurons <span className="num">{fmtInt(manifest.neurons)}</span> · Connections <span className="num">{fmtInt(manifest.edges)}</span> — real MaleCNS subgraph
            </div>
          </div>
          <button className="btn icon ghost" onClick={() => api()?.select(null)} aria-label="Close inspector" title="Close (Esc)"><IconClose size={14} /></button>
        </div>

        <div className="scroll">
          <p className="thought">{c.thought || '…'}</p>
          <LiveFocus manifest={manifest} agentId={id} />
          <LiveBars id={id} sex={c.sex} sectionRef={sectionRef} />
        </div>

        <div className="ifoot">
          <button className={`btn outline${following ? ' is-on' : ''}`} onClick={() => api()?.follow(following ? null : id)} disabled={!hasApi} title={following ? 'Back to god view (Esc)' : 'Follow (F)'}>
            <IconFollow size={14} /> {following ? 'Following' : 'Follow'}
          </button>
        </div>
      </div>
    </section>
  );
});

/** Mounts only while a citizen is selected. */
export const Inspector = memo(function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const manifest = useStore((s) => s.manifest);
  if (selectedId === null || !manifest) return null;
  return <Body id={selectedId} manifest={manifest} />;
});
