import { describe, expect, it } from "vitest";
import {
  classify, dayFolder, isMediaName, localDate, MEDIA_EXTENSIONS, obsDate, PARTIAL_PATTERN, parseDayFolder,
  parseReviewLog, recordingName, rootTargetDate, transcriptKey, type DayMedia, type ReviewLog,
} from "../../src/recordings/contract.js";

// Verbatim copy of raw/recordings/review-log.tsv on 29.10.2026 (read-only fixture).
const REAL_LOG = [
  "2026-10-29 19:55:39\tretranscribe\t2026/10/26/transcript_2026-10-26_2026-10-26_21-56-56.txt\t2026/10/26/2026-10-26 21-56-56.mp4\tТранскрипт з 4 байтів (слово «you»), запис 0 хв",
  "2026-10-29 19:55:39\tretranscribe\t2026/10/29/transcript_2026-10-29_2026-10-29_09-03-05.txt\t2026/10/29/2026-10-29 09-03-05.mp4\tПонад 70 % рядків — тег-цикл [Ukraïner Експедиція], лише початок читабельний",
  "2026-10-29 19:55:39\tretranscribe\t2026/10/29/transcript_2026-10-29_2026-10-29_17-01-21.txt\t2026/10/29/2026-10-29 17-01-21.mp4\t90 % рядків — [музика], цикл тегів",
  "2026-10-29 20:31:38\tlabelled\t2026/10/27/Пара_Історія_архівної_справи_transcript_2026-10-27_2026-10-27_10-05-40.txt\t2026/10/27/2026-10-27 10-05-40.mp4\tlecture on archive history (Ukrainian lands, 17–19 c.), students, dictation at end",
  "2026-10-29 20:31:38\tlabelled\t2026/10/29/Пара_Бібліотекознавство_transcript_2026-10-29_2026-10-29_15-13-24.txt\t2026/10/29/2026-10-29 15-13-24.mp4\tlibrary-science lecture to postgraduates: exam questions, Ukrainian librarianship scholars",
  "2026-10-29 20:31:38\tlabelled\t2026/10/29/Пара_Історія_архівної_справи_transcript_2026-10-29_2026-10-29_09-03-05.txt\t2026/10/29/2026-10-29 09-03-05.mp4\tlecture on archive history (19th c. Right-bank Ukraine); after ~line 190 repeated loops (529 of 722 lines), retried once, still looping; content before the loops is usable",
  "2026-10-29 20:31:38\tlabelled\t2026/10/29/Невідомо_transcript_2026-10-29_2026-10-29_17-01-21.txt\t2026/10/29/2026-10-29 17-01-21.mp4\tretried; no loops, but very poor Whisper quality. Best guess: business call about students in a teaching pair/group, an SMM person and Instagram promotion, payments ~500 EUR/month",
  "2026-10-29 20:31:38\tlabelled\t2026/10/26/Сміття_transcript_2026-10-26_2026-10-26_21-56-56.txt\t2026/10/26/2026-10-26 21-56-56.mp4\tgarbage after retry: 4 bytes, single word 'you'",
  "",
].join("\n");

// Real day folders on 29.10.2026 (no attempt files remained there).
const REAL_DAYS: Record<string, string[]> = {
  "2026/10/26": ["2026-10-26 21-56-56.mp4", "Сміття_transcript_2026-10-26_2026-10-26_21-56-56.txt"],
  "2026/10/27": ["2026-10-27 10-05-40.mp4", "Пара_Історія_архівної_справи_transcript_2026-10-27_2026-10-27_10-05-40.txt"],
  "2026/10/29": [
    "2026-10-29 09-03-05.mp4", "2026-10-29 15-13-24.mp4", "2026-10-29 17-01-21.mp4",
    "Пара_Історія_архівної_справи_transcript_2026-10-29_2026-10-29_09-03-05.txt",
    "Пара_Бібліотекознавство_transcript_2026-10-29_2026-10-29_15-13-24.txt",
    "Невідомо_transcript_2026-10-29_2026-10-29_17-01-21.txt",
  ],
};

const EMPTY: ReviewLog = { retranscribe: new Set() };
const PARTIAL = ".densemble-0f1e2d3c-4b5a-4987-a654-3210fedcba98.partial";

function run(dayRel: string, file: string, entries: string[], log: ReviewLog = EMPTY, media?: DayMedia[]) {
  return classify({
    dayRel, file, entries, log,
    media: media ?? entries.filter(isMediaName).map((name) => ({ name, mtimeMs: 0 })),
  }).kind;
}

describe("recordings folder contract", () => {
  it("recognises media by extension, case-insensitively, and never hidden files", () => {
    expect(MEDIA_EXTENSIONS.size).toBe(11);
    for (const name of ["a.m4a", "a.MP4", "b.Mov", "c.opus", "x.y.webm", "Лекція 1.AAC"]) expect(isMediaName(name)).toBe(true);
    for (const name of [".hidden.mp4", "notes.txt", "mp4", "a.mp4.txt", "a.", PARTIAL, ".mp4"]) expect(isMediaName(name)).toBe(false);
  });

  it("derives recording names and transcript keys like the bash tool", () => {
    expect(recordingName("2026-10-29 09-03-05.mp4")).toBe("2026-10-29 09-03-05");
    expect(recordingName("talk.v2.final.m4a")).toBe("talk.v2.final");
    expect(recordingName("noext")).toBe("noext");
    expect(transcriptKey("2026-10-29", "2026-10-29 09-03-05.mp4")).toBe("transcript_2026-10-29_2026-10-29_09-03-05");
    expect(transcriptKey("2026-10-29", "Пара  з історії v1.2.m4a")).toBe("transcript_2026-10-29_Пара__з_історії_v1.2");
  });

  it("dates OBS names only when the date is real, otherwise falls back to local mtime", () => {
    const mtime = new Date(2026, 9, 5, 12, 0).getTime();
    expect(localDate(mtime)).toBe("2026-10-05");
    expect(obsDate("2026-10-29 09-03-05.mp4")).toBe("2026-10-29");
    expect(obsDate("2024-02-29 00-00-00.mkv")).toBe("2024-02-29");
    expect(obsDate("2026-02-30 10-00-00.mp4")).toBeUndefined();
    expect(obsDate("2026-10-29_09-03-05.mp4")).toBeUndefined();
    expect(obsDate("Лекція 2026-10-29 09-03-05.mp4")).toBeUndefined();
    expect(rootTargetDate("2026-10-29 09-03-05.mp4", mtime)).toBe("2026-10-29");
    expect(rootTargetDate("2026-02-30 10-00-00.mp4", mtime)).toBe("2026-10-05");
    expect(rootTargetDate("Зустріч.m4a", mtime)).toBe("2026-10-05");
  });

  it("maps dates to day folders and accepts only exact YYYY/MM/DD", () => {
    expect(dayFolder("2026-10-29")).toBe("2026/10/29");
    expect(parseDayFolder("2026/10/29")).toBe("2026-10-29");
    for (const rel of ["2026/1/05", "2026/10/29/x", "../..", "2026\\10\\29", "2026/10", "/2026/10/29", "2026/10/29/"]) {
      expect(parseDayFolder(rel)).toBeUndefined();
    }
  });

  it("matches only our own partial temp names", () => {
    expect(PARTIAL_PATTERN.test(PARTIAL)).toBe(true);
    expect(PARTIAL_PATTERN.test(".densemble-x.partial")).toBe(false);
    expect(PARTIAL_PATTERN.test("densemble-0f1e2d3c-4b5a-4987-a654-3210fedcba98.partial")).toBe(false);
  });

  it("parses the real review log and ignores malformed lines and CRLF", () => {
    expect([...parseReviewLog(REAL_LOG).retranscribe]).toEqual([
      "2026/10/26/transcript_2026-10-26_2026-10-26_21-56-56.txt",
      "2026/10/29/transcript_2026-10-29_2026-10-29_09-03-05.txt",
      "2026/10/29/transcript_2026-10-29_2026-10-29_17-01-21.txt",
    ]);
    const messy = "garbage\r\nt\tretranscribe\r\nt\tretranscribe\t\tr\tx\r\nt\tRetranscribe\ta.txt\r\n" +
      "t\tretranscribe\t2026/10/01/transcript_2026-10-01_a.txt\tr\treason\r\n";
    expect([...parseReviewLog(messy).retranscribe]).toEqual(["2026/10/01/transcript_2026-10-01_a.txt"]);
    expect(parseReviewLog("").retranscribe.size).toBe(0);
  });

  it("classifies every real recording as done", () => {
    const log = parseReviewLog(REAL_LOG);
    for (const [dayRel, entries] of Object.entries(REAL_DAYS)) {
      for (const file of entries.filter(isMediaName)) expect(run(dayRel, file, entries, log), file).toBe("done");
    }
  });

  it("classifies new, done, attempt-only and retry recordings", () => {
    const day = "2026/10/29";
    const file = "Нарада (1).m4a";
    const key = "transcript_2026-10-29_Нарада_(1)";
    const queued: ReviewLog = { retranscribe: new Set([`${day}/${key}.txt`]) };
    expect(run(day, file, [file])).toBe("new");
    expect(run(day, file, [file, PARTIAL])).toBe("new");
    expect(run(day, file, [file, `${key}.txt`])).toBe("done");
    expect(run(day, file, [file, `Пара_Історія_архівної_справи_${key}.txt`])).toBe("done");
    expect(run(day, file, [file, `${key}.attempt-1.txt`])).toBe("done");
    expect(run(day, file, [file, `${key}.attempt-x.txt`, `${key}.txt.partial`, `x${key}.txt`])).toBe("new");
    expect(run(day, file, [file, `${key}.attempt-1.txt`, PARTIAL], queued)).toBe("retry");
    expect(run(day, file, [file, `${key}.attempt-1.txt`, `${key}.txt`], queued)).toBe("done");
    expect(run(day, file, [file, `${key}.attempt-1.txt`, `Сміття_${key}.txt`], queued)).toBe("done");
    // a transcript keeps the key done even if the recording itself is gone
    expect(run(day, file, [`${key}.txt`], EMPTY, [])).toBe("done");
  });

  it("escapes regex metacharacters in recording names", () => {
    const day = "2026/10/29";
    const key = "transcript_2026-10-29_a+b(c)";
    expect(run(day, "a+b(c).mp4", ["a+b(c).mp4", `${key}.attempt-2.txt`])).toBe("done");
    expect(run(day, "a+b(c).mp4", ["a+b(c).mp4", "transcript_2026-10-29_aab(c).attempt-2.txt"])).toBe("new");
  });

  it("lets only the oldest of same-key recordings proceed and reports the rest", () => {
    const day = "2026/10/29";
    const entries = ["a.mp4", "a.m4a"];
    const older = [{ name: "a.mp4", mtimeMs: 1 }, { name: "a.m4a", mtimeMs: 2 }];
    expect(run(day, "a.mp4", entries, EMPTY, older)).toBe("new");
    expect(classify({ dayRel: day, file: "a.m4a", media: older, entries, log: EMPTY }))
      .toEqual({ kind: "conflict", reason: "SAME_KEY" });
    const newer = [{ name: "a.mp4", mtimeMs: 3 }, { name: "a.m4a", mtimeMs: 2 }];
    expect(run(day, "a.mp4", entries, EMPTY, newer)).toBe("conflict");
    expect(run(day, "a.m4a", [...entries, "transcript_2026-10-29_a.txt"], EMPTY, newer)).toBe("done");
    const tie = [{ name: "a.mp4", mtimeMs: 5 }, { name: "a.m4a", mtimeMs: 5 }];
    expect(run(day, "a.m4a", entries, EMPTY, tie)).toBe("new");
    expect(run(day, "a.mp4", entries, EMPTY, tie)).toBe("conflict");
    // "a b.mp4" and "a_b.mp4" also share a key
    expect(run(day, "a_b.mp4", ["a b.mp4", "a_b.mp4"], EMPTY, [{ name: "a b.mp4", mtimeMs: 1 }, { name: "a_b.mp4", mtimeMs: 1 }]))
      .toBe("conflict");
  });

  it("rejects an invalid day folder", () => {
    expect(() => run("2026/1/05", "a.mp4", ["a.mp4"])).toThrow("RECORDINGS_DAY_FOLDER_INVALID");
  });
});
