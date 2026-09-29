// Turns channel vectors into a one-line "thought" for the inspector. These are
// interpretations of channel activity, not language (ARCHITECTURE.md §6).
import { INPUT_CHANNELS, OUTPUT_CHANNELS, inputIndex, outputIndex, type InputChannel, type OutputChannel, type Sex } from './types';

export interface BodyState { hunger: number; dust: number; energy: number; injury: number }

/** Strongest behavioural output (clock excluded: it is internal time, not a drive). */
export function dominantDrive(outputs: Float32Array): OutputChannel {
  let best: OutputChannel = 'walk';
  let bestV = -1;
  for (let o = 0; o < OUTPUT_CHANNELS.length; o++) {
    const c = OUTPUT_CHANNELS[o];
    if (c === 'clock') continue;
    if (outputs[o] > bestV) { bestV = outputs[o]; best = c; }
  }
  return best;
}

/** Deterministic pick among variants: stable while the coarse state is stable,
 *  so the line does not flicker every frame. */
function pick(variants: string[], key: number): string {
  return variants[Math.abs(Math.floor(key)) % variants.length];
}

const out = (outputs: Float32Array, c: OutputChannel) => outputs[outputIndex(c)] ?? 0;
const inp = (inputs: Float32Array, c: InputChannel) => inputs[inputIndex(c)] ?? 0;

export function thoughtFor(outputs: Float32Array, inputs: Float32Array, body: BodyState, sex: Sex): string {
  const o = (c: OutputChannel) => out(outputs, c);
  const i = (c: InputChannel) => inp(inputs, c);
  // coarse hash of the state for variant selection
  let key = 0;
  for (let k = 0; k < OUTPUT_CHANNELS.length; k++) key += Math.round((outputs[k] ?? 0) * 4) * (k + 3);
  for (let k = 0; k < INPUT_CHANNELS.length; k++) key += Math.round((inputs[k] ?? 0) * 3) * (k + 17);

  const loom = Math.max(i('visionLoomL'), i('visionLoomR'));
  const loomSide = i('visionLoomL') > i('visionLoomR') ? 'left' : 'right';
  const foodSide = o('steerL') > o('steerR') + 0.05 ? 'to the left' : o('steerR') > o('steerL') + 0.05 ? 'to the right' : 'somewhere close';

  if (o('escape') > 0.35 || (loom > 0.6 && o('escape') > 0.15)) {
    return pick([
      'Giant fibre fired — get out.',
      `Something big is coming from the ${loomSide}. Legs, do your thing.`,
      'Looming shadow. Every DNp01 says jump.',
    ], key);
  }
  if (o('aggression') > 0.3) {
    return pick(sex === 'male' ? [
      'Another male, too close. aIPg is spoiling for a fight.',
      'Wings up, fists— well, forelegs up.',
      'cVA in the air. This town is not big enough for both of us.',
    ] : [
      'Someone is crowding me. Head-butt loaded.',
      'aIPg lit up. I am not in the mood.',
    ], key);
  }
  if (o('courtship') > 0.3 || o('sing') > 0.3) {
    if (sex === 'female') {
      return pick(i('soundSong') > 0.3 ? [
        'Someone is singing at me and pC1 is warming up.',
        'That song is... actually not bad. Slowing down a little.',
      ] : [
        'pC1 is warming up. Someone here smells interesting.',
        'Receptive. Do not tell them that.',
      ], key);
    }
    return pick(o('sing') > 0.3 ? [
      'Humming a courtship song. One wing, pure heart.',
      'pIP10 says sing. Hopefully in tune.',
    ] : [
      'P1 cluster firing. Someone here is cute.',
      'Tracking a small moving figure. Definitely following.',
    ], key);
  }
  if (o('feed') > 0.3) {
    return pick(body.hunger > 0.6 ? [
      'Sugar on the tongue. Finally.',
      'MN9 says eat. Stomach agrees loudly.',
    ] : [
      'Sugar on the tongue. Proboscis says yes.',
      'Not hungry, but the sugar neurons do not care.',
    ], key);
  }
  if (o('groom') > 0.3) {
    return pick([
      'Dust on the antennae. Time for a wash.',
      'JO-C tickling. Front legs to the head.',
      'Everything itches. Grooming until it stops.',
    ], key);
  }
  if (o('sleep') > 0.35) {
    return pick([
      'R5 says nap. Eyes heavy.',
      'Sleep pressure winning. Five more minutes.',
    ], key);
  }
  if (o('backup') > 0.3) {
    return pick(i('tasteBitter') > 0.3 ? [
      'Bitter. Nope. Reversing.',
      'Gr66a says that is garbage. Backing away.',
    ] : [
      'Moonwalker neurons on. Backing up.',
      'Nope. Reversing.',
    ], key);
  }
  if (o('walk') > 0.25) {
    if (i('odorFood') > 0.3) return pick([`Smells food ${foodSide}. Legs say go.`, 'Following the food smell. Legs on autopilot.'], key);
    if (i('odorFemale') > 0.3 && sex === 'male') return pick(['Someone smells nice. Walking that way, casually.', 'Or47b tingling. Wandering closer.'], key);
    if (i('odorMale') > 0.3) return pick(['Another male around. Walking, warily.', 'cVA on the breeze. Keeping an eye out.'], key);
    if (o('steerL') > 0.25 || o('steerR') > 0.25) return pick([`Turning ${foodSide}. DNa02 has opinions.`, 'Veering. Not sure why. Legs know.'], key);
    return pick(['Legs say go. Somewhere.', 'DNp09 firing. Walking, thinking about nothing.', 'Wandering the plaza. It is a nice plaza.'], key);
  }
  // quiet brain: fall back to the body
  if (body.injury > 0.5) return pick(['Something hurts. Keeping still.', 'Bruised. Sitting this one out.'], key);
  if (body.hunger > 0.7) return pick(['Stomach empty and nothing smells like lunch.', 'Hungry. Sniffing the air hopefully.'], key);
  if (body.energy < 0.3) return pick(['Running on fumes.', 'Tired. Could sit here a while.'], key);
  if (i('light') < 0.2) return pick(['Dark out. Clock neurons ticking softly.', 'Night. Not much to see, not much to do.'], key);
  return pick([
    'Quiet brain. Just vibing in the plaza.',
    'Nothing much upstairs — a resting bias and a dream.',
    'Idle. 8,000 neurons and not one of them has a plan.',
  ], key);
}
