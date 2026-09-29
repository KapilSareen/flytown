import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useStore, type EventKind, type GameEvent } from '../store';
import { eventTone } from './labels';
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

/** Split the event text on actor names so each name becomes a clickable span. */
function Line({ e, names, onPick }: { e: GameEvent; names: Map<number, string>; onPick: (id: number) => void }) {
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
        ? <span key={i} className="actor" role="button" tabIndex={0} onClick={() => onPick(a.id)}
            onKeyDown={(ev) => { if (ev.key === 'Enter') onPick(a.id); }}>{seg}</span>
        : seg);
    });
    return out;
  }, [e, names, onPick]);
  return <>{parts}</>;
}

export function EventLog() {
  const events = useStore((s) => s.events);
  const citizens = useStore((s) => s.citizens);
  const api = useStore((s) => s.worldApi);
  const names = useMemo(() => new Map(citizens.map((c) => [c.id, c.name])), [citizens]);
  const recent = events.slice(-SHOW);
  const pick = (id: number) => api?.select(id);

  return (
    <div className="events" aria-live="polite" aria-label="Recent events">
      {recent.map((e, i) => {
        const age = recent.length - 1 - i;
        const o = Math.max(0.28, 1 - age * 0.15);
        return (
          <div key={e.id} className={`ev ${eventTone(e.kind)}`} style={{ '--o': o } as CSSProperties}>
            <span className="k"><KindIcon k={e.kind} /></span>
            <span className="txt"><Line e={e} names={names} onPick={pick} /></span>
          </div>
        );
      })}
    </div>
  );
}
