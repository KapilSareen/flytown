import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import { useStore, type Action } from '../store';
import { useUi } from './uiStore';
import { ACTION_LABELS, actionTone } from './labels';
import { useCitizenIdSig, useCitizenRow } from './selectors';
import { IconChevron, IconDust, IconFeed, IconFight, IconLove, IconPeople, IconScare, IconSleep } from './icons';

const ACTION_ICON: Partial<Record<Action, ReactNode>> = {
  eat: <IconFeed />, groom: <IconDust />, sing: <IconLove />, court: <IconLove />, fight: <IconFight />,
  hurt: <IconFight />, escape: <IconScare />, sleep: <IconSleep />,
};

/** One row. Subscribes to its own citizen with a quantised equality, so a publish that
 *  changes nothing visible here does not render it. */
const Row = memo(function Row({ id, selected }: { id: number; selected: boolean }) {
  const c = useCitizenRow(id);
  if (!c) return null;
  const tone = actionTone(c.action);
  return (
    <button
      className={`cit${selected ? ' is-selected' : ''}`}
      onClick={(e) => {
        if (e.shiftKey) useUi.getState().setSlotB(c.id);
        useStore.getState().worldApi?.select(c.id);
      }}
      onDoubleClick={() => useStore.getState().worldApi?.follow(c.id)}
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
});

export const Roster = memo(function Roster() {
  const sig = useCitizenIdSig();
  const ids = useMemo(() => (sig ? sig.split(',').map(Number) : []), [sig]);
  const selectedId = useStore((s) => s.selectedId);
  const open = useUi((s) => s.rosterOpen);

  return (
    <aside className={`glass roster enter${open ? '' : ' collapsed'}`} aria-label="Citizens">
      <div className="head">
        <IconPeople size={15} />
        <span className="title">Citizens</span>
        <span className="count num">{ids.length}</span>
        <span className="grow" />
        <button className="btn icon ghost" onClick={() => useUi.getState().setRosterOpen(!open)} aria-label={open ? 'Collapse roster' : 'Expand roster'} title={open ? 'Collapse' : 'Expand'}>
          <IconChevron size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms ease-out' }} />
        </button>
      </div>
      <div className="list">
        {ids.length === 0 && <div className="empty">No one lives here yet. Spawn someone from the toolbar.</div>}
        {ids.map((id) => <Row key={id} id={id} selected={id === selectedId} />)}
      </div>
    </aside>
  );
});
