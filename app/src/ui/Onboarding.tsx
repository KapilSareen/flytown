import { useCallback, useEffect, useState } from 'react';
import { useUi } from './uiStore';
import { IconClose } from './icons';
import { NeuronField } from './motion';

const CARDS = [
  {
    title: 'A town of people with fly brains',
    body: (
      <>
        <p>Each person you see is driven by a real piece of a fruit fly's brain: the MaleCNS connectome, stepped neuron by neuron in your browser.</p>
        <p>They smell food, notice each other, get dusty, sing, fight, fall in love and fall asleep because those circuits fire, not because we scripted it.</p>
      </>
    ),
  },
  {
    title: 'What is real and what is ours',
    body: (
      <>
        <p><strong>Real:</strong> the wiring between neurons, which synapses excite or inhibit, and the neuron model from Shiu et al. 2024.</p>
        <p><strong>Ours:</strong> which cells we treat as senses and which as drives, the slow body state (hunger, dust, energy), and the plain-language thoughts, which are readings of activity, not language. Women run a male brain with male-only cells silenced.</p>
      </>
    ),
  },
  {
    title: 'Controls',
    body: (
      <>
        <p>Click a citizen to open their brain. Double-click to follow them. Use the dock at the bottom to play god.</p>
        <div className="keys">
          <span className="kbd">Space</span><span>pause and resume</span>
          <span className="kbd">F</span><span>follow the selected citizen</span>
          <span className="kbd">Esc</span><span>back to god view</span>
          <span className="kbd">1–4</span><span>world speed</span>
        </div>
      </>
    ),
  },
];

export function Onboarding() {
  const open = useUi((s) => s.onboardingOpen);
  const dismissOnboarding = useUi((s) => s.dismissOnboarding);
  const [i, setI] = useState(0);
  const dismiss = useCallback(() => { dismissOnboarding(); setI(0); }, [dismissOnboarding]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); dismiss(); }
      if (e.key === 'ArrowRight') setI((x) => Math.min(CARDS.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, dismiss]);

  if (!open) return null;
  const last = i === CARDS.length - 1;
  const card = CARDS[i];

  return (
    <div className="scrim cine">
      <NeuronField className="field" count={160} />
      <div className="glass modal onb" role="dialog" aria-modal="true" aria-labelledby="onb-title">
        <div className="mhead">
          <div className="steps" aria-label={`Step ${i + 1} of ${CARDS.length}`}>
            {CARDS.map((_, k) => <i key={k} className={k <= i ? 'on' : ''} />)}
          </div>
          <span style={{ flex: 1 }} />
          <button className="btn icon ghost" onClick={dismiss} aria-label="Skip intro"><IconClose size={14} /></button>
        </div>
        <div className="mbody card" key={i}>
          <h2 id="onb-title">{card.title}</h2>
          {card.body}
        </div>
        <div className="mfoot">
          {i > 0 && <button className="btn ghost" onClick={() => setI(i - 1)}>Back</button>}
          <span className="grow" />
          {last
            ? <button className="btn primary" onClick={dismiss}>Enter the town</button>
            : <button className="btn primary" onClick={() => setI(i + 1)}>Next</button>}
        </div>
      </div>
    </div>
  );
}
