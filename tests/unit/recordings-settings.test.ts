import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../../src/config/index.js";
import { recordingSettings } from "../../src/operations/audio-settings.js";
import { clock, describeSilences, parseSilences } from "../../src/recordings/silence.js";

const withRecordings = (recordings: Partial<NonNullable<ServiceConfig["recordings"]>>, audio: ServiceConfig["audio"] = undefined) =>
  ({ audio, recordings: { path: "/w/rec", modelPath: "/m/turbo.bin", vadModelPath: "/m/vad.bin", ...recordings } }) as unknown as ServiceConfig;

describe("recordingSettings", () => {
  it("is undefined without a recordings section", () => {
    expect(recordingSettings({} as ServiceConfig)).toBeUndefined();
  });

  it("defaults the first pass to the benchmark's best config and the retry to the same pass", () => {
    const settings = recordingSettings(withRecordings({}))!;
    expect(settings.vad).toEqual({ threshold: 0.35, minSpeechMs: 250, minSilenceMs: 500, padMs: 200 });
    expect([settings.suppressNonSpeech, settings.maxContext]).toEqual([false, 0]);
    expect(settings.retry).toEqual({ modelPath: "/m/turbo.bin", vad: settings.vad, suppressNonSpeech: false, maxContext: 0 });
    expect(settings.silence).toEqual({ thresholdDb: -80, minSeconds: 60 });
  });

  it("lets the retry override only what it sets, inheriting the first pass otherwise", () => {
    const settings = recordingSettings(withRecordings({
      vad: { threshold: 0.4, padMs: 300 }, suppressNonSpeech: true, maxContext: 16,
      retry: { modelPath: "/m/large-v3.bin", vadMinSpeechMs: 400 }, silence: { minSeconds: 120 },
    }))!;
    expect(settings.vad).toEqual({ threshold: 0.4, minSpeechMs: 250, minSilenceMs: 500, padMs: 300 });
    expect(settings.retry).toEqual({ modelPath: "/m/large-v3.bin", vad: { threshold: 0.4, minSpeechMs: 400, minSilenceMs: 500, padMs: 300 },
      suppressNonSpeech: true, maxContext: 16 });
    expect(settings.silence).toEqual({ thresholdDb: -80, minSeconds: 120 });
  });
});

describe("silence spans", () => {
  const line = (text: string) => `[Parsed_silencedetect_0 @ 0x14200aec0] ${text}`;

  it("parses closed spans, rounds them and drops short ones", () => {
    expect(parseSilences([line("silence_start: 810.4"), line("silence_end: 5670.2 | silence_duration: 4859.8"),
      line("silence_start: 6000"), line("silence_end: 6030 | silence_duration: 30")], 7000, 60))
      .toEqual([{ startSeconds: 810, durationSeconds: 4860 }]);
  });

  it("runs an unterminated span to the end of the audio and ignores unrelated lines", () => {
    expect(parseSilences(["size=N/A time=01:00:00", line("silence_start: 120"), "garbage"], 3600, 60))
      .toEqual([{ startSeconds: 120, durationSeconds: 3480, toEnd: true }]);
    expect(parseSilences([line("silence_start: 803.2"), line("silence_end: 4853.7 | silence_duration: 4050.5")], 4853.7, 60))
      .toEqual([{ startSeconds: 803, durationSeconds: 4051, toEnd: true }]);
    expect(parseSilences([line("silence_end: 50 | silence_duration: 50")], 100, 10)).toEqual([]);
    expect(parseSilences([line("silence_start: -0.01"), line("silence_end: 90")], 100, 60)).toEqual([{ startSeconds: 0, durationSeconds: 90 }]);
  });

  it("describes spans for people", () => {
    expect(describeSilences([])).toBeUndefined();
    expect(describeSilences([{ startSeconds: 810, durationSeconds: 4860 }])).toBe("no audio signal from 13:30 for 81 min");
    expect(describeSilences([{ startSeconds: 3725, durationSeconds: 90 }, { startSeconds: 0, durationSeconds: 60 }]))
      .toBe("no audio signal from 1:02:05 for 90 s, from 0:00 for 60 s");
    expect(describeSilences([{ startSeconds: 803, durationSeconds: 4051, toEnd: true }]))
      .toBe("no audio signal from 13:23 to the end (68 min)");
    expect(clock(59.6)).toBe("1:00");
  });
});
