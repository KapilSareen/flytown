import { useEffect } from 'react';
import { useStore } from '../store';
import { useUi } from './uiStore';
import { fmtInt } from './labels';
import { IconClose } from './icons';

export function About() {
  const open = useUi((s) => s.aboutOpen);
  const close = useUi((s) => s.setAboutOpen);
  const reopenOnboarding = useUi((s) => s.reopenOnboarding);
  const m = useStore((s) => s.manifest);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open) return null;
  const lif = m?.lif;
  const hops = m?.pruning?.hops;
  const minSyn = m?.pruning?.minSynapses;

  return (
    <div className="scrim" onClick={() => close(false)}>
      <div className="glass modal" role="dialog" aria-modal="true" aria-labelledby="about-title" onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          <h2 id="about-title">What is real here</h2>
          <button className="btn icon ghost" onClick={() => close(false)} aria-label="Close"><IconClose size={14} /></button>
        </div>
        <div className="mbody">
          {m && (
            <div className="facts">
              <div><span className="num">{fmtInt(m.neurons)}</span><span className="l">neurons per citizen</span></div>
              <div><span className="num">{fmtInt(m.edges)}</span><span className="l">connections</span></div>
              <div><span className="num">{fmtInt(m.synapses)}</span><span className="l">synapses</span></div>
              <div><span className="num">{fmtInt(m.fullBrain.neurons)}</span><span className="l">neurons in the full brain</span></div>
              <div><span className="num">{fmtInt(m.fullBrain.edges)}</span><span className="l">edges in the full brain</span></div>
              <div><span className="num">{m.types.length}</span><span className="l">cell types</span></div>
            </div>
          )}

          <h3>Real wiring, pruned</h3>
          <p>
            Every citizen runs the same subgraph of the MaleCNS connectome: {m ? fmtInt(m.neurons) : 'N'} neurons and {m ? fmtInt(m.edges) : 'M'} connections
            out of {m ? fmtInt(m.fullBrain.neurons) : '164,740'} neurons and {m ? fmtInt(m.fullBrain.edges) : '6.2M'} edges in the graph of connections with at least {typeof minSyn === 'number' ? minSyn : 5} synapses.
            The subgraph was chosen around the mapped sensory and descending circuits{typeof hops === 'number' ? `, ${hops} hops out` : ''}. Nothing was trained.
          </p>

          <h3>One weight, three fixes</h3>
          <p>
            Neurons are leaky integrate-and-fire with a single global synaptic weight of {lif ? lif.wSynMv : 0.275} mV per synapse, after Shiu et al. 2024.
            On top sit three gfly-style corrections: a resting bias{lif ? ` (${lif.restingBiasMv} mV)` : ''}, a voltage floor{lif ? ` (${lif.vFloor} mV)` : ''} and input normalisation{lif ? ` (${lif.inputNorm})` : ''}.
            Whether a synapse excites or inhibits comes from machine-learned neurotransmitter predictions.
          </p>

          <h3>The hand-made part</h3>
          <ul>
            <li>Which cell types count as <strong>senses</strong> (looming, odours, taste, touch, song, light) and which count as <strong>drives</strong> (walk, escape, feed, groom, sing, courtship, aggression, sleep) is our reading of the literature, cited in BIOLOGY.md.</li>
            <li>Hunger, dust, energy and injury are slow body variables that scale input gains. They stand in for neuromodulation and are labelled as such.</li>
            <li>There is no learning by default. <strong>Talking</strong> is courtship song. <strong>Thoughts</strong> are interpretations of channel activity, not language.</li>
            <li>Female citizens run the male brain with male-specific cells silenced{m?.sexSpecific ? ` (${fmtInt(m.sexSpecific.maleOnly.length)} neurons)` : ''}; their courtship readout is shown as receptivity.</li>
          </ul>

          <h3>Credits</h3>
          <ul>
            <li><strong>MaleCNS v1.0</strong>, Janelia Research Campus and Google Research, released under CC-BY 4.0.</li>
            <li><strong>Shiu et al. 2024</strong>, <em>A Drosophila computational brain model reveals sensorimotor processing</em>, Nature. The leaky integrate-and-fire parameters.</li>
            <li><strong>gfly</strong>, for the resting bias, voltage floor and input normalisation fixes.</li>
          </ul>
        </div>
        <div className="mfoot">
          <button className="btn ghost" onClick={reopenOnboarding}>Show the intro again</button>
          <span className="grow" />
          <button className="btn primary" onClick={() => close(false)}>Back to town</button>
        </div>
      </div>
    </div>
  );
}
