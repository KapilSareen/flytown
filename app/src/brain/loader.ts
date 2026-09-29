// Fetches app/public/brain/{manifest.json, brain.bin.gz}, inflates the gzip and
// decodes the DPOLB001 layout (docs/ARCHITECTURE.md §1) into GraphBuffers.
import type { BrainManifest, GraphBuffers } from './types';

export type LoadProgress = (phase: string, progress: number) => void;

const MAGIC = 'DPOLB001';
const HEADER_BYTES = 24; // magic(8) + n(4) + m(4) + reserved(8)

/** Decodes a raw (already inflated) DPOLB001 buffer. Every section is copied via
 *  `slice` into its own ArrayBuffer so that Float64Array etc. are always aligned,
 *  regardless of where the section lands in the file. */
export function parseBrainBin(buf: ArrayBuffer): GraphBuffers {
  if (buf.byteLength < HEADER_BYTES) throw new Error('brain.bin: file too short');
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== MAGIC) throw new Error(`brain.bin: bad magic "${magic}" (expected ${MAGIC})`);
  const dv = new DataView(buf);
  const n = dv.getUint32(8, true);
  const m = dv.getUint32(12, true);

  let pos = HEADER_BYTES;
  const take = <T>(ctor: new (b: ArrayBuffer) => T, byteLength: number): T => {
    if (pos + byteLength > buf.byteLength) {
      throw new Error(`brain.bin: truncated (need ${pos + byteLength} bytes, have ${buf.byteLength})`);
    }
    const view = new ctor(buf.slice(pos, pos + byteLength));
    pos += byteLength;
    return view;
  };
  const offsets = take(Uint32Array, 4 * (n + 1));
  const targets = take(Uint32Array, 4 * m);
  const weights = take(Int16Array, 2 * m);
  const typeId = take(Uint16Array, 2 * n);
  const superId = take(Uint8Array, n);
  const nt = take(Uint8Array, n);
  const side = take(Uint8Array, n);
  const bodyId = take(Float64Array, 8 * n);
  if (pos !== buf.byteLength) {
    console.warn(`brain.bin: ${buf.byteLength - pos} trailing bytes ignored`);
  }
  if (offsets[n] !== m) throw new Error(`brain.bin: offsets[n]=${offsets[n]} but m=${m}`);
  return { n, m, offsets, targets, weights, typeId, superId, nt, side, bodyId };
}

/** Reads a Response body to an ArrayBuffer, inflating gzip when the payload
 *  still carries the 1f8b magic (i.e. the server did not transparently decode it).
 *  Progress is reported on compressed bytes downloaded (Content-Length when known). */
async function readMaybeGzipped(res: Response, onProgress: LoadProgress, phase: string): Promise<ArrayBuffer> {
  if (!res.ok || !res.body) throw new Error(`${phase}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress(phase, total ? Math.min(1, received / total) : 0);
      controller.enqueue(chunk);
    },
  });
  // Peek at the first bytes to detect gzip magic without consuming the stream twice.
  const [peekStream, mainStream] = res.body.tee();
  const reader = peekStream.getReader();
  const first = await reader.read();
  reader.cancel().catch(() => {});
  const head = first.value ?? new Uint8Array(0);
  const isGzip = head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;

  let stream: ReadableStream<Uint8Array> = mainStream.pipeThrough(counting);
  if (isGzip) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser lacks DecompressionStream; cannot inflate brain.bin.gz');
    }
    // lib.dom types DecompressionStream's writable side as BufferSource; Uint8Array chunks are fine at runtime.
    stream = stream.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }
  const inflated = await new Response(stream).arrayBuffer();
  onProgress(phase, 1);
  return inflated;
}

export interface LoadedBrain { manifest: BrainManifest; graph: GraphBuffers }

/** Loads manifest + graph from `${BASE_URL}brain/`. Phases reported:
 *  'manifest', 'download' (0..1 by bytes), 'parse'. */
export async function loadBrain(onProgress: LoadProgress = () => {}): Promise<LoadedBrain> {
  const base = `${import.meta.env.BASE_URL}brain/`;
  onProgress('manifest', 0);
  const manifestRes = await fetch(`${base}manifest.json`);
  if (!manifestRes.ok) throw new Error(`manifest.json: HTTP ${manifestRes.status}`);
  const manifest = (await manifestRes.json()) as BrainManifest;
  onProgress('manifest', 1);

  const binRes = await fetch(`${base}brain.bin.gz`);
  const raw = await readMaybeGzipped(binRes, onProgress, 'download');

  onProgress('parse', 0);
  const graph = parseBrainBin(raw);
  if (graph.n !== manifest.neurons) {
    console.warn(`manifest.neurons=${manifest.neurons} but brain.bin has n=${graph.n}`);
  }
  onProgress('parse', 1);
  return { manifest, graph };
}
