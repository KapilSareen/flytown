import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { INPUT_CHANNELS, OUTPUT_CHANNELS, type InjectTarget, type InputChannel, type OutputChannel } from '../brain/types';
import { useStore, type CitizenView } from '../store';
import { useUi } from './uiStore';
import { INPUT_LABELS, outputLabel } from './labels';
import { TOWN_POWERS, castTownPower, type TownPower } from './townPowers';
import {
  IconBolt, IconCalm, IconChevron, IconClose, IconFeed, IconFestival, IconFight, IconLove, IconLoveWave, IconMute,
  IconPanic, IconPunish, IconRemove, IconReward, IconRiot, IconScare, IconSleep, IconSpawn,
} from './icons';

/** Procedural avatar from the citizen palette: head, hair, shoulders. */
export function Avatar({ c, size = 36 }: { c: CitizenView; size?: number }) {
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 28 28" aria-hidden>
      <circle cx="14" cy="14" r="14" fill={c.sex === 'male' ? 'rgba(63,111,216,.18)' : 'rgba(226,88,138,.18)'} />
      <path d="M4 28c0-6 4.5-9 10-9s10 3 10 9z" fill={c.palette.top} />
      <circle cx="14" cy="12" r="6" fill={c.palette.skin} />
      <path d="M8 11.5a6 6 0 0 1 12 0c-1.5-1.8-3.5-2.6-6-2.6s-4.5.8-6 2.6z" fill={c.palette.hair} />
    </svg>
  );
}

function Slot({ tag, c, onClear }: { tag: 'A' | 'B'; c: CitizenView | undefined; onClear: () => void }) {
  return (
    <div className={`slot${c ? ' filled' : ''}`} title={c ? `${tag}: ${c.name}` : `Click a citizen to fill slot ${tag}`}>
      {c ? <Avatar c={c} /> : <span className="avatar empty" />}
      <span className="col">
        <span className="tag">{tag}</span>
        <span className="nm">{c ? c.name : 'pick'}</span>
      </span>
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

const TOWN_ICON: Record<TownPower['key'], ReactNode> = {
  riot: <IconRiot size={22} />, festival: <IconFestival size={22} />, loveWave: <IconLoveWave size={22} />,
  panic: <IconPanic size={22} />, calm: <IconCalm size={22} />,
};

/** One toolbar button: coloured icon disc, label, optional hotkey badge. */
function Tb({ id, label, icon, tone = 'ink', hotkey, disabled, title, pulse, onClick, children }: {
  id: string; label: string; icon: ReactNode; tone?: string; hotkey?: string; disabled?: boolean; title: string;
  pulse: string | null; onClick: () => void; children?: ReactNode;
}) {
  return (
    <button className={`tb ${tone}${pulse === id ? ' pulse' : ''}`} disabled={disabled} onClick={onClick} title={title} aria-label={label}>
      <span className="ic">{icon}</span>
      <span className="lb">{label}</span>
      {hotkey && <span className="hk">{hotkey}</span>}
      {children}
    </button>
  );
}

interface ActionDef { key: string; label: string; icon: ReactNode; tone?: string; needs: 1 | 2; hint: string; run: (a: number, b: number) => void }

export function GodPanel() {
  const api = useStore((s) => s.worldApi);
  const citizens = useStore((s) => s.citizens);
  const manifest = useStore((s) => s.manifest);
  const selectedId = useStore((s) => s.selectedId);
  const { slotA, slotB, setSlotA, setSlotB, offerSelection, advancedOpen, setAdvancedOpen } = useUi();

  useEffect(() => { if (selectedId !== null) offerSelection(selectedId); }, [selectedId, offerSelection]);
  useEffect(() => {
    if (slotA !== null && !citizens.some((c) => c.id === slotA)) setSlotA(null);
    if (slotB !== null && !citizens.some((c) => c.id === slotB)) setSlotB(null);
  }, [citizens, slotA, slotB, setSlotA, setSlotB]);

  const A = citizens.find((c) => c.id === slotA);
  const B = citizens.find((c) => c.id === slotB);

  const [pulse, setPulse] = useState<string | null>(null);
  useEffect(() => {
    if (!pulse) return;
    const t = setTimeout(() => setPulse(null), 520);
    return () => clearTimeout(t);
  }, [pulse]);
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

  // spawn dropdown
  const [spawnOpen, setSpawnOpen] = useState(false);
  const spawnRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!spawnOpen) return;
    const onDown = (e: PointerEvent) => { if (spawnRef.current && !spawnRef.current.contains(e.target as Node)) setSpawnOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setSpawnOpen(false); } };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [spawnOpen]);

  const g = api?.god;
  const pair: ActionDef[] = [
    { key: 'fight', label: 'Fight', icon: <IconFight size={22} />, tone: 'ink', needs: 2, hint: 'Pair · A and B square up and fight', run: (a, b) => g?.fight(a, b) },
    { key: 'love', label: 'Love', icon: <IconLove size={22} />, tone: 'ink', needs: 2, hint: 'Pair · A courts B; if it takes, they bond', run: (a, b) => g?.love(a, b) },
  ];
  const person: ActionDef[] = [
    { key: 'scare', label: 'Scare', icon: <IconScare size={22} />, tone: 'ink', needs: 1, hint: 'Person · a shadow looms: A jumps and runs', run: (a) => g?.scare(a) },
    { key: 'remove', label: 'Remove', icon: <IconRemove size={22} />, tone: 'ink', needs: 1, hint: 'Person · A leaves town for good', run: (a) => g?.remove(a) },
  ];
  const reflex: (ActionDef & { why: string })[] = [
    { key: 'feed', label: 'Feed', icon: <IconFeed size={22} />, needs: 1, hint: 'Feed A', run: (a) => g?.feed(a),
      why: 'Starve them and fire the sugar-taste neurons: they walk to a café and eat (sugar → MN9, the reflex Shiu et al. confirmed in real flies).' },
    { key: 'sleep', label: 'Sleep', icon: <IconSleep size={22} />, tone: 'cool', needs: 1, hint: 'Put A to sleep', run: (a) => g?.sleep(a),
      why: 'Drive the R5 sleep neurons: they go find a bed.' },
    { key: 'reward', label: 'Reward', icon: <IconReward size={22} />, tone: 'amber', needs: 1, hint: 'Reward A', run: (a) => g?.reward(a),
      why: "Fire the PAM dopamine neurons (the fly's reward signal)." },
    { key: 'punish', label: 'Punish', icon: <IconPunish size={22} />, tone: 'red', needs: 1, hint: 'Punish A', run: (a) => g?.punish(a),
      why: "Fire the PPL1 dopamine neurons (the fly's punishment signal)." },
  ];
  const fire = (d: ActionDef) => {
    if (!g || A === undefined || (d.needs === 2 && B === undefined)) return;
    d.run(A.id, B?.id ?? -1);
    setPulse(d.key);
    if (d.key === 'love') { setLinkTone('love'); setHearts((h) => h + 1); }
    if (d.key === 'fight') setLinkTone('fight');
  };
  const disabledHint = (d: ActionDef) => (!g ? 'World not ready' : d.needs === 2 && (!A || !B) ? 'Select two citizens' : !A ? 'Select a citizen' : d.hint);
  const renderAction = (d: ActionDef) => {
    const disabled = !g || !A || (d.needs === 2 && !B);
    return (
      <Tb key={d.key} id={d.key} label={d.label} icon={d.icon} tone={d.tone} disabled={disabled} title={disabledHint(d)} pulse={pulse} onClick={() => fire(d)}>
        {d.key === 'love' && hearts > 0 && <HeartBurst key={hearts} />}
      </Tb>
    );
  };
  const fireTown = (p: TownPower) => { if (castTownPower(p.key)) setPulse(p.key); };

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
    <div className="godwrap enter">
      {advancedOpen && (
        <div className="glass drawer" role="region" aria-label="Advanced">
          <div className="dhead">
            <span className="eyebrow">Reflex demos</span>
            <span className="grow" />
            <button className="btn icon ghost" onClick={() => setAdvancedOpen(false)} aria-label="Close advanced"><IconClose size={14} /></button>
          </div>
          <div className="reflex">
            {reflex.map((d) => (
              <div key={d.key} className="rrow">
                {renderAction(d)}
                <span className="why">{d.why}</span>
              </div>
            ))}
          </div>
          <span className="eyebrow" style={{ marginTop: 6 }}>Raw injection</span>
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
                <input type="text" list="god-types" placeholder="Type name, e.g. DNp09" value={typeName}
                  onChange={(e) => setTypeName(e.target.value)} aria-label="Cell type" spellCheck={false} />
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

      <div className="glass god" role="toolbar" aria-label="God toolbar">
        <div className="slots">
          <Slot tag="A" c={A} onClear={() => setSlotA(null)} />
          <span className={`link${A && B ? ' lit' : ''}${linkTone ? ` ${linkTone}` : ''}`} aria-hidden />
          <Slot tag="B" c={B} onClear={() => setSlotB(null)} />
        </div>
        <span className="sep" />
        {pair.map(renderAction)}
        <span className="sep" />
        {person.map(renderAction)}
        <span className="sep" />
        {TOWN_POWERS.map((p) => (
          <Tb key={p.key} id={p.key} label={p.label} icon={TOWN_ICON[p.key]} tone={p.tone} hotkey={p.hotkey} disabled={!g}
            title={`Town · ${p.hint(A?.name ?? null)} (${p.hotkey})`} pulse={pulse} onClick={() => fireTown(p)} />
        ))}
        <span className="sep" />
        <div className="spawnwrap" ref={spawnRef}>
          <Tb id="spawn" label="Spawn" icon={<IconSpawn size={22} />} tone="ink" disabled={!g} title="Spawn · a new citizen arrives" pulse={pulse} onClick={() => setSpawnOpen(!spawnOpen)} />
          {spawnOpen && (
            <div className="glass spawnmenu" role="menu">
              <button role="menuitem" onClick={() => { g?.spawn('male'); setPulse('spawn'); setSpawnOpen(false); }}><span className="sx m">♂</span> Man</button>
              <button role="menuitem" onClick={() => { g?.spawn('female'); setPulse('spawn'); setSpawnOpen(false); }}><span className="sx f">♀</span> Woman</button>
            </div>
          )}
        </div>
        <button className={`adv${advancedOpen ? ' open' : ''}`} onClick={() => setAdvancedOpen(!advancedOpen)} aria-expanded={advancedOpen} title="Advanced · reflex demos and raw neuron injection">
          <IconChevron size={14} />
          <span className="lb">Advanced</span>
        </button>
      </div>
    </div>
  );
}
