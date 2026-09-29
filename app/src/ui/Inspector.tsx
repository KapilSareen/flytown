import { useMemo, type CSSProperties } from 'react';
import { INPUT_CHANNELS, OUTPUT_CHANNELS } from '../brain/types';
import { useStore } from '../store';
import { SpikeRaster } from './SpikeRaster';
import { INPUT_LABELS, fmtInt, outputLabel, regionColor, sexGlyph, type Tone } from './labels';
import { useEased } from './useEased';
import { IconClose, IconFollow } from './icons';

const cssVar = (v: number, c?: string) => ({ '--v': Math.max(0, Math.min(1, v)), ...(c ? { '--c': c } : {}) }) as CSSProperties;

function Bar({ label, v, text, dominant, color, lum }: { label: string; v: number; text: string; dominant?: boolean; color?: string; lum?: boolean }) {
  return (
    <div className={`bar-row${dominant ? ' is-dominant' : ''}${lum ? ' lum' : ''}`}>
      <span className="l">{label}</span>
      <span className="b" style={cssVar(v, color)} />
      <span className="v num">{text}</span>
    </div>
  );
}

/** Ten arcs around a ring, one per region, lit by its firing rate. */
function BrainGlyph({ rates, max, names }: { rates: Float32Array | null; max: number; names: string[] }) {
  const n = Math.max(1, names.length);
  const R = 20, C = 26;
  const gap = 0.05;
  const arcs = names.map((name, i) => {
    const a0 = (i / n) * Math.PI * 2 - Math.PI / 2 + gap;
    const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2 - gap;
    const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0);
    const x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const v = rates ? Math.min(1, (rates[i] ?? 0) / max) : 0;
    return { name, d: `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`, v, color: regionColor(i) };
  });
  return (
    <svg className="brainglyph" width="52" height="52" viewBox="0 0 52 52" role="img" aria-label="Region activity">
      <circle className="ring" cx={C} cy={C} r={R} />
      {arcs.map((a) => (
        <path key={a.name} className="arc" d={a.d} stroke={a.color} opacity={0.12 + 0.88 * a.v}
          style={{ filter: a.v > 0.5 ? `drop-shadow(0 0 3px ${a.color})` : 'none' }}>
          <title>{a.name}</title>
        </path>
      ))}
      <circle className="core" cx={C} cy={C} r={9} />
    </svg>
  );
}

const DRIVE_TONE: Partial<Record<(typeof OUTPUT_CHANNELS)[number], Tone>> = { aggression: 'fight', courtship: 'love', sing: 'love', sleep: 'sleep' };
const GLOW: Record<Tone, string> = { neutral: 'transparent', accent: 'transparent', fight: 'rgba(217,67,47,.4)', love: 'rgba(230,155,31,.42)', sleep: 'rgba(63,111,216,.38)' };

export function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const citizens = useStore((s) => s.citizens);
  const manifest = useStore((s) => s.manifest);
  const focus = useStore((s) => s.focus);
  const followId = useStore((s) => s.followId);
  const api = useStore((s) => s.worldApi);

  const c = selectedId === null ? undefined : citizens.find((x) => x.id === selectedId);
  const regionNames = useMemo(() => (manifest ? Object.keys(manifest.regions) : []), [manifest]);
  const names = useMemo(() => new Map(citizens.map((x) => [x.id, x.name])), [citizens]);

  const live = c && focus && focus.agentId === c.id ? focus : null;
  let meanHz = 0;
  if (live && live.regionRates.length) { for (let i = 0; i < live.regionRates.length; i++) meanHz += live.regionRates[i]; meanHz /= live.regionRates.length; }
  const easedHz = useEased(meanHz, 6);

  if (!c || !manifest) return null;

  const maxHz = live ? Math.max(20, ...Array.from(live.regionRates)) : 20;
  const hzScale = Math.ceil(maxHz / 10) * 10;

  let dom = -1, domV = 0.05;
  for (let i = 0; i < OUTPUT_CHANNELS.length; i++) {
    if (OUTPUT_CHANNELS[i] === 'clock') continue;
    const v = c.outputs[i] ?? 0;
    if (v > domV) { domV = v; dom = i; }
  }
  const domCh = dom >= 0 ? OUTPUT_CHANNELS[dom] : null;
  const domTone: Tone = domCh ? (DRIVE_TONE[domCh] ?? 'accent') : 'neutral';
  const glow = domCh === 'courtship' || domCh === 'aggression' || domCh === 'sleep' ? GLOW[domTone] : 'transparent';
  const following = followId === c.id;
  const pct = (v: number) => `${Math.round((v ?? 0) * 100)}`;

  return (
    <section className="inspector enter" aria-label={`Inspector: ${c.name}`}
      style={{ '--glow': glow, '--glow-a': glow === 'transparent' ? 0 : 1 } as CSSProperties}>
      <div className="halo" aria-hidden />
      <div className="glass body">
        <div className="ihead">
          <div className="who">
            <div className="name">{c.name} <span className="glyph">{sexGlyph(c.sex)}</span></div>
            <div className="meta">
              Neurons <span className="num">{fmtInt(manifest.neurons)}</span> · Connections <span className="num">{fmtInt(manifest.edges)}</span> — real MaleCNS subgraph
            </div>
          </div>
          <button className="btn icon ghost" onClick={() => api?.select(null)} aria-label="Close inspector" title="Close (Esc)">
            <IconClose size={14} />
          </button>
        </div>

        <div className="scroll">
          <p className="thought">{c.thought || '…'}</p>

          <div className="hero">
            <div className="readouts">
              <div className="hz">
                <span className="big">{easedHz.toFixed(1)}<em>Hz</em></span>
                <span className="l">mean rate across regions</span>
              </div>
              <span className="spacer" />
              <BrainGlyph rates={live ? live.regionRates : null} max={hzScale} names={regionNames} />
            </div>
            <div className="raster-wrap">
              <SpikeRaster manifest={manifest} focus={live} agentId={c.id} />
            </div>
            <div className="raster-legend">
              {regionNames.map((r, i) => <span key={r}><i style={{ '--c': regionColor(i) } as CSSProperties} />{r}</span>)}
            </div>
          </div>

          <div className="sec">
            <div className="sh"><span className="t">Regions</span><span className="u">Hz, 0–{hzScale}</span></div>
            {regionNames.map((r, i) => {
              const hz = live ? live.regionRates[i] ?? 0 : 0;
              return <Bar key={r} label={r} v={hz / hzScale} text={hz.toFixed(1)} color={regionColor(i)} />;
            })}
          </div>

          <div className="sec">
            <div className="sh"><span className="t">Senses</span><span className="u">input drive</span></div>
            <div className="two-col">
              {INPUT_CHANNELS.map((ch, i) => <Bar key={ch} label={INPUT_LABELS[ch]} v={c.inputs[i] ?? 0} text={pct(c.inputs[i])} />)}
            </div>
          </div>

          <div className="sec">
            <div className="sh">
              <span className="t">Drives</span>
              {domCh && <span key={domCh} className={`dom-chip ${domTone}`}>{outputLabel(domCh, c.sex)}</span>}
            </div>
            <div className="two-col">
              {OUTPUT_CHANNELS.map((ch, i) => (
                <Bar key={ch} label={outputLabel(ch, c.sex)} v={c.outputs[i] ?? 0} text={pct(c.outputs[i])} dominant={i === dom} lum />
              ))}
            </div>
          </div>

          <div className="sec">
            <div className="sh"><span className="t">Top firing cell types</span><span className="u">Hz</span></div>
            {live && live.topTypes.length > 0 ? (
              <div className="types">
                {live.topTypes.slice(0, 8).map((t, i) => (
                  <div key={`${t.typeId}-${i}`} style={{ display: 'contents' }}>
                    <span className="tn" title={`type #${t.typeId}`}>{manifest.types[t.typeId] ?? `#${t.typeId}`}</span>
                    <span className={`th${i === 0 ? ' hot' : ''}`}>{t.hz.toFixed(1)}</span>
                  </div>
                ))}
              </div>
            ) : <div className="muted" style={{ fontSize: 12 }}>Nothing firing yet.</div>}
          </div>

          <div className="sec" style={{ paddingBottom: 14 }}>
            <div className="sh"><span className="t">Body</span><span className="u">slow state, stands in for neuromodulation</span></div>
            <div className="body-state">
              <div><span className="l">Hunger</span><span className="b hunger" style={cssVar(c.hunger)} /></div>
              <div><span className="l">Dust</span><span className="b dust" style={cssVar(c.dust)} /></div>
              <div><span className="l">Energy</span><span className="b energy" style={cssVar(c.energy)} /></div>
              <div><span className="l">Injury</span><span className="b injury" style={cssVar(c.injury)} /></div>
            </div>
            {c.bondWith !== null && <div className="bond">In love with {names.get(c.bondWith) ?? 'someone'}</div>}
          </div>
        </div>

        <div className="ifoot">
          <button
            className={`btn outline${following ? ' is-on' : ''}`}
            onClick={() => api?.follow(following ? null : c.id)}
            disabled={!api}
            title={following ? 'Back to god view (Esc)' : 'Follow (F)'}
          >
            <IconFollow size={14} /> {following ? 'Following' : 'Follow'}
          </button>
        </div>
      </div>
    </section>
  );
}
