/**
 * Child process of `diarize()` (spec 006, FR-003): the native sherpa-onnx calls are synchronous or hold large
 * buffers, so they never run in the service process. Plain Node (type stripping only): imports nothing but
 * built-ins and `sherpa-onnx-node`. Input: one JSON request file (argv[2]). Output: the result JSON file it
 * names, and `progress = NN%` lines on stderr. Exits non-zero on any failure, without details.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

interface Request {
  wav: string;
  segmentation: string;
  embedding: string;
  /** Model that compares clusters with the owner's sample. */
  verification: string;
  threads: number;
  clusterThreshold: number;
  ownerWav?: string;
  ownerThreshold: number;
  output: string;
}
interface Wave { samples: Float32Array; sampleRate: number }
interface Segment { start: number; end: number; speaker: number }
interface Stream { acceptWaveform(wave: Wave): void; inputFinished(): void }
interface Extractor { createStream(): Stream; compute(stream: Stream, external?: boolean): Float32Array }
interface Sherpa {
  readWave(path: string): Wave;
  OfflineSpeakerDiarization: new (config: object) => { handle: unknown };
  SpeakerEmbeddingExtractor: new (config: object) => Extractor;
}
interface Addon {
  offlineSpeakerDiarizationProcessAsync(handle: unknown, samples: Float32Array,
    progress: (done: number, total: number) => number): Promise<Segment[]>;
}

const require = createRequire(import.meta.url);
/** Turns used to name a cluster: the longest ones, each at most this long. */
const OWNER_TURNS = 8;
const OWNER_TURN_SECONDS = 10;
const OWNER_MIN_TURN_SECONDS = 1.5;

function normalized(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((value) => value / norm);
}
function mean(vectors: Float32Array[]): Float32Array | undefined {
  if (!vectors.length) return undefined;
  const sum = new Float32Array(vectors[0]!.length);
  for (const vector of vectors) vector.forEach((value, index) => { sum[index]! += value; });
  return normalized(sum);
}
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index]! * b[index]!;
  return dot;
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Request;
  const sherpa = require("sherpa-onnx-node") as Sherpa;
  const addon = require("sherpa-onnx-node/addon.js") as Addon;
  const wave = sherpa.readWave(request.wav);
  if (wave.sampleRate !== 16_000) throw new Error("SPEAKERS_FAILED");
  const diarization = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: request.segmentation }, numThreads: request.threads },
    embedding: { model: request.embedding, numThreads: request.threads },
    clustering: { numClusters: -1, threshold: request.clusterThreshold },
    minDurationOn: 0.3, minDurationOff: 0.5,
  });
  const ownerShare = request.ownerWav ? 10 : 0;
  let last = -1;
  const report = (percent: number) => {
    const value = Math.max(0, Math.min(100, Math.floor(percent)));
    if (value > last) { last = value; process.stderr.write(`progress = ${value}%\n`); }
  };
  const segments = await addon.offlineSpeakerDiarizationProcessAsync(diarization.handle, wave.samples, (done, total) => {
    if (total > 0) report(done / total * (100 - ownerShare));
    return 0;
  });
  const turns = segments.map((segment) => ({ start: segment.start, end: segment.end, speaker: segment.speaker }))
    .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end) && turn.end > turn.start &&
      Number.isInteger(turn.speaker) && turn.speaker >= 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let ownerSpeaker: number | undefined;
  if (request.ownerWav && turns.length) {
    const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: request.verification, numThreads: request.threads });
    const embed = (samples: Float32Array) => {
      const stream = extractor.createStream();
      stream.acceptWaveform({ sampleRate: 16_000, samples });
      stream.inputFinished();
      return normalized(Float32Array.from(extractor.compute(stream, false)));
    };
    const owner = readWaveSamples(sherpa, request.ownerWav);
    // A long sample is embedded in pieces and averaged, like a cluster.
    const pieces: Float32Array[] = [];
    for (let offset = 0; offset < owner.length; offset += OWNER_TURN_SECONDS * 16_000) {
      const piece = owner.subarray(offset, offset + OWNER_TURN_SECONDS * 16_000);
      if (piece.length >= OWNER_MIN_TURN_SECONDS * 16_000 || !pieces.length) pieces.push(embed(piece));
    }
    const ownerVector = mean(pieces);
    const speakers = [...new Set(turns.map((turn) => turn.speaker))];
    let best = { speaker: -1, score: -1 };
    speakers.forEach((speaker, index) => {
      const own = turns.filter((turn) => turn.speaker === speaker).sort((a, b) => (b.end - b.start) - (a.end - a.start));
      const usable = own.filter((turn) => turn.end - turn.start >= OWNER_MIN_TURN_SECONDS);
      const chosen = (usable.length ? usable : own).slice(0, OWNER_TURNS);
      const vector = mean(chosen.map((turn) => {
        const from = Math.floor(turn.start * 16_000);
        const to = Math.min(wave.samples.length, from + Math.floor(Math.min(turn.end - turn.start, OWNER_TURN_SECONDS) * 16_000));
        return embed(wave.samples.subarray(from, to));
      }));
      const score = vector && ownerVector ? cosine(vector, ownerVector) : -1;
      if (score > best.score) best = { speaker, score };
      report(100 - ownerShare + (index + 1) / speakers.length * ownerShare);
    });
    if (best.speaker >= 0 && best.score >= request.ownerThreshold) ownerSpeaker = best.speaker;
  }
  report(100);
  writeFileSync(request.output, JSON.stringify({ turns, ...(ownerSpeaker === undefined ? {} : { ownerSpeaker }) }), { mode: 0o600 });
}

function readWaveSamples(sherpa: Sherpa, path: string): Float32Array {
  const wave = sherpa.readWave(path);
  if (wave.sampleRate !== 16_000) throw new Error("SPEAKERS_FAILED");
  return wave.samples;
}

main().then(() => { process.exit(0); }, () => { process.stderr.write("SPEAKERS_FAILED\n"); process.exit(1); });
