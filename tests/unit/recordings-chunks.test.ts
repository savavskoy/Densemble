import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpeechSegments, speechChunks, writeWavChunks } from "../../src/modules/recordings/chunks.js";

let tmp: string;
beforeEach(() => { tmp = resolve(".cache", `recordings-chunks-${randomUUID()}`); mkdirSync(tmp, { recursive: true }); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

/** 16 kHz mono 16-bit PCM WAV whose sample `i` is `i % 32768`, with an extra LIST chunk before `data` as ffmpeg writes. */
function wav(samples: number): Buffer {
  const body = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) body.writeInt16LE(index % 32_768, index * 2);
  const list = Buffer.concat([Buffer.from("LIST", "latin1"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO", "latin1")]);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0, "latin1"); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16_000, 12); fmt.writeUInt32LE(32_000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const data = Buffer.alloc(8);
  data.write("data", 0, "latin1"); data.writeUInt32LE(body.length, 4);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1"); riff.writeUInt32LE(4 + fmt.length + list.length + data.length + body.length, 4); riff.write("WAVE", 8, "latin1");
  return Buffer.concat([riff, fmt, list, data, body]);
}

describe("speech chunks (2026-11-05: no dropped whisper windows)", () => {
  it("parses whisper-vad-speech-segments stdout (centiseconds)", () => {
    expect(parseSpeechSegments("Detected 2 speech segments:\nSpeech segment 0: start = 210.00, end = 462.00\n" +
      "Speech segment 1: start = 694.00, end = 823.00\nnoise\nSpeech segment 2: start = 900.00, end = 900.00\n"))
      .toEqual([{ start: 2.1, end: 4.62 }, { start: 6.94, end: 8.23 }]);
    expect(parseSpeechSegments("")).toEqual([]);
  });

  it("pads spans, joins close ones up to 25 s, and never overlaps chunks", () => {
    expect(speechChunks([{ start: 0.1, end: 2 }, { start: 3, end: 5 }, { start: 10, end: 12 }]))
      .toEqual([{ start: 0, end: 5.2 }, { start: 9.8, end: 12.2 }]);
    // Close but too long together: a new chunk that starts where the previous one ended.
    expect(speechChunks([{ start: 0, end: 20 }, { start: 20.1, end: 30 }])).toEqual([{ start: 0, end: 20.2 }, { start: 20.2, end: 30.2 }]);
    expect(speechChunks([])).toEqual([]);
  });

  it("cuts a PCM WAV into exact chunk files with plain 44-byte headers", async () => {
    const source = join(tmp, "audio.wav");
    writeFileSync(source, wav(48_000));
    const targets = [join(tmp, "a.wav"), join(tmp, "b.wav")];
    await writeWavChunks(source, [{ start: 0.5, end: 1 }, { start: 2.5, end: 9 }], targets);
    const first = readFileSync(targets[0]!);
    expect(first.toString("latin1", 0, 4) + first.toString("latin1", 8, 16) + first.toString("latin1", 36, 40)).toBe("RIFFWAVEfmt data");
    expect(first.readUInt32LE(40)).toBe(8_000 * 2);
    expect(first.readInt16LE(44)).toBe(8_000);
    // The second chunk is clipped at the end of the audio (3 s).
    expect(readFileSync(targets[1]!).readUInt32LE(40)).toBe(8_000 * 2);
    await expect(writeWavChunks(targets[0]!, [{ start: 0, end: 1 }], [targets[0]!])).rejects.toThrow();
    writeFileSync(join(tmp, "bad.wav"), "RIFF....WAVE");
    await expect(writeWavChunks(join(tmp, "bad.wav"), [{ start: 0, end: 1 }], [join(tmp, "c.wav")])).rejects.toThrow("WAV_INVALID");
  });
});
