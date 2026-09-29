// Dev-only stand-in for the world + brain: `?mock=1` fills the store with fake
// citizens, a fake manifest, ticking focus reports and a worldApi that logs.
// Lets the HUD be developed without the simulation running.
import { INPUT_CHANNELS, NI, NO, OUTPUT_CHANNELS, type BrainManifest, type ChannelSpec, type InputChannel, type OutputChannel, type Sex } from '../brain/types';
import { useStore, type Action, type CitizenView, type EventKind, type WorldApi } from '../store';

let installed = false;

const NAMES_M = ['Arlo', 'Benedikt', 'Caspian', 'Dmitri', 'Emil', 'Felix', 'Gideon', 'Hugo'];
const NAMES_F = ['Adaeze', 'Beatrix', 'Camille', 'Delphine', 'Esme', 'Freya', 'Greta', 'Hana'];
const ACTIONS: Action[] = ['idle', 'walk', 'walk', 'eat', 'groom', 'sing', 'court', 'fight', 'escape', 'sleep'];
const THOUGHTS = [
  'something smells sweet to the left', 'she is close, I should sing', 'too dusty, must clean my head',
  'that shape is rushing at me', 'so tired', 'nothing much, walking', 'he is in my way', 'the light is fading',
];
const SKINS = ['#f1c9a5', '#d9a17a', '#b5764d', '#8a5a3a', '#f6d7bf'];
const HAIRS = ['#2b1d14', '#5a3a22', '#c98b45', '#0f0f12', '#9b9b9b'];
const TOPS = ['#5f7fa8', '#8d6c9e', '#a86f5f', '#6f9e7b', '#c2b280', '#4b5563'];

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

const FAKE_TYPES = ['unknown', 'DNa01', 'DNa02', 'DNa03', 'DNp01', 'DNp02', 'DNp04', 'DNp09', 'DNp11', 'MDN', 'MN9',
  'aDN1', 'aDN2', 'pIP10', 'vPR6', 'pC1a', 'pC1b', 'pC1c', 'pC1d', 'pC1e', 'aSP10', 'aSP22', 'aIPg1', 'aIPg2', 'pC1x',
  'ER5', 's-LNv', 'l-LNv', 'DN1p', 'LC4', 'LPLC2', 'LC6', 'LC10a', 'LC10b', 'ORN_DM1', 'ORN_DA1', 'ORN_VA1v',
  'Gr64f', 'Gr66a', 'JO-A', 'JO-B', 'JO-C', 'PAM01', 'PPL101', 'KCab', 'MBON01', 'PFL3', 'EPG'];
const FAKE_REGIONS = ['Optic lobe', 'Antennal lobe', 'Gustatory', 'Mechanosensory', 'Mushroom body', 'Central complex',
  'Lateral horn', 'Descending', 'VNC motor', 'Clock'];

function fakeManifest(): BrainManifest {
  const n = 8000;
  const spec = (cellTypes: string[], rateMaxHz?: number): ChannelSpec => ({
    neurons: Array.from({ length: 12 }, () => Math.floor(Math.random() * n)), cellTypes, note: 'mock', rateMaxHz,
  });
  const inputs = Object.fromEntries(INPUT_CHANNELS.map((c) => [c, spec([pick(FAKE_TYPES)])])) as Record<InputChannel, ChannelSpec>;
  const outputs = Object.fromEntries(OUTPUT_CHANNELS.map((c) => [c, spec([pick(FAKE_TYPES)], 100)])) as Record<OutputChannel, ChannelSpec>;
  const regions: Record<string, number[]> = {};
  const per = Math.floor(n / FAKE_REGIONS.length);
  FAKE_REGIONS.forEach((r, i) => { regions[r] = Array.from({ length: per }, (_, k) => i * per + k); });
  return {
    dataset: 'MaleCNS v1.0 (Janelia / Google Research) — MOCK', license: 'CC-BY 4.0',
    neurons: n, edges: 250_000, synapses: 3_100_000,
    fullBrain: { neurons: 164_740, edges: 6_236_426 },
    pruning: { seedNeurons: 1234, hops: 2, minSynapses: 5, cap: n, method: 'mock' },
    types: FAKE_TYPES, superclasses: ['sensory', 'central', 'descending', 'motor'],
    neurotransmitters: ['unknown', 'acetylcholine', 'gaba', 'glutamate', 'dopamine', 'octopamine', 'serotonin'],
    ntGain: [0, 1, 1, 1, 0.3, 0.3, 0.3],
    lif: { vRest: -52, vReset: -52, vThresh: -45, tauMembraneMs: 20, tauSynMs: 5, refractoryMs: 2.2, delayMs: 1.8,
      wSynMv: 0.275, dtMs: 1, vFloor: -75, restingBiasMv: 5, inputNorm: 'sqrt-mean' },
    channels: { inputs, outputs },
    regions,
    sexSpecific: { maleOnly: Array.from({ length: 320 }, (_, i) => 6000 + i), note: 'silenced in female bodies (mock)' },
  };
}

let nextId = 1;
function fakeCitizen(sex: Sex): CitizenView {
  const id = nextId++;
  const name = sex === 'male' ? NAMES_M[(id - 1) % NAMES_M.length] : NAMES_F[(id - 1) % NAMES_F.length];
  return {
    id, name, sex,
    x: rnd(0, 2000), y: rnd(0, 1400), heading: rnd(0, Math.PI * 2),
    action: pick(ACTIONS),
    actionT: rnd(0, 4), actionPhase: 'idle', speedNorm: rnd(0, 0.8), facing: rnd(0, Math.PI * 2),
    goal: pick(['wander', 'eatOut', 'groom', 'court', 'rest', 'chat', 'bar']),
    drives: { hunger: Math.random(), cleanliness: Math.random(), romance: Math.random(), hostility: Math.random() * 0.4,
      fear: Math.random() * 0.3, fatigue: Math.random(), social: Math.random(), wander: Math.random() },
    hunger: Math.random(), dust: Math.random(), energy: Math.random(), injury: Math.random() * 0.3,
    bondWith: null, target: null,
    inputs: Float32Array.from({ length: NI }, () => Math.random() * 0.6),
    outputs: Float32Array.from({ length: NO }, () => Math.random() * 0.5),
    thought: pick(THOUGHTS),
    palette: { skin: pick(SKINS), hair: pick(HAIRS), top: pick(TOPS), bottom: '#2f3440' },
  };
}

export function installDevMock() {
  if (installed) return;
  if (typeof window === 'undefined' || !new URLSearchParams(window.location.search).has('mock')) return;
  installed = true;
  const store = useStore;
  const log = (...a: unknown[]) => console.info('[worldApi]', ...a);
  // The real world wins: if it has registered (or registers later), the mock steps aside.
  const foreign = () => { const w = store.getState().worldApi; return w !== null && w !== api; };

  const api: WorldApi = {
    select: (id) => { log('select', id); store.setState({ selectedId: id }); },
    follow: (id) => { log('follow', id); store.setState({ followId: id, cameraMode: id === null ? 'god' : 'follow', ...(id !== null ? { selectedId: id } : {}) }); },
    setCameraMode: (mode) => { log('setCameraMode', mode); store.setState({ cameraMode: mode }); },
    setPaused: (p) => { log('setPaused', p); store.setState({ paused: p }); },
    setSpeed: (x) => { log('setSpeed', x); store.setState({ speed: x }); },
    setBrainSpeed: (x) => { log('setBrainSpeed', x); store.setState({ brainSpeed: x }); },
    setTimeOfDay: (h) => { log('setTimeOfDay', h); store.setState({ timeOfDay: h }); },
    setPopulation: (n, femaleRatio) => {
      log('setPopulation', n, femaleRatio);
      const s = store.getState();
      const target = Math.max(2, Math.min(s.maxPopulation, Math.round(n)));
      let citizens = s.citizens.slice();
      const ratio = femaleRatio ?? 0.5;
      // remove from the end, preferring the over-represented sex
      while (citizens.length > target) {
        const f = citizens.filter((c) => c.sex === 'female').length;
        const dropSex: Sex = f / citizens.length > ratio ? 'female' : 'male';
        let i = citizens.length - 1;
        while (i > 0 && citizens[i].sex !== dropSex) i--;
        citizens.splice(i, 1);
      }
      while (citizens.length < target) {
        const f = citizens.filter((c) => c.sex === 'female').length;
        citizens.push(fakeCitizen((f + 1) / (citizens.length + 1) <= ratio ? 'female' : 'male'));
      }
      const ids = new Set(citizens.map((c) => c.id));
      store.setState({
        citizens,
        selectedId: s.selectedId !== null && ids.has(s.selectedId) ? s.selectedId : null,
        followId: s.followId !== null && ids.has(s.followId) ? s.followId : null,
      });
      s.pushEvent({ kind: 'info', text: `The town is now ${citizens.length} people`, actors: [] });
    },
    god: {
      fight: (a, b) => { log('fight', a, b); ev('fight', a, b, 'squares up to'); },
      love: (a, b) => { log('love', a, b); ev('love', a, b, 'falls for'); },
      feed: (a) => { log('feed', a); ev('eat', a, null, 'is handed a sugar cube'); },
      scare: (a) => { log('scare', a); ev('escape', a, null, 'sees a shadow rushing in'); },
      dust: (a) => { log('dust', a); ev('groom', a, null, 'gets a face full of dust'); },
      riot: (around, radius) => { log('riot', around, radius); town('fight', around === null ? 'A riot breaks out on the plaza' : `A riot breaks out around ${nameOf(around)}`, around); },
      festival: () => { log('festival'); town('sing', 'A festival begins on the plaza', null); },
      loveWave: () => { log('loveWave'); town('love', 'Love sweeps through the whole town', null); },
      panic: (around) => { log('panic', around); town('escape', around === null ? 'Panic spreads from the plaza' : `Panic spreads out from ${nameOf(around)}`, around); },
      calm: () => { log('calm'); town('info', 'Calm settles over the town; everyone is healed', null); },
      sleep: (a) => { log('sleep', a); ev('sleep', a, null, 'feels the night coming'); },
      reward: (a) => { log('reward', a); ev('god', a, null, 'is rewarded'); },
      punish: (a) => { log('punish', a); ev('god', a, null, 'is punished'); },
      inject: (a, t, g, ms) => { log('inject', a, t, g, ms); ev('god', a, null, `gets ${g} mV for ${ms} ms`); },
      silence: (a, t, ms) => { log('silence', a, t, ms); ev('god', a, null, `is silenced for ${ms} ms`); },
      modulate: (a, c, g) => { log('modulate', a, c, g); },
      spawn: (sex) => {
        log('spawn', sex);
        const c = fakeCitizen(sex);
        store.setState({ citizens: [...store.getState().citizens, c] });
        store.getState().pushEvent({ kind: 'info', text: `${c.name} arrives in town`, actors: [c.id] });
      },
      remove: (a) => {
        log('remove', a);
        const s = store.getState();
        const c = s.citizens.find((x) => x.id === a);
        store.setState({
          citizens: s.citizens.filter((x) => x.id !== a),
          selectedId: s.selectedId === a ? null : s.selectedId,
          followId: s.followId === a ? null : s.followId,
        });
        if (c) s.pushEvent({ kind: 'info', text: `${c.name} leaves town`, actors: [] });
      },
    },
  };

  const nameOf = (id: number) => store.getState().citizens.find((c) => c.id === id)?.name ?? 'someone';
  const town = (kind: EventKind, text: string, around: number | null) => {
    const s = store.getState();
    s.pushEvent({ kind, text, actors: around === null ? [] : [around] });
    // make it visible: flip everyone's action for a while
    const act: Action = kind === 'fight' ? 'fight' : kind === 'sing' ? 'sing' : kind === 'love' ? 'court' : kind === 'escape' ? 'escape' : 'idle';
    store.setState({ citizens: s.citizens.map((c) => ({ ...c, action: act, injury: kind === 'info' ? 0 : c.injury })) });
  };
  const ev = (kind: EventKind, a: number, b: number | null, verb: string) => {
    const s = store.getState();
    const na = s.citizens.find((c) => c.id === a)?.name ?? '?';
    const nb = b === null ? null : s.citizens.find((c) => c.id === b)?.name ?? '?';
    s.pushEvent({ kind, text: nb ? `${na} ${verb} ${nb}` : `${na} ${verb}`, actors: b === null ? [a] : [a, b] });
  };

  // staged loading, then the town
  const phases = ['Fetching brain.bin.gz', 'Inflating', 'Building CSR', 'Starting workers', 'Warming up'];
  let pi = 0;
  const tick = () => {
    if (foreign() || (store.getState().ready && store.getState().worldApi !== api)) { console.info('[mock] real world present, mock disabled'); return; }
    if (pi < phases.length) {
      store.setState({ loading: { phase: phases[pi], progress: (pi + 1) / (phases.length + 1) } });
      pi++;
      setTimeout(tick, 320);
      return;
    }
    const citizens = Array.from({ length: 12 }, (_, i) => fakeCitizen(i % 2 === 0 ? 'male' : 'female'));
    citizens[0].bondWith = citizens[1].id;
    store.setState({ manifest: fakeManifest(), citizens, worldApi: api, ready: true, loading: { phase: 'Ready', progress: 1 },
      perf: { msPerSimMs: 0.42, activeNeurons: 1830, agents: citizens.length }, fps: 60 });
    start();
  };
  setTimeout(tick, 200);

  const start = () => {
    const m = store.getState().manifest!;
    const regionNames = Object.keys(m.regions);
    let simT = 0;
    // world snapshot ~12 Hz
    const snap = setInterval(() => {
      const s = store.getState();
      if (foreign()) { clearInterval(snap); clearInterval(amb); return; }
      if (s.paused) return;
      const dt = 1 / 12 * s.speed;
      simT += dt;
      const citizens = s.citizens.map((c) => {
        const inputs = c.inputs.map((v) => Math.max(0, Math.min(1, v + rnd(-0.06, 0.06))));
        const outputs = c.outputs.map((v) => Math.max(0, Math.min(1, v * 0.9 + rnd(0, 0.12))));
        const flip = Math.random() < 0.03;
        return { ...c, inputs, outputs,
          action: flip ? pick(ACTIONS) : c.action,
          thought: flip ? pick(THOUGHTS) : c.thought,
          hunger: Math.min(1, c.hunger + 0.002 * s.speed), dust: Math.min(1, c.dust + 0.001 * s.speed),
          energy: Math.max(0, c.energy - 0.0015 * s.speed) };
      });
      let timeOfDay = s.timeOfDay + dt * 0.05;
      let day = s.day;
      if (timeOfDay >= 24) { timeOfDay -= 24; day++; }
      const focusId = s.selectedId;
      const focus = focusId === null ? null : {
        agentId: focusId,
        spikes: Uint32Array.from({ length: Math.floor(rnd(30, 140)) }, () => {
          const r = Math.floor(Math.random() * regionNames.length);
          const hot = Math.sin(simT * 0.7 + r) > 0.3 ? 1 : 0.35;
          return Math.random() < hot ? Math.floor(rnd(r * 800, (r + 1) * 800)) : Math.floor(Math.random() * m.neurons);
        }),
        regionRates: Float32Array.from(regionNames, (_, r) => Math.max(0, 8 + 10 * Math.sin(simT * 0.7 + r) + rnd(-2, 2))),
        topTypes: Array.from({ length: 8 }, (_, i) => ({ typeId: 1 + ((i * 7 + Math.floor(simT / 3)) % (m.types.length - 1)), hz: Math.max(0, 40 - i * 4 + rnd(-3, 3)) })),
      };
      store.setState({ citizens, timeOfDay, day, focus,
        fps: 58 + rnd(-3, 2), perf: { msPerSimMs: 0.4 + rnd(-0.05, 0.08), activeNeurons: 1700 + Math.floor(rnd(-200, 300)), agents: citizens.length } });
    }, 1000 / 12);

    // ambient events
    const verbs: [EventKind, string, boolean][] = [
      ['eat', 'finds the pastry stall', false], ['groom', 'stops to clean up', false], ['sing', 'sings to', true],
      ['fight', 'shoves', true], ['love', 'is smitten with', true], ['sleep', 'dozes off on a bench', false], ['escape', 'bolts from a pigeon', false],
    ];
    const amb = setInterval(() => {
      const s = store.getState();
      if (foreign() || s.paused || s.citizens.length === 0) return;
      const [kind, verb, pair] = pick(verbs);
      const a = pick(s.citizens);
      const b = pair ? pick(s.citizens.filter((c) => c.id !== a.id)) : undefined;
      s.pushEvent({ kind, text: b ? `${a.name} ${verb} ${b.name}` : `${a.name} ${verb}`, actors: b ? [a.id, b.id] : [a.id] });
    }, 2600);
  };
}
