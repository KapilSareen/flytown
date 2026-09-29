// Leaky integrate-and-fire kernel over the compiled connectome. Pure TypeScript,
// no worker/DOM APIs, so it runs identically in lif.worker.ts and in vitest.
//
// Model (Shiu et al. 2024 + the three gfly-style fixes, see ARCHITECTURE.md §6):
//   dv/dt = (vEq - v + g) / tauM        vEq = vRest + restingBiasMv
//   dg/dt = -g / tauSyn                 g in mV ("alpha-like" synaptic variable)
//   spike when v >= vThresh: v = vReset, refractory for refractoryMs (v held at vReset),
//     presynaptic spikes are delivered delaySteps (= round(delayMs/dt)) later:
//     g[post] += weights[e] * wSynMv * ntGain[nt[pre]] * norm[post]
//   v is clamped at vFloor. norm(post) = 1/sqrt(inDeg/meanInDeg) for 'sqrt-mean'.
//
// One kernel holds K agents that share the graph; per-agent state is a handful of
// typed arrays. Only neurons in the per-agent *active list* (non-zero synaptic
// input, away from equilibrium, or refractory) are integrated each step; a
// neuron that has settled is snapped to equilibrium and dropped from the list.
import {
  INPUT_CHANNELS, OUTPUT_CHANNELS, NI, NO,
  type AgentInit, type BrainManifest, type FocusReport, type GraphBuffers,
  type InjectTarget, type InputChannel, type OutputChannel, type Perf,
} from './types';

/** Poisson rate of a sensory neuron when its channel input is 1.0. */
export const INPUT_MAX_HZ = 150;
/** How a sensory "input event" (one Bernoulli hit per ms per neuron) drives the neuron.
 *  'spike': the neuron fires (unless refractory) — sensory rate == channel rate exactly,
 *           which is what tools/validate_brain.py does and what the channel rateMaxHz
 *           values were tuned against.
 *  'conductance': add INPUT_WEIGHT_FACTOR * wSynMv to g instead (softer, stochastic). */
export const INPUT_MODE: 'spike' | 'conductance' = 'spike';
/** Synaptic kick per input event in 'conductance' mode, as a multiple of wSynMv
 *  (20 * 0.275 = 5.5 mV lifts v by ~0.9 mV peak). */
export const INPUT_WEIGHT_FACTOR = 20;
/** EMA time constant of output rates (and focus region/type rates). */
export const OUTPUT_TAU_MS = 50;
export const DEFAULT_RATE_MAX_HZ = 100;
/** Cap on spikes reported per focus window. */
export const FOCUS_SPIKE_CAP = 4000;
const VSAMPLE_N = 256;
/** Below these a neuron counts as settled and leaves the active list. */
const G_EPS = 0.01;
const V_EPS = 0.01;

interface Injection { neurons: Uint32Array; gainMv: number; until: number }

export interface Agent {
  id: number;
  sex: 'male' | 'female';
  rng: number;                 // xorshift32 state
  v: Float32Array;
  g: Float32Array;
  refrac: Float32Array;        // ms of refractory period remaining
  silencedUntil: Float32Array; // sim time (ms) until which the neuron may not spike; +Inf = permanent
  active: Uint8Array;          // membership flag for `act`
  act: Uint32Array;            // active list
  nAct: number;
  pend: Uint32Array[];         // spike ring: pend[s] = spikes to deliver at step s (mod delaySteps)
  pendCount: Int32Array;
  outAcc: Uint32Array;         // spikes per output channel this step
  outEma: Float32Array;        // Hz, per output channel
  modGain: Float32Array;       // 'modulate' multipliers per input channel
  injections: Injection[];
  spikeCount: Uint32Array;     // cumulative spikes per neuron (cheap; used by tests/inspector)
  // focus accumulators (allocated lazily when the agent becomes focused)
  focus: {
    spikes: Uint32Array; nSpikes: number;
    regionAcc: Uint32Array; regionEma: Float32Array;
    typeAcc: Uint32Array; typeEma: Float32Array;
  } | null;
}

export class LifKernel {
  readonly graph: GraphBuffers;
  readonly manifest: BrainManifest;
  readonly n: number;
  readonly agents: Agent[] = [];
  simTimeMs = 0;
  private stepIndex = 0;
  private carryMs = 0;
  /** inputs[a*NI + i] in 0..1, laid out by agent index. */
  private inputs = new Float32Array(0);
  /** outputs[a*NO + o] in 0..1. */
  outputs = new Float32Array(0);
  focusId: number | null = null;
  lastActive = 0;

  // graph-derived constants
  private readonly wEff: Float32Array;       // per edge: signed mV kick to g[post]
  private readonly inputNeurons: Uint32Array[]; // per input channel
  private readonly outputNeurons: Uint32Array[];
  private readonly outChan: Int8Array;       // neuron -> output channel or -1
  private readonly outInvSize: Float32Array; // 1/|neurons| per output channel
  private readonly outInvMax: Float32Array;  // 1/rateMaxHz per output channel
  private readonly regionOf: Int16Array;
  private readonly regionInvSize: Float32Array;
  private readonly regionNames: string[];
  private readonly typeInvCount: Float32Array;
  private readonly vSampleIdx: Uint32Array;
  private readonly maleOnly: Uint32Array;
  // LIF constants
  private readonly dt: number;
  private readonly vEq: number;
  private readonly vReset: number;
  private readonly vThresh: number;
  private readonly vFloor: number;
  private readonly aM: number;      // dt / tauMembrane
  private readonly decS: number;    // exp(-dt / tauSyn)
  private readonly refracMs: number;
  private readonly delaySteps: number;
  private readonly inputW: number;
  private readonly aOut: number;    // dt / OUTPUT_TAU_MS
  private readonly hzPerSpike: number; // 1000 / dt

  constructor(graph: GraphBuffers, manifest: BrainManifest) {
    this.graph = graph;
    this.manifest = manifest;
    const n = (this.n = graph.n);
    const lif = manifest.lif;
    this.dt = lif.dtMs;
    this.vEq = lif.vRest + lif.restingBiasMv;
    this.vReset = lif.vReset;
    this.vThresh = lif.vThresh;
    this.vFloor = lif.vFloor;
    this.aM = lif.dtMs / lif.tauMembraneMs;
    this.decS = Math.exp(-lif.dtMs / lif.tauSynMs);
    this.refracMs = lif.refractoryMs;
    this.delaySteps = Math.max(1, Math.round(lif.delayMs / lif.dtMs));
    this.inputW = lif.wSynMv * INPUT_WEIGHT_FACTOR;
    this.aOut = lif.dtMs / OUTPUT_TAU_MS;
    this.hzPerSpike = 1000 / lif.dtMs;

    // --- effective edge weights: sign*count * wSynMv * ntGain(pre) * norm(post)
    const { offsets, targets, weights, nt } = graph;
    const inDeg = new Float64Array(n);
    for (let e = 0; e < graph.m; e++) inDeg[targets[e]] += Math.abs(weights[e]);
    let sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) if (inDeg[i] > 0) { sum += inDeg[i]; cnt++; }
    const meanInDeg = cnt ? sum / cnt : 1;
    const norm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = inDeg[i];
      // capped at 1 (manifest.lifNotes): heavily innervated neurons are scaled down,
      // sparse ones are not scaled up. Same as tools/validate_brain.py.
      norm[i] = d <= 0 || lif.inputNorm === 'none' ? 1
        : lif.inputNorm === 'mean' ? Math.min(1, meanInDeg / d)
        : Math.min(1, Math.sqrt(meanInDeg / d));
    }
    const ntGain = manifest.ntGain;
    this.wEff = new Float32Array(graph.m);
    for (let pre = 0; pre < n; pre++) {
      const gPre = lif.wSynMv * (ntGain[nt[pre]] ?? 0);
      for (let e = offsets[pre], end = offsets[pre + 1]; e < end; e++) {
        this.wEff[e] = weights[e] * gPre * norm[targets[e]];
      }
    }

    // --- channel tables
    const clean = (list: number[] | undefined) =>
      Uint32Array.from((list ?? []).filter((i) => i >= 0 && i < n));
    this.inputNeurons = INPUT_CHANNELS.map((c) => clean(manifest.channels.inputs[c]?.neurons));
    this.outputNeurons = OUTPUT_CHANNELS.map((c) => clean(manifest.channels.outputs[c]?.neurons));
    this.outChan = new Int8Array(n).fill(-1);
    this.outInvSize = new Float32Array(NO);
    this.outInvMax = new Float32Array(NO);
    OUTPUT_CHANNELS.forEach((c, o) => {
      const list = this.outputNeurons[o];
      for (const i of list) if (this.outChan[i] < 0) this.outChan[i] = o; // first channel wins
      this.outInvSize[o] = list.length ? 1 / list.length : 0;
      this.outInvMax[o] = 1 / (manifest.channels.outputs[c]?.rateMaxHz || DEFAULT_RATE_MAX_HZ);
    });
    this.regionNames = Object.keys(manifest.regions ?? {});
    this.regionOf = new Int16Array(n).fill(-1);
    this.regionInvSize = new Float32Array(this.regionNames.length);
    this.regionNames.forEach((name, r) => {
      const list = clean(manifest.regions[name]);
      for (const i of list) if (this.regionOf[i] < 0) this.regionOf[i] = r;
      this.regionInvSize[r] = list.length ? 1 / list.length : 0;
    });
    const typeCount = new Uint32Array(manifest.types.length);
    for (let i = 0; i < n; i++) if (graph.typeId[i] < typeCount.length) typeCount[graph.typeId[i]]++;
    this.typeInvCount = new Float32Array(typeCount.length);
    for (let t = 0; t < typeCount.length; t++) this.typeInvCount[t] = typeCount[t] ? 1 / typeCount[t] : 0;
    const sample: number[] = [];
    for (const list of [...this.inputNeurons, ...this.outputNeurons]) {
      for (const i of list) { if (sample.length >= VSAMPLE_N) break; sample.push(i); }
    }
    this.vSampleIdx = Uint32Array.from(sample);
    this.maleOnly = clean(manifest.sexSpecific?.maleOnly);
  }

  // ---------------------------------------------------------------- agents
  get agentCount(): number { return this.agents.length; }
  agentIndex(id: number): number { return this.agents.findIndex((a) => a.id === id); }

  addAgent(init: AgentInit): void {
    if (this.agentIndex(init.id) >= 0) throw new Error(`agent ${init.id} already exists`);
    const n = this.n;
    const ag: Agent = {
      id: init.id, sex: init.sex,
      rng: ((init.seed ?? (init.id * 2654435761 + 12345)) >>> 0) || 0x9e3779b9,
      v: new Float32Array(n).fill(this.vEq),
      g: new Float32Array(n),
      refrac: new Float32Array(n),
      silencedUntil: new Float32Array(n).fill(-Infinity),
      active: new Uint8Array(n),
      act: new Uint32Array(n),
      nAct: 0,
      pend: Array.from({ length: this.delaySteps }, () => new Uint32Array(n)),
      pendCount: new Int32Array(this.delaySteps),
      outAcc: new Uint32Array(NO),
      outEma: new Float32Array(NO),
      modGain: new Float32Array(NI).fill(1),
      injections: [],
      spikeCount: new Uint32Array(n),
      focus: null,
    };
    if (init.sex === 'female') for (const i of this.maleOnly) ag.silencedUntil[i] = Infinity;
    this.agents.push(ag);
    this.resizeIo();
  }

  removeAgent(id: number): void {
    const k = this.agentIndex(id);
    if (k < 0) return;
    this.agents.splice(k, 1);
    if (this.focusId === id) this.focusId = null;
    this.resizeIo();
  }

  private resizeIo(): void {
    const K = this.agents.length;
    const inputs = new Float32Array(K * NI);
    inputs.set(this.inputs.subarray(0, Math.min(this.inputs.length, inputs.length)));
    this.inputs = inputs;
    const outputs = new Float32Array(K * NO);
    outputs.set(this.outputs.subarray(0, Math.min(this.outputs.length, outputs.length)));
    this.outputs = outputs;
  }

  /** Copies `inputs[a*NI+i]` (0..1) for the current agent order. */
  setInputs(inputs: Float32Array): void {
    this.inputs.fill(0);
    this.inputs.set(inputs.subarray(0, Math.min(inputs.length, this.inputs.length)));
  }

  // ------------------------------------------------------------ god controls
  resolveTarget(target: InjectTarget): Uint32Array {
    if ('neurons' in target) {
      return Uint32Array.from(target.neurons.filter((i) => i >= 0 && i < this.n));
    }
    if ('typeId' in target) {
      const out: number[] = [];
      for (let i = 0; i < this.n; i++) if (this.graph.typeId[i] === target.typeId) out.push(i);
      return Uint32Array.from(out);
    }
    const ch = target.channel;
    const ii = INPUT_CHANNELS.indexOf(ch as InputChannel);
    if (ii >= 0) return this.inputNeurons[ii];
    const oi = OUTPUT_CHANNELS.indexOf(ch as OutputChannel);
    if (oi >= 0) return this.outputNeurons[oi];
    return new Uint32Array(0);
  }

  inject(agentId: number, target: InjectTarget, gainMv: number, ms: number): void {
    const ag = this.agents[this.agentIndex(agentId)];
    if (!ag) return;
    ag.injections.push({ neurons: this.resolveTarget(target), gainMv, until: this.simTimeMs + ms });
  }

  silence(agentId: number, target: InjectTarget, ms: number): void {
    const ag = this.agents[this.agentIndex(agentId)];
    if (!ag) return;
    const until = this.simTimeMs + ms;
    for (const i of this.resolveTarget(target)) {
      if (ag.silencedUntil[i] < until) ag.silencedUntil[i] = until;
    }
  }

  modulate(agentId: number, channel: InputChannel, gain: number): void {
    const ag = this.agents[this.agentIndex(agentId)];
    const i = INPUT_CHANNELS.indexOf(channel);
    if (ag && i >= 0) ag.modGain[i] = Math.max(0, gain);
  }

  setFocus(agentId: number | null): void {
    this.focusId = agentId !== null && this.agentIndex(agentId) >= 0 ? agentId : null;
  }

  // -------------------------------------------------------------- stepping
  /** Advances all agents by `simMs` (fractional remainders carry over). Returns steps taken. */
  advance(simMs: number): number {
    this.carryMs += simMs;
    const steps = Math.floor(this.carryMs / this.dt + 1e-9);
    this.carryMs -= steps * this.dt;
    for (let s = 0; s < steps; s++) this.stepOnce();
    return steps;
  }

  stepOnce(): void {
    let active = 0;
    for (let a = 0; a < this.agents.length; a++) {
      const ag = this.agents[a];
      this.stepAgent(ag, a, ag.id === this.focusId);
      active += ag.nAct;
    }
    this.lastActive = active;
    this.simTimeMs += this.dt;
    this.stepIndex++;
  }

  private stepAgent(ag: Agent, a: number, focused: boolean): void {
    const { offsets, targets } = this.graph;
    const { wEff, inputs, vEq, vReset, vThresh, vFloor, aM, decS, refracMs, dt } = this;
    const { v, g, refrac, silencedUntil, active, act } = ag;
    const t = this.simTimeMs;
    const slot = this.stepIndex % this.delaySteps;
    const pendList = ag.pend[slot];
    let nAct = ag.nAct;

    // 1. deliver spikes scheduled for this step (emitted delaySteps ago)
    const nPend = ag.pendCount[slot];
    for (let k = 0; k < nPend; k++) {
      const pre = pendList[k];
      for (let e = offsets[pre], end = offsets[pre + 1]; e < end; e++) {
        const post = targets[e];
        g[post] += wEff[e];
        if (active[post] === 0) { active[post] = 1; act[nAct++] = post; }
      }
    }
    // the slot is now free for spikes emitted this step (delivered delaySteps later)
    let nPendOut = 0;

    // 2. sensory drive: Bernoulli per ms per neuron at rate * INPUT_MAX_HZ
    const fo = focused ? ag.focus : null;
    let rng = ag.rng;
    const base = a * NI;
    const inputW = this.inputW;
    for (let i = 0; i < NI; i++) {
      const p = inputs[base + i] * ag.modGain[i] * INPUT_MAX_HZ * dt / 1000;
      if (p <= 0) continue;
      const list = this.inputNeurons[i];
      for (let k = 0; k < list.length; k++) {
        rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0;
        if (rng / 4294967296 >= p) continue;
        const nrn = list[k];
        if (active[nrn] === 0) { active[nrn] = 1; act[nAct++] = nrn; }
        if (INPUT_MODE === 'conductance') {
          g[nrn] += inputW;
        } else if (refrac[nrn] <= 0 && silencedUntil[nrn] <= t) {
          // forced spike: the integrate loop below sees it as refractory this step
          v[nrn] = vReset;
          refrac[nrn] = refracMs;
          pendList[nPendOut++] = nrn;
          this.countSpike(ag, fo, nrn);
        }
      }
    }
    ag.rng = rng;

    // 3. current injections (god controls): gainMv added to v every ms while active
    if (ag.injections.length) {
      for (let j = ag.injections.length - 1; j >= 0; j--) {
        const inj = ag.injections[j];
        if (t >= inj.until) { ag.injections.splice(j, 1); continue; }
        const list = inj.neurons;
        for (let k = 0; k < list.length; k++) {
          const nrn = list[k];
          if (refrac[nrn] <= 0) v[nrn] += inj.gainMv;
          if (active[nrn] === 0) { active[nrn] = 1; act[nAct++] = nrn; }
        }
      }
    }

    // 4. integrate the active set, compacting in place
    let j = 0;
    for (let k = 0; k < nAct; k++) {
      const i = act[k];
      const gi = g[i] * decS;
      g[i] = gi;
      let r = refrac[i];
      if (r > 0) {
        r -= dt;
        refrac[i] = r;
        v[i] = vReset;
        act[j++] = i;
        continue;
      }
      let vi = v[i];
      vi += (vEq - vi + gi) * aM;
      if (vi < vFloor) vi = vFloor;
      if (vi >= vThresh) {
        if (silencedUntil[i] > t) {
          vi = vReset; // silenced: cannot fire, just resets
        } else {
          vi = vReset;
          refrac[i] = refracMs;
          pendList[nPendOut++] = i;
          this.countSpike(ag, fo, i);
          v[i] = vi;
          act[j++] = i;
          continue;
        }
      }
      v[i] = vi;
      const dv = vi - vEq;
      if ((gi < G_EPS && gi > -G_EPS) && (dv < V_EPS && dv > -V_EPS)) {
        // settled: snap to equilibrium and drop from the active list
        active[i] = 0;
        v[i] = vEq;
        g[i] = 0;
      } else {
        act[j++] = i;
      }
    }
    ag.nAct = j;
    ag.pendCount[slot] = nPendOut;

    // 5. output rates: EMA of the group's mean firing rate (Hz), normalised by rateMaxHz
    const aOut = this.aOut;
    const hz = this.hzPerSpike;
    const ob = a * NO;
    const outAcc = ag.outAcc;
    for (let o = 0; o < NO; o++) {
      const rate = outAcc[o] * this.outInvSize[o] * hz;
      outAcc[o] = 0;
      const ema = ag.outEma[o] + (rate - ag.outEma[o]) * aOut;
      ag.outEma[o] = ema;
      const y = ema * this.outInvMax[o];
      this.outputs[ob + o] = y < 0 ? 0 : y > 1 ? 1 : y;
    }

    // 6. focus accumulators
    if (fo !== null) {
      for (let r = 0; r < fo.regionEma.length; r++) {
        const rate = fo.regionAcc[r] * this.regionInvSize[r] * hz;
        fo.regionAcc[r] = 0;
        fo.regionEma[r] += (rate - fo.regionEma[r]) * aOut;
      }
      const te = fo.typeEma, ta = fo.typeAcc, tic = this.typeInvCount;
      for (let ty = 0; ty < te.length; ty++) {
        const rate = ta[ty] * tic[ty] * hz;
        ta[ty] = 0;
        te[ty] += (rate - te[ty]) * aOut;
      }
    } else if (focused) {
      // first focused step: allocate accumulators (they start collecting next step)
      ag.focus = {
        spikes: new Uint32Array(FOCUS_SPIKE_CAP), nSpikes: 0,
        regionAcc: new Uint32Array(this.regionNames.length), regionEma: new Float32Array(this.regionNames.length),
        typeAcc: new Uint32Array(this.typeInvCount.length), typeEma: new Float32Array(this.typeInvCount.length),
      };
    }
  }

  /** Spike bookkeeping shared by threshold crossings and forced sensory spikes. */
  private countSpike(ag: Agent, fo: Agent['focus'], i: number): void {
    ag.spikeCount[i]++;
    const o = this.outChan[i];
    if (o >= 0) ag.outAcc[o]++;
    if (fo !== null) {
      if (fo.nSpikes < FOCUS_SPIKE_CAP) fo.spikes[fo.nSpikes++] = i;
      const rg = this.regionOf[i];
      if (rg >= 0) fo.regionAcc[rg]++;
      fo.typeAcc[this.graph.typeId[i]]++;
    }
  }

  // --------------------------------------------------------------- reports
  /** Builds the focus report for the focused agent and resets its spike window. */
  takeFocusReport(): FocusReport | undefined {
    if (this.focusId === null) return undefined;
    const ag = this.agents[this.agentIndex(this.focusId)];
    if (!ag) return undefined;
    const fo = ag.focus;
    if (!fo) {
      return { agentId: ag.id, spikes: new Uint32Array(0), regionRates: new Float32Array(this.regionNames.length), topTypes: [] };
    }
    const spikes = fo.spikes.slice(0, fo.nSpikes);
    fo.nSpikes = 0;
    // top 8 types by EMA rate: one pass with an insertion-sorted short list
    const top: { typeId: number; hz: number }[] = [];
    const te = fo.typeEma;
    for (let ty = 0; ty < te.length; ty++) {
      const hz = te[ty];
      if (hz <= 0.01) continue;
      if (top.length < 8 || hz > top[top.length - 1].hz) {
        let pos = top.length;
        while (pos > 0 && top[pos - 1].hz < hz) pos--;
        top.splice(pos, 0, { typeId: ty, hz });
        if (top.length > 8) top.pop();
      }
    }
    const vSample = new Float32Array(this.vSampleIdx.length);
    for (let k = 0; k < vSample.length; k++) vSample[k] = ag.v[this.vSampleIdx[k]];
    return { agentId: ag.id, spikes, regionRates: fo.regionEma.slice(), topTypes: top, vSample };
  }

  perf(msPerSimMs: number): Perf {
    return { msPerSimMs, activeNeurons: this.lastActive, agents: this.agents.length };
  }

  /** Test/inspector access to an agent's raw state. */
  agentState(id: number): Agent | undefined { return this.agents[this.agentIndex(id)]; }
}
