import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { link, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaError } from "../../src/media/errors.js";
import { runManagedProcess, type ProcessRunner } from "../../src/media/process.js";
import { fileRecording, isFinished, isOpenByAnyProcess, probeDuration, repairInterruptedFiling,
  type FinishedCheckOptions } from "../../src/modules/recordings/filing.js";

let root: string;
beforeEach(() => {
  root = resolve(".cache", `recordings-filing-unit-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Behaviour { lsof?: () => Promise<string>; ffprobe?: () => Promise<string> }
function fakeRunner(behaviour: Behaviour, calls: string[][] = []): ProcessRunner {
  return async (executable, args) => {
    if (executable === "/bin/sh") {
      // isOpenByAnyProcess runs lsof through sh to observe lsof's own exit status.
      calls.push([args[2]!, "-t", "--", args[3]!]);
      if (!behaviour.lsof) throw new Error("unexpected lsof");
      try { return { stdout: `${await behaviour.lsof()}lsof-status:0\n`, stderr: "" }; }
      catch (error) {
        if (!(error instanceof MediaError) || !["MEDIA_AUDIO_FAILED", "MEDIA_AUDIO_TOOLS_MISSING"].includes(error.code)) throw error;
        return { stdout: error.code === "MEDIA_AUDIO_FAILED" ? "lsof-status:1\n" : "sh: lsof: not found\nlsof-status:127\n", stderr: "" };
      }
    }
    calls.push([executable, ...args]);
    const handler = executable.endsWith("lsof") ? behaviour.lsof : behaviour.ffprobe;
    if (!handler) throw new Error(`unexpected ${executable}`);
    return { stdout: await handler(), stderr: "" };
  };
}
const reject = (code: ConstructorParameters<typeof MediaError>[0]) => () => Promise.reject(new MediaError(code));
function options(runner: ProcessRunner, overrides: Partial<FinishedCheckOptions> = {}): FinishedCheckOptions {
  return { runner, ffprobePath: "/x/ffprobe", lsofPath: "/x/lsof", quietMs: 60_000, now: () => Date.now() + 120_000,
    signal: new AbortController().signal, ...overrides };
}
function audio(name = "a.m4a", content = "data"): string {
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

describe("isOpenByAnyProcess", () => {
  it("reports open when lsof prints a pid", async () => {
    const calls: string[][] = [];
    const path = audio();
    expect(await isOpenByAnyProcess(path, options(fakeRunner({ lsof: async () => "1234\n" }, calls)))).toBe(true);
    expect(calls[0]).toEqual(["/x/lsof", "-t", "--", path]);
  });
  it("reports open when lsof fails with an error message", async () => {
    const runner: ProcessRunner = async () => ({ stdout: "lsof: WARNING: can't stat()\nlsof-status:1\n", stderr: "" });
    expect(await isOpenByAnyProcess(audio(), options(runner))).toBe(true);
  });
  it("reports closed when lsof exits non-zero", async () => {
    expect(await isOpenByAnyProcess(audio(), options(fakeRunner({ lsof: reject("MEDIA_AUDIO_FAILED") })))).toBe(false);
  });
  it("treats missing tools and timeouts as open", async () => {
    expect(await isOpenByAnyProcess(audio(), options(fakeRunner({ lsof: reject("MEDIA_AUDIO_TOOLS_MISSING") })))).toBe(true);
    expect(await isOpenByAnyProcess(audio(), options(fakeRunner({ lsof: reject("MEDIA_TIMEOUT") })))).toBe(true);
  });
  it("rethrows abort", async () => {
    await expect(isOpenByAnyProcess(audio(), options(fakeRunner({ lsof: reject("MEDIA_ABORTED") }))))
      .rejects.toMatchObject({ code: "MEDIA_ABORTED" });
  });
});

describe("probeDuration", () => {
  it("parses a positive duration", async () => {
    const calls: string[][] = [];
    const path = audio();
    expect(await probeDuration(path, options(fakeRunner({ ffprobe: async () => "12.5\n" }, calls)))).toBe(12.5);
    expect(calls[0]?.at(-1)).toBe(path);
  });
  it("returns undefined for garbage, zero, N/A and failures", async () => {
    for (const out of ["N/A\n", "0.000000\n", "", "abc", "1e309"]) {
      expect(await probeDuration(audio(), options(fakeRunner({ ffprobe: async () => out })))).toBeUndefined();
    }
    expect(await probeDuration(audio(), options(fakeRunner({ ffprobe: reject("MEDIA_AUDIO_FAILED") })))).toBeUndefined();
    expect(await probeDuration(audio(), options(fakeRunner({ ffprobe: reject("MEDIA_TIMEOUT") })))).toBeUndefined();
  });
  it("rethrows abort", async () => {
    await expect(probeDuration(audio(), options(fakeRunner({ ffprobe: reject("MEDIA_ABORTED") }))))
      .rejects.toMatchObject({ code: "MEDIA_ABORTED" });
  });
});

describe("isFinished", () => {
  const ready = { lsof: reject("MEDIA_AUDIO_FAILED"), ffprobe: async () => "3.25\n" };
  it("is finished when quiet, closed and probeable", async () => {
    expect(await isFinished(audio(), options(fakeRunner(ready)))).toEqual({ finished: true, durationSeconds: 3.25 });
  });
  it("waits for the quiet period without running tools", async () => {
    const calls: string[][] = [];
    const path = audio();
    const mtime = statSync(path).mtimeMs;
    const result = await isFinished(path, options(fakeRunner(ready, calls), { now: () => mtime + 59_999 }));
    expect(result).toEqual({ finished: false });
    expect(calls).toEqual([]);
    expect((await isFinished(path, options(fakeRunner(ready), { now: () => mtime + 60_000 }))).finished).toBe(true);
  });
  it("is not finished while open or unprobeable", async () => {
    expect((await isFinished(audio(), options(fakeRunner({ ...ready, lsof: async () => "77\n" })))).finished).toBe(false);
    expect((await isFinished(audio(), options(fakeRunner({ ...ready, ffprobe: async () => "N/A" })))).finished).toBe(false);
  });
  it("rejects symlinks, directories and missing files", async () => {
    const target = audio();
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(target, old, old);
    const linkPath = join(root, "link.m4a");
    symlinkSync(target, linkPath);
    mkdirSync(join(root, "dir.m4a"));
    const calls: string[][] = [];
    for (const path of [linkPath, join(root, "dir.m4a"), join(root, "missing.m4a")]) {
      expect(await isFinished(path, options(fakeRunner(ready, calls)))).toEqual({ finished: false });
    }
    expect(calls).toEqual([]);
  });
});

describe("fileRecording", () => {
  it("moves the file into nested day folders preserving content and inode", async () => {
    const source = audio("2026-10-29 10-00-00.m4a", "payload");
    const inode = statSync(source).ino;
    const day = join(root, "2026", "10", "29");
    expect(await fileRecording(source, day)).toBe("filed");
    const target = join(day, "2026-10-29 10-00-00.m4a");
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("payload");
    expect(statSync(target).ino).toBe(inode);
    expect(statSync(target).nlink).toBe(1);
  });
  it("reports conflict and leaves both files untouched", async () => {
    const source = audio("x.m4a", "new");
    const day = join(root, "2026", "10", "29");
    mkdirSync(day, { recursive: true });
    const target = join(day, "x.m4a");
    writeFileSync(target, "old");
    const before = [statSync(source), statSync(target)];
    expect(await fileRecording(source, day)).toBe("conflict");
    expect(readFileSync(source, "utf8")).toBe("new");
    expect(readFileSync(target, "utf8")).toBe("old");
    const after = [statSync(source), statSync(target)];
    expect(after.map((s) => [s.ino, s.size, s.mtimeMs, s.nlink])).toEqual(before.map((s) => [s.ino, s.size, s.mtimeMs, s.nlink]));
  });
  it("propagates other errors", async () => {
    await expect(fileRecording(join(root, "missing.m4a"), join(root, "day"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("repairInterruptedFiling", () => {
  it("removes a same-inode root remnant only", async () => {
    const source = audio("r.m4a", "keep");
    const target = join(root, "day", "r.m4a");
    mkdirSync(join(root, "day"));
    await link(source, target);
    expect(await repairInterruptedFiling(source, target)).toBe(true);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
  it("leaves different-inode pairs, missing targets and identical paths alone", async () => {
    const source = audio("r.m4a", "a");
    mkdirSync(join(root, "day"));
    const target = join(root, "day", "r.m4a");
    writeFileSync(target, "a");
    expect(await repairInterruptedFiling(source, target)).toBe(false);
    expect(await repairInterruptedFiling(source, join(root, "day", "none.m4a"))).toBe(false);
    expect(await repairInterruptedFiling(source, source)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("a");
    expect(readFileSync(target, "utf8")).toBe("a");
  });
});

const ffmpeg = "/opt/homebrew/bin/ffmpeg";
const ffprobe = "/opt/homebrew/bin/ffprobe";
const lsof = "/usr/sbin/lsof";
const realTools = [ffmpeg, ffprobe, lsof].every((tool) => existsSync(tool));

describe.skipIf(!realTools)("real ffprobe and lsof", () => {
  it("probes duration and detects open handles", async () => {
    const path = join(root, "sine.wav");
    const made = spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=1", path]);
    expect(made.status).toBe(0);
    const opts = options(runManagedProcess, { ffprobePath: ffprobe, lsofPath: lsof });
    expect(await probeDuration(path, opts)).toBeCloseTo(1, 1);
    const handle = await open(path, "a");
    try {
      expect(await isOpenByAnyProcess(path, opts)).toBe(true);
    } finally {
      await handle.close();
    }
    expect(await isOpenByAnyProcess(path, opts)).toBe(false);
  }, 30_000);
});
