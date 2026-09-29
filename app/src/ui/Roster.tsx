import type { CSSProperties, ReactNode } from 'react';
import { useStore, type Action, type CitizenView } from '../store';
import { useUi } from './uiStore';
import { ACTION_LABELS, actionTone } from './labels';
import { IconChevron, IconDust, IconFeed, IconFight, IconLove, IconPeople, IconScare, IconSleep } from './icons';

const ACTION_ICON: Partial<Record<Action, ReactNode>> = {
  eat: <IconFeed />, groom: <IconDust />, sing: <IconLove />, court: <IconLove />, fight: <IconFight />,
  hurt: <IconFight />, escape: <IconScare />, sleep: <IconSleep />,
};

function Row({ c, selected }: { c: CitizenView; selected: boolean }) {
  const api = useStore((s) => s.worldApi);
  const setSlotB = useUi((s) => s.setSlotB);
  const tone = actionTone(c.action);
  return (
    <button
      className={`cit${selected ? ' is-selected' : ''}`}
      onClick={(e) => {
        if (e.shiftKey) setSlotB(c.id);
        api?.select(c.id);
      }}
      onDoubleClick={() => api?.follow(c.id)}
      title={`${c.name} — click to select, double-click to follow, shift-click for slot B`}
      aria-pressed={selected}
    >
      <span className={`av ${c.sex}`} style={{ '--skin': c.palette.hair } as CSSProperties} aria-hidden>{c.name.charAt(0)}</span>
      <span className="col">
        <span className="name">{c.name}</span>
        <span className="pips" aria-hidden>
          <i className="hunger" style={{ '--v': c.hunger } as CSSProperties} title="hunger" />
          <i className="dust" style={{ '--v': c.dust } as CSSProperties} title="dust" />
          <i className="energy" style={{ '--v': c.energy } as CSSProperties} title="energy" />
        </span>
      </span>
      <span className={`pill ${tone}`}>{ACTION_ICON[c.action]}{ACTION_LABELS[c.action]}</span>
    </button>
  );
}

export function Roster() {
  const citizens = useStore((s) => s.citizens);
  const selectedId = useStore((s) => s.selectedId);
  const open = useUi((s) => s.rosterOpen);
  const setOpen = useUi((s) => s.setRosterOpen);

  return (
    <aside className={`glass roster enter${open ? '' : ' collapsed'}`} aria-label="Citizens">
      <div className="head">
        <IconPeople size={15} />
        <span className="title">Citizens</span>
        <span className="count num">{citizens.length}</span>
        <span className="grow" />
        <button className="btn icon ghost" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse roster' : 'Expand roster'} title={open ? 'Collapse' : 'Expand'}>
          <IconChevron size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms ease-out' }} />
        </button>
      </div>
      <div className="list">
        {citizens.length === 0 && <div className="empty">No one lives here yet. Spawn someone from the toolbar.</div>}
        {citizens.map((c) => <Row key={c.id} c={c} selected={c.id === selectedId} />)}
      </div>
    </aside>
  );
}
