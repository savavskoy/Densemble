import { describe, expect, it } from "vitest";
import { videoId, youtubeId } from "../../src/modules/reels/fetch.js";
import { overlaySvg, overlayTimeline, subtitleCards, TITLE_SECONDS } from "../../src/modules/reels/render/layout.js";
import {
  parseTimecode, reelFileName, snapToWords, transliterate, validateCuts, videoBitrate,
} from "../../src/modules/reels/render/index.js";

const words = "Привіт друзі, це тестовий ролик. А тут друга фраза".split(" ")
  .map((text, index) => ({ start: 10 + index * 0.5, end: 10.4 + index * 0.5, text, phrase: index < 5 ? 0 : 1, speaker: "Owner" }));

describe("cut list validation (FR-012)", () => {
  it("rejects every bad entry with a fixed code before anything is cut", () => {
    const result = validateCuts([
      { start: 0, end: 3, title: "Коротко" },
      { start: 10, end: 200, title: "Задовго" },
      { start: 50, end: 70, title: "A" }, { start: 60, end: 80, title: "B" },
      { start: 590, end: 610, title: "Поза" },
      { start: 300, end: 320, title: " " },
    ], 600);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => [issue.index, issue.code])).toEqual([
      [0, "REELS_CUT_TOO_SHORT"], [1, "REELS_CUT_TOO_LONG"], [1, "REELS_CUT_OVERLAP"], [2, "REELS_CUT_OVERLAP"], [3, "REELS_CUT_OVERLAP"],
      [4, "REELS_CUT_OUT_OF_RANGE"], [5, "REELS_CUT_TITLE_INVALID"],
    ]);
    expect(validateCuts([{ start: 0, end: 30, title: "Ок" }, { start: 30, end: 60, title: "Теж" }], 600).ok).toBe(true);
    expect(validateCuts([], 600)).toEqual({ ok: false, issues: [{ index: null, code: "REELS_CUTS_EMPTY" }] });
  });

  it("parses timecodes", () => {
    expect(parseTimecode("12:31")).toBe(751);
    expect(parseTimecode("1:02:03,5")).toBe(3723.5);
    expect(parseTimecode("75:30")).toBe(4530);
    expect(parseTimecode(42.5)).toBe(42.5);
    for (const bad of ["12:61", "1:60:00", "-3", "abc", ""]) expect(parseTimecode(bad)).toBeUndefined();
  });
});

describe("word snapping (SC-005)", () => {
  it("moves boundaries onto whole words with a pad that never reaches a neighbour", () => {
    expect(snapToWords({ start: 10.2, end: 11.7, title: "x" }, words)).toMatchObject({ start: 9.85, end: 12, snapped: true });
    expect(snapToWords({ start: 30, end: 40, title: "x" }, words, { durationSeconds: 35 })).toMatchObject({ start: 30, end: 35, snapped: false });
  });
});

describe("subtitle layout (FR-011)", () => {
  it("never joins phrases in one card, highlights the spoken word and shows the title first", () => {
    const cards = subtitleCards(words, 10, 14.5);
    expect(cards.map((card) => card.words.map((word) => word.text).join(" "))).toEqual(["Привіт друзі, це тестовий ролик.", "А тут друга фраза"]);
    const timeline = overlayTimeline(cards, 4.5, true);
    expect(timeline[0]).toMatchObject({ start: 0, title: true, card: 0, word: 0 });
    expect(timeline.find((state) => state.start <= 1.1 && 1.1 < state.end)).toMatchObject({ card: 0, word: 2 });
    expect(timeline.every((state) => state.title === state.start < TITLE_SECONDS)).toBe(true);
    expect(timeline.at(-1)!.end).toBeCloseTo(4.5);
    const svg = overlaySvg({ title: true, card: 0, word: 1 }, cards, "Назва <рілса> & тест");
    expect(svg).toContain("Назва &lt;рілса&gt; &amp; тест");
    expect(svg).toContain('<tspan fill="#FFD400">друзі,</tspan>');
    expect(overlayTimeline([], 6, false)).toEqual([{ start: 0, end: 6, title: false }]);
  });
});

describe("names, sources and size", () => {
  it("names reels with an ASCII slug of the title", () => {
    expect(transliterate("Згода, Юля та Їжак")).toBe("zghoda, yulia ta yizhak");
    expect(reelFileName(0, "Як ми робимо рілси — тест!")).toBe("01-yak-my-robymo-rilsy-test.mp4");
    expect(reelFileName(11, "🔥🔥")).toBe("12-reel.mp4");
  });
  it("accepts YouTube links only and derives stable video ids", () => {
    for (const link of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1", "https://youtu.be/dQw4w9WgXcQ", "https://youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/live/dQw4w9WgXcQ"]) expect(youtubeId(link)).toBe("dQw4w9WgXcQ");
    for (const link of ["https://evil.com/watch?v=dQw4w9WgXcQ", "file:///etc/passwd", "https://youtube.com/watch?v=short", "dQw4w9WgXcQ"]) {
      expect(youtubeId(link)).toBeUndefined();
    }
    expect(videoId({ kind: "youtube", youtubeId: "dQw4w9WgXcQ", url: "" })).toBe("yt-dQw4w9WgXcQ");
    expect(videoId({ kind: "file", path: "/w/a.mp4", relativePath: "a.mp4", size: 1, mtimeMs: 2 })).toMatch(/^file-[0-9a-f]{12}$/);
  });
  it("caps the bitrate so a 3-minute reel stays under Telegram's 50 MB", () => {
    expect(videoBitrate(30)).toBe(8_000_000);
    expect((videoBitrate(180) + 128_000) * 180 / 8).toBeLessThan(46_000_000);
  });
});
