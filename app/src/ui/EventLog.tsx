import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import { useStore, type EventKind, type GameEvent } from '../store';
import { eventTone } from './labels';
import { useNameSig } from './selectors';
import { IconBolt, IconDust, IconFeed, IconFight, IconInfo, IconLove, IconScare, IconSleep } from './icons';

const SHOW = 6;

function KindIcon({ k }: { k: EventKind }) {
  switch (k) {
    case 'love': return <IconLove size={13} />;
    case 'fight': return <IconFight size={13} />;
    case 'eat': return <IconFeed size={13} />;
    case 'escape': return <IconScare size={13} />;
    case 'groom': return <IconDust size={13} />;
    case 'sleep': return <IconSleep size={13} />;
    case 'sing': return <IconLove size={13} />;
    case 'god': return <IconBolt size={13} />;
    case 'info': return <IconInfo size={13} />;
  }
}

const pick = (id: number) => useStore.getState().worldApi?.select(id);

/** Split the event text on actor names so each name becomes a clickable span. */
const Line = memo(function Line({ e, names }: { e: GameEvent; names: Map<number, string> }) {
  const parts = useMemo(() => {
    const actors = e.actors
      .map((id) => ({ id, name: names.get(id) ?? '' }))
      .filter((a) => a.name.length > 0)
      .sort((a, b) => b.name.length - a.name.length);
    if (actors.length === 0) return [e.text];
    const re = new RegExp(`(${actors.map((a) => a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
    const out: ReactNode[] = [];
    e.text.split(re).forEach((seg, i) => {
      const a = actors.find((x) => x.name === seg);
      out.push(a
        ? <span key={i} className="actor" role="button" tabIndex={0} onClick={() => pick(a.id)}
            onKeyDown={(ev) => { if (ev.key === 'Enter') pick(a.id); }}>{seg}</span>
        : seg);
    });
    return out;
  }, [e, names]);
  return <>{parts}</>;
});

export const EventLog = memo(function EventLog() {
  const events = useStore((s) => s.events);
  const nameSig = useNameSig();
  const names = useMemo(() => {
    const m = new Map<number, string>();
    for (const line of nameSig.split('\n')) { if (!line) continue; const i = line.indexOf(':'); m.set(Number(line.slice(0, i)), line.slice(i + 1)); }
    return m;
  }, [nameSig]);
  const recent = events.slice(-SHOW);

  return (
    <div className="events" aria-live="polite" aria-label="Recent events">
      {recent.map((e, i) => {
        const age = recent.length - 1 - i;
        const o = Math.max(0.28, 1 - age * 0.15);
        return (
          <div key={e.id} className={`ev ${eventTone(e.kind)}`} style={{ '--o': o } as CSSProperties}>
            <span className="k"><KindIcon k={e.kind} /></span>
            <span className="txt"><Line e={e} names={names} /></span>
          </div>
        );
      })}
    </div>
  );
});
