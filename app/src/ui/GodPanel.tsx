import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { INPUT_CHANNELS, OUTPUT_CHANNELS, type InjectTarget, type InputChannel, type OutputChannel } from '../brain/types';
import { useStore, type CitizenView } from '../store';
import { useUi } from './uiStore';
import { INPUT_LABELS, outputLabel } from './labels';
import {
  IconBolt, IconChevron, IconClose, IconDust, IconFeed, IconFight, IconLove, IconMute, IconPunish,
  IconRemove, IconReward, IconScare, IconSleep, IconSpawn,
} from './icons';

/** Procedural avatar from the citizen palette: head, hair, shoulders. */
export function Avatar({ c, size = 28 }: { c: CitizenView; size?: number }) {
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      <circle cx="14" cy="14" r="14" fill="rgba(255,255,255,.06)" />
      <path d="M4 28c0-6 4.5-9 10-9s10 3 10 9z" fill={c.palette.top} />
      <circle cx="14" cy="12" r="6" fill={c.palette.skin} />
      <path d="M8 11.5a6 6 0 0 1 12 0c-1.5-1.8-3.5-2.6-6-2.6s-4.5.8-6 2.6z" fill={c.palette.hair} />
    </svg>
  );
}

function Slot({ tag, c, onClear }: { tag: 'A' | 'B'; c: CitizenView | undefined; onClear: () => void }) {
  return (
    <div className={`slot${c ? ' filled' : ''}`} title={c ? `${tag}: ${c.name}` : `Click a citizen to fill slot ${tag}`}>
      <span className="tag">{tag}</span>
      {c ? <Avatar c={c} /> : <span className="avatar" style={{ border: '1px dashed rgba(255,255,255,.14)' }} />}
      <span className="nm">{c ? c.name : 'empty'}</span>
      {c && <button className="x" onClick={onClear} aria-label={`Clear slot ${tag}`}><IconClose size={11} /></button>}
    </div>
  );
}

const HEART_DIRS = [[-26, -34], [0, -42], [26, -34], [-38, -12], [38, -12], [-18, -48], [18, -48], [0, -22]];
function HeartBurst() {
  return (
    <span className="hearts" aria-hidden>
      {HEART_DIRS.map(([dx, dy], i) => (
        <i key={i} style={{ '--dx': `${dx}px`, '--dy': `${dy}px`, animationDelay: `${i * 28}ms` } as CSSProperties}>
          <svg viewBox="0 0 16 16"><path d="M8 13.5S2 9.8 2 5.8A3 3 0 0 1 8 4.5a3 3 0 0 1 6 1.3c0 4-6 7.7-6 7.7z" /></svg>
        </i>
      ))}
    </span>
  );
}

interface ActionDef { key: string; label: string; icon: ReactNode; tone?: 'fight' | 'love' | 'sleep'; needs: 0 | 1 | 2; run: (a: number, b: number) => void }

export function GodPanel() {
  const api = useStore((s) => s.worldApi);
  const citizens = useStore((s) => s.citizens);
  const manifest = useStore((s) => s.manifest);
  const selectedId = useStore((s) => s.selectedId);
  const { slotA, slotB, setSlotA, setSlotB, offerSelection, advancedOpen, setAdvancedOpen } = useUi();

  // selection feeds the slots: first pick -> A, a different pick -> B
  useEffect(() => { if (selectedId !== null) offerSelection(selectedId); }, [selectedId, offerSelection]);
  // drop slots whose citizen left town
  useEffect(() => {
    if (slotA !== null && !citizens.some((c) => c.id === slotA)) setSlotA(null);
    if (slotB !== null && !citizens.some((c) => c.id === slotB)) setSlotB(null);
  }, [citizens, slotA, slotB, setSlotA, setSlotB]);

  const A = citizens.find((c) => c.id === slotA);
  const B = citizens.find((c) => c.id === slotB);
  const [pulse, setPulse] = useState<string | null>(null);
  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(null), 480);
    return () => clearTimeout(t);
  }, [pulse]);
  // A–B connector lights pink on Love, red on Fight, for a moment
  const [linkTone, setLinkTone] = useState<'love' | 'fight' | null>(null);
  useEffect(() => {
    if (!linkTone) return;
    const t = setTimeout(() => setLinkTone(null), 1100);
    return () => clearTimeout(t);
  }, [linkTone]);
  const [hearts, setHearts] = useState(0);
  useEffect(() => {
    if (!hearts) return;
    const t = setTimeout(() => setHearts(0), 950);
    return () => clearTimeout(t);
  }, [hearts]);

  const g = api?.god;
  const actions: ActionDef[] = [
    { key: 'fight', label: 'Fight', icon: <IconFight />, tone: 'fight', needs: 2, run: (a, b) => g?.fight(a, b) },
    { key: 'love', label: 'Love', icon: <IconLove />, tone: 'love', needs: 2, run: (a, b) => g?.love(a, b) },
    { key: 'feed', label: 'Feed', icon: <IconFeed />, needs: 1, run: (a) => g?.feed(a) },
    { key: 'scare', label: 'Scare', icon: <IconScare />, needs: 1, run: (a) => g?.scare(a) },
    { key: 'dust', label: 'Dust', icon: <IconDust />, needs: 1, run: (a) => g?.dust(a) },
    { key: 'sleep', label: 'Sleep', icon: <IconSleep />, tone: 'sleep', needs: 1, run: (a) => g?.sleep(a) },
    { key: 'reward', label: 'Reward', icon: <IconReward />, needs: 1, run: (a) => g?.reward(a) },
    { key: 'punish', label: 'Punish', icon: <IconPunish />, needs: 1, run: (a) => g?.punish(a) },
  ];
  const fire = (d: ActionDef) => {
    if (!g) return;
    if (d.needs >= 1 && A === undefined) return;
    if (d.needs === 2 && B === undefined) return;
    d.run(A?.id ?? -1, B?.id ?? -1);
    setPulse(d.key);
    if (d.key === 'love') { setLinkTone('love'); setHearts((h) => h + 1); }
    if (d.key === 'fight') setLinkTone('fight');
  };

  // --- advanced: inject / silence / modulate ---
  const [targetKind, setTargetKind] = useState<'channel' | 'type'>('channel');
  const [channel, setChannel] = useState<string>('reward');
  const [typeName, setTypeName] = useState('');
  const [gainMv, setGainMv] = useState(10);
  const [ms, setMs] = useState(500);
  const [modChannel, setModChannel] = useState<InputChannel>('odorFood');
  const [modGain, setModGain] = useState(1);
  const typeId = useMemo(() => (manifest ? manifest.types.indexOf(typeName) : -1), [manifest, typeName]);
  const target: InjectTarget | null = targetKind === 'channel'
    ? { channel: channel as InputChannel | OutputChannel }
    : typeId >= 0 ? { typeId } : null;
  const canInject = !!g && A !== undefined && target !== null;

  return (
    <div className="glass god enter" role="toolbar" aria-label="God panel">
      <div className="row">
        <div className="slots">
          <Slot tag="A" c={A} onClear={() => setSlotA(null)} />
          <span className={`link${A && B ? ' lit' : ''}${linkTone ? ` ${linkTone}` : ''}`} aria-hidden />
          <Slot tag="B" c={B} onClear={() => setSlotB(null)} />
        </div>
        {actions.map((d) => {
          const disabled = !g || (d.needs >= 1 && !A) || (d.needs === 2 && !B);
          return (
            <button
              key={d.key}
              className={`gact${d.tone ? ` ${d.tone}` : ''}${pulse === d.key ? ' pulse' : ''}`}
              disabled={disabled}
              onClick={() => fire(d)}
              title={d.needs === 2 ? `${d.label} A and B` : `${d.label} A`}
            >
              {d.icon}<span>{d.label}</span>
              {d.key === 'love' && hearts > 0 && <HeartBurst key={hearts} />}
            </button>
          );
        })}
        <span className="vsep" />
        <button className={`gact${pulse === 'spawnM' ? ' pulse' : ''}`} disabled={!g} onClick={() => { g?.spawn('male'); setPulse('spawnM'); }} title="Spawn a man">
          <IconSpawn /><span>Spawn ♂</span>
        </button>
        <button className={`gact${pulse === 'spawnF' ? ' pulse' : ''}`} disabled={!g} onClick={() => { g?.spawn('female'); setPulse('spawnF'); }} title="Spawn a woman">
          <IconSpawn /><span>Spawn ♀</span>
        </button>
        <button className={`gact fight${pulse === 'remove' ? ' pulse' : ''}`} disabled={!g || !A} onClick={() => { if (A) { g?.remove(A.id); setPulse('remove'); } }} title="Remove A from town">
          <IconRemove /><span>Remove</span>
        </button>
        <span className="vsep" />
        <button className={`disclose${advancedOpen ? ' open' : ''}`} onClick={() => setAdvancedOpen(!advancedOpen)} aria-expanded={advancedOpen}>
          <IconChevron size={12} /> Advanced
        </button>
      </div>

      {advancedOpen && (
        <div className="advanced">
          <div className="line">
            <label>Inject into A</label>
            <div className="seg" role="group" aria-label="Target kind">
              <button className={targetKind === 'channel' ? 'is-on' : ''} onClick={() => setTargetKind('channel')}>Channel</button>
              <button className={targetKind === 'type' ? 'is-on' : ''} onClick={() => setTargetKind('type')}>Cell type</button>
            </div>
            {targetKind === 'channel' ? (
              <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
                <optgroup label="Inputs">
                  {INPUT_CHANNELS.map((c) => <option key={c} value={c}>{INPUT_LABELS[c]}</option>)}
                </optgroup>
                <optgroup label="Outputs">
                  {OUTPUT_CHANNELS.map((c) => <option key={c} value={c}>{outputLabel(c, A?.sex ?? 'male')}</option>)}
                </optgroup>
              </select>
            ) : (
              <>
                <input
                  type="text"
                  list="god-types"
                  placeholder="Type name, e.g. DNp09"
                  value={typeName}
                  onChange={(e) => setTypeName(e.target.value)}
                  aria-label="Cell type"
                  spellCheck={false}
                />
                <datalist id="god-types">
                  {manifest?.types.map((t) => <option key={t} value={t} />)}
                </datalist>
                {typeName && typeId < 0 && <span className="muted" style={{ fontSize: 11 }}>not in manifest</span>}
              </>
            )}
          </div>
          <div className="line">
            <div className="field">
              <label htmlFor="god-gain">Gain</label>
              <input id="god-gain" type="range" min={1} max={30} step={1} value={gainMv} onChange={(e) => setGainMv(+e.target.value)} />
              <span className="num">{gainMv} mV</span>
            </div>
            <div className="field">
              <label htmlFor="god-ms">For</label>
              <input id="god-ms" type="range" min={100} max={5000} step={100} value={ms} onChange={(e) => setMs(+e.target.value)} />
              <span className="num">{ms} ms</span>
            </div>
            <button className="btn primary" disabled={!canInject} onClick={() => { if (A && target) { g?.inject(A.id, target, gainMv, ms); setPulse('inject'); } }}>
              <IconBolt size={14} /> Inject
            </button>
            <button className="btn outline" disabled={!canInject} onClick={() => { if (A && target) { g?.silence(A.id, target, ms); setPulse('silence'); } }}>
              <IconMute size={14} /> Silence
            </button>
          </div>
          <div className="line">
            <label>Modulate</label>
            <select value={modChannel} onChange={(e) => setModChannel(e.target.value as InputChannel)} aria-label="Input channel to modulate">
              {INPUT_CHANNELS.map((c) => <option key={c} value={c}>{INPUT_LABELS[c]}</option>)}
            </select>
            <div className="field">
              <label htmlFor="god-mod">Gain</label>
              <input id="god-mod" type="range" min={0} max={3} step={0.05} value={modGain} onChange={(e) => setModGain(+e.target.value)} />
              <span className="num">{modGain.toFixed(2)}×</span>
            </div>
            <button className="btn outline" disabled={!g || !A} onClick={() => { if (A) { g?.modulate(A.id, modChannel, modGain); setPulse('mod'); } }}>
              Apply
            </button>
            <span className="muted" style={{ fontSize: 11 }}>persistent input gain, the game's neuromodulation knob</span>
          </div>
        </div>
      )}
    </div>
  );
}
