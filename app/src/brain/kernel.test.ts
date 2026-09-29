import { describe, expect, it } from 'vitest';
import { LifKernel } from './kernel';
import { makeGraph, makeManifest } from './testUtil';
import { NI, NO, inputIndex, outputIndex } from './types';

const ACH = 1, GABA = 2;

describe('LifKernel', () => {
  it('propagates a spike along an ACh chain A -> B -> C with synaptic delay', () => {
    const graph = makeGraph(3, [ACH, ACH, ACH], [
      { pre: 0, post: 1, count: 60 },
      { pre: 1, post: 2, count: 60 },
    ]);
    const k = new LifKernel(graph, makeManifest(3));
    k.addAgent({ id: 1, sex: 'male', seed: 7 });
    k.inject(1, { neurons: [0] }, 10, 3);
    const st = k.agentState(1)!;

    k.advance(1);
    expect(st.spikeCount[0]).toBe(1);        // 10 mV over the 2 mV gap: fires at once
    expect(st.spikeCount[1]).toBe(0);
    k.advance(1);                            // delay is 2 steps: B has not received anything yet
    expect(st.spikeCount[1]).toBe(0);
    k.advance(30);
    expect(st.spikeCount[1]).toBeGreaterThan(0);
    expect(st.spikeCount[2]).toBeGreaterThan(0);
    // the active set drains once everything has settled
    k.advance(400);
    expect(st.nAct).toBe(0);
    expect(st.v[2]).toBeCloseTo(-47, 3);     // vRest + restingBias
  });

  it('an inhibitory (GABA) neuron blocks the excitatory drive onto its target', () => {
    const run = (driveInhibitor: boolean) => {
      const graph = makeGraph(3, [ACH, GABA, ACH], [
        { pre: 0, post: 2, count: 60 },
        { pre: 1, post: 2, count: 60 },
      ]);
      const k = new LifKernel(graph, makeManifest(3));
      k.addAgent({ id: 1, sex: 'male', seed: 7 });
      k.inject(1, { neurons: driveInhibitor ? [0, 1] : [0] }, 10, 40);
      k.advance(80);
      return k.agentState(1)!.spikeCount;
    };
    const excOnly = run(false);
    expect(excOnly[0]).toBeGreaterThan(3);
    expect(excOnly[2]).toBeGreaterThan(0);
    const both = run(true);
    expect(both[0]).toBeGreaterThan(3);
    expect(both[1]).toBeGreaterThan(3);
    expect(both[2]).toBe(0);                 // +16.5 mV and -16.5 mV cancel: C never fires
  });

  it('silences male-only neurons in female agents and honours temporary silence', () => {
    const graph = makeGraph(2, [ACH, ACH], [{ pre: 0, post: 1, count: 60 }]);
    const k = new LifKernel(graph, makeManifest(2, { sexSpecific: { maleOnly: [1], note: '' } }));
    k.addAgent({ id: 1, sex: 'male' });
    k.addAgent({ id: 2, sex: 'female' });
    for (const id of [1, 2]) k.inject(id, { neurons: [0] }, 10, 20);
    k.silence(1, { neurons: [1] }, 10);
    k.advance(10);
    expect(k.agentState(1)!.spikeCount[1]).toBe(0);      // silenced for 10 ms
    k.advance(40);
    expect(k.agentState(1)!.spikeCount[1]).toBeGreaterThan(0);
    expect(k.agentState(2)!.spikeCount[0]).toBeGreaterThan(0);
    expect(k.agentState(2)!.spikeCount[1]).toBe(0);      // permanently silenced in the female
  });

  it('drives input channels with Poisson spikes and reads output channel rates', () => {
    // 4 sensory neurons in odorFood all synapse onto neuron 4, which is the 'walk' output.
    const graph = makeGraph(5, [ACH, ACH, ACH, ACH, ACH], [0, 1, 2, 3].map((pre) => ({ pre, post: 4, count: 30 })));
    const manifest = makeManifest(5);
    manifest.channels.inputs.odorFood.neurons = [0, 1, 2, 3];
    manifest.channels.outputs.walk.neurons = [4];
    const k = new LifKernel(graph, manifest);
    k.addAgent({ id: 1, sex: 'male', seed: 99 });
    k.setFocus(1);
    const inputs = new Float32Array(NI);
    inputs[inputIndex('odorFood')] = 1;
    k.setInputs(inputs);
    k.advance(500);
    const st = k.agentState(1)!;
    // each sensory neuron should be firing in the tens of Hz at full drive
    for (let i = 0; i < 4; i++) expect(st.spikeCount[i]).toBeGreaterThan(10);
    expect(st.spikeCount[4]).toBeGreaterThan(0);
    expect(k.outputs.length).toBe(NO);
    expect(k.outputs[outputIndex('walk')]).toBeGreaterThan(0);
    const focus = k.takeFocusReport()!;
    expect(focus.agentId).toBe(1);
    expect(focus.spikes.length).toBeGreaterThan(0);
    expect(focus.regionRates[0]).toBeGreaterThan(0);
    expect(focus.topTypes.length).toBeGreaterThan(0);
    // modulate to zero gain: outputs decay back to zero
    k.modulate(1, 'odorFood', 0);
    k.advance(600);
    expect(k.outputs[outputIndex('walk')]).toBeLessThan(0.01);
    expect(st.nAct).toBe(0);
  });

  it('keeps per-agent state independent and re-lays out I/O on add/remove', () => {
    const graph = makeGraph(2, [ACH, ACH], [{ pre: 0, post: 1, count: 60 }]);
    const k = new LifKernel(graph, makeManifest(2));
    k.addAgent({ id: 10, sex: 'male' });
    k.addAgent({ id: 20, sex: 'male' });
    k.inject(20, { neurons: [0] }, 10, 5);
    k.advance(20);
    expect(k.agentState(10)!.spikeCount[1]).toBe(0);
    expect(k.agentState(20)!.spikeCount[1]).toBeGreaterThan(0);
    expect(k.outputs.length).toBe(2 * NO);
    k.removeAgent(10);
    expect(k.outputs.length).toBe(NO);
    expect(k.agentIndex(20)).toBe(0);
  });
});
