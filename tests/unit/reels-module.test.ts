import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AbilityCall, ModuleChatBridge, ModuleDefinition } from "../../src/modules/contract.js";
import { createModuleHost } from "../../src/modules/host.js";
import type { RecordingsApi } from "../../src/modules/recordings/api.js";
import { module as reels } from "../../src/modules/reels/index.js";
import { entry, fakeCore, fakeLoader, fakeModule } from "../fixtures/modules/index.js";

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const tools = existsSync(FFMPEG) && existsSync(FFPROBE);

let tmp: string;
let workspace: string;
beforeEach(() => {
  tmp = resolve(".cache", `reels-module-${randomUUID()}`);
  workspace = join(tmp, "workspace");
  mkdirSync(join(tmp, "data"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const scope = { ownerId: 1, botId: "bot", chatId: 1, topicId: null };
const call = (overrides: Partial<AbilityCall> = {}): AbilityCall => ({ scope, agentId: "mr-beast", userId: 1, owner: true,
  workspace, signal: new AbortController().signal, ...overrides });

/** A recordings stand-in: writes a two-phrase timed transcript instead of running whisper. */
function recordings(): ModuleDefinition<unknown, RecordingsApi> & { requests: unknown[] } {
  const requests: unknown[] = [];
  const definition = fakeModule<unknown, RecordingsApi>("recordings", {
    start: async () => ({ stop: async () => undefined, provides: { async transcribeMedia(request) {
      requests.push(request);
      request.onProgress?.(50);
      const phrases = [
        { start: 1, end: 4, speaker: "Owner", text: "Привіт усім, це перший шматок.", words: "Привіт усім, це перший шматок.".split(" ")
          .map((text, index) => ({ start: 1 + index * 0.6, end: 1.5 + index * 0.6, text })) },
        { start: 6, end: 9, speaker: "Speaker 2", text: "А це друга людина говорить.", words: "А це друга людина говорить.".split(" ")
          .map((text, index) => ({ start: 6 + index * 0.6, end: 6.5 + index * 0.6, text })) },
      ];
      const transcript = join(request.outputDirectory, `${request.key}.txt`);
      const words = join(request.outputDirectory, `${request.key}.words.json`);
      writeFileSync(transcript, "[00:00:01] Owner: Привіт усім, це перший шматок.\n[00:00:06] Speaker 2: А це друга людина говорить.\n");
      writeFileSync(words, JSON.stringify({ version: 1, speakers: ["Owner", "Speaker 2"], phrases }));
      return { transcript, words, speakers: "separated" };
    } } }),
  });
  return Object.assign(definition, { requests });
}

function host(chat: ModuleChatBridge) {
  return createModuleHost({
    entries: [entry("recordings"), entry("reels", { agents: ["mr-beast"], settings: {} })],
    loader: fakeLoader([recordings(), reels as ModuleDefinition]),
    core: fakeCore({ ownerWorkspaces: [workspace], managedRoots: [join(tmp, "data")],
      audio: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, whisperPath: "whisper-cli", vocabulary: [] } }),
    runtimeDataPath: join(tmp, "data"), diagnostics: { record: vi.fn() }, readInstructions: async () => "# instructions",
    chat: () => chat,
  });
}
function bridge(sendOk = true) {
  const wakes: string[] = [];
  const files: { path: string; caption?: string }[] = [];
  const chat: ModuleChatBridge = {
    send: () => true,
    sendFile: async (_caller, _scope, path, options) => { files.push({ path, ...(options.caption ? { caption: options.caption } : {}) }); return sendOk; },
    wake: async (_caller, _scope, note) => { wakes.push(note); return true; },
  };
  return { chat, wakes, files };
}
async function until(predicate: () => boolean, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("TEST_CONDITION_TIMEOUT");
    await new Promise((done) => setTimeout(done, 20));
  }
}

describe("reels module abilities (spec 006)", () => {
  it("starts with recordings, creates its folder and refuses non-owners and other workspaces (FR-020)", async () => {
    const { chat } = bridge();
    const modules = host(chat);
    await modules.start();
    expect(modules.health("reels")?.state).toBe("ready");
    expect(existsSync(join(workspace, "raw", "reels"))).toBe(true);
    const ability = (name: string) => modules.abilities().find((item) => item.spec.name === name)!;
    expect(modules.abilities().map((item) => item.spec.name)).toEqual(expect.arrayContaining(["reels_prepare", "reels_transcript", "reels_cut", "reels_status"]));
    expect(await ability("reels_status").invoke({}, call({ owner: false }))).toMatchObject({ ok: false, code: "REELS_OWNER_ONLY" });
    expect(await ability("reels_status").invoke({}, call({ workspace: join(tmp, "other") }))).toMatchObject({ ok: false, code: "REELS_WORKSPACE_DENIED" });
    expect(await ability("reels_prepare").invoke({ source: "https://evil.example/x.mp4" }, call())).toMatchObject({ ok: false, code: "REELS_SOURCE_INVALID" });
    expect(await ability("reels_prepare").invoke({ source: "../outside.mp4" }, call())).toMatchObject({ ok: false, code: "REELS_SOURCE_INVALID" });
    expect(await ability("reels_transcript").invoke({ video: "yt-dQw4w9WgXcQ" }, call())).toMatchObject({ ok: false, code: "REELS_VIDEO_UNKNOWN" });
    expect(await ability("reels_status").invoke({}, call())).toEqual({ ok: true, jobs: [], videos: [] });
    expect((await modules.stop()).incomplete).toEqual([]);
  });

  it.skipIf(!tools)("prepares a workspace video, reads its transcript, rejects a bad list and cuts exactly the given reels", async () => {
    const source = join(workspace, "talk.mp4");
    execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12", "-f", "lavfi",
      "-i", "sine=frequency=300:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source]);
    const before = readFileSync(source);
    const { chat, wakes, files } = bridge();
    const modules = host(chat);
    await modules.start();
    const ability = (name: string) => modules.abilities().find((item) => item.spec.name === name)!;

    const started = await ability("reels_prepare").invoke({ source: "talk.mp4" }, call());
    expect(started).toMatchObject({ ok: true, state: "started", video: expect.stringMatching(/^file-[0-9a-f]{12}$/) });
    const video = (started as unknown as { video: string }).video;
    await until(() => wakes.length === 1);
    // The title stays out of the agent's turn.
    expect(wakes[0]).toMatch(new RegExp(`^Video ${video} \\(00:00:12\\) is prepared: 2 phrases, speakers: Owner, Speaker 2\\.`));
    expect(await ability("reels_prepare").invoke({ source: join(workspace, "talk.mp4") }, call())).toMatchObject({ state: "ready", video });

    expect(await ability("reels_transcript").invoke({ video, from: "00:05" }, call())).toMatchObject({ ok: true, durationSeconds: expect.any(Number),
      speakers: ["Owner", "Speaker 2"], text: "[00:00:06] Speaker 2: А це друга людина говорить." });

    const rejected = await ability("reels_cut").invoke({ video, reels: [{ start: "0:01", end: "0:03", title: "Коротко" },
      { start: "x", end: "0:09", title: "Погано" }] }, call());
    expect(rejected).toMatchObject({ ok: false, code: "REELS_CUTS_REJECTED" });
    expect((rejected as { message: string }).message).toContain("reel 1: REELS_CUT_TOO_SHORT; reel 2: REELS_TIME_INVALID");

    const cut = await ability("reels_cut").invoke({ video, reels: [{ start: "0:01", end: "0:06.5", title: "Перший шматок" },
      { start: 6.5, end: 11.9, title: "Друга людина", subtitles: false, showTitle: false }] }, call());
    expect(cut).toMatchObject({ ok: true, reels: 2 });
    await until(() => wakes.length === 2, 60_000);
    expect(wakes[1]).toBe(`Cut 2 reel(s) from video ${video}: 01-pershyi-shmatok.mp4, 02-druha-liudyna.mp4. ` +
      "They were sent to this chat and listed in the video's cuts.md.");
    const folder = join(workspace, "raw", "reels", video);
    expect(readdirSync(join(folder, "reels"))).toEqual(["01-pershyi-shmatok.mp4", "02-druha-liudyna.mp4"]);
    expect(files.map((file) => file.caption)).toEqual(["01 · Перший шматок\n00:00:00–00:00:06", "02 · Друга людина\n00:00:06–00:00:09"]);
    const probe = execFileSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0",
      join(folder, "reels", "01-pershyi-shmatok.mp4")], { encoding: "utf8" });
    expect(probe.trim()).toBe("1080,1920");
    expect(readFileSync(join(folder, "cuts.md"), "utf8")).toMatch(/\| 1 \| reels\/01-pershyi-shmatok.mp4 \| 00:00:00 \| 00:00:06 \| Перший шматок \| yes \| yes \|/);
    // FR-014: the source and its transcript are untouched.
    expect(readFileSync(source).equals(before)).toBe(true);
    const status = await ability("reels_status").invoke({ video }, call());
    expect(status).toMatchObject({ ok: true, videos: [{ id: video, reels: 2, speakers: "separated" }] });
    expect((status as unknown as { jobs: { kind: string; stage: string }[] }).jobs.map((job) => [job.kind, job.stage])).toEqual([["cut", "done"], ["prepare", "done"]]);
    expect((await modules.stop()).incomplete).toEqual([]);
  }, 90_000);

  it.skipIf(!tools)("refuses a symlinked video folder, reports unsent reels and queues one job for concurrent prepares", async () => {
    const source = join(workspace, "talk.mp4");
    execFileSync(FFMPEG, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=12", "-f", "lavfi",
      "-i", "sine=frequency=300:duration=12", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source]);
    const { chat, wakes } = bridge(false);
    const modules = host(chat);
    await modules.start();
    const ability = (name: string) => modules.abilities().find((item) => item.spec.name === name)!;
    const [first, second] = await Promise.all([ability("reels_prepare").invoke({ source: "talk.mp4" }, call()),
      ability("reels_prepare").invoke({ source: "talk.mp4" }, call())]);
    expect([first, second].map((result) => (result as unknown as { state: string }).state).sort()).toEqual(["running", "started"]);
    const video = (first as unknown as { video: string }).video;
    await until(() => wakes.length === 1);
    await ability("reels_cut").invoke({ video, reels: [{ start: 1, end: 7, title: "Один" }] }, call());
    await until(() => wakes.length === 2, 60_000);
    expect(wakes[1]).toContain("Reel(s) 1 could not be sent to this chat");

    // A planted symlink for the reels folder is refused, nothing is written through it.
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    rmSync(join(workspace, "raw", "reels", video, "reels"), { recursive: true });
    symlinkSync(outside, join(workspace, "raw", "reels", video, "reels"));
    await ability("reels_cut").invoke({ video, reels: [{ start: 1, end: 7, title: "Два" }] }, call());
    await until(() => wakes.length === 3, 60_000);
    expect(wakes[2]).toContain("REELS_FOLDER_UNSAFE");
    expect(readdirSync(outside)).toEqual([]);
    expect((await modules.stop()).incomplete).toEqual([]);
  }, 90_000);

  // Live: downloads a 19-second public video. Run with REELS_LIVE=1.
  it.skipIf(!tools || !process.env.REELS_LIVE || !existsSync("/opt/homebrew/bin/yt-dlp"))(
    "deletes a YouTube download after cutting and fetches it again for the next cut", async () => {
      const { chat, wakes } = bridge();
      const modules = createModuleHost({
        entries: [entry("recordings"), entry("reels", { agents: ["mr-beast"], settings: { ytDlpPath: "/opt/homebrew/bin/yt-dlp" } })],
        loader: fakeLoader([recordings(), reels as ModuleDefinition]),
        core: fakeCore({ ownerWorkspaces: [workspace], managedRoots: [join(tmp, "data")],
          audio: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, whisperPath: "whisper-cli", vocabulary: [] } }),
        runtimeDataPath: join(tmp, "data"), diagnostics: { record: vi.fn() }, readInstructions: async () => "# x", chat: () => chat,
      });
      await modules.start();
      const ability = (name: string) => modules.abilities().find((item) => item.spec.name === name)!;
      expect(await ability("reels_prepare").invoke({ source: "https://youtu.be/jNQXAC9IVRw" }, call())).toMatchObject({ state: "started" });
      await until(() => wakes.length === 1, 120_000);
      const folder = join(workspace, "raw", "reels", "yt-jNQXAC9IVRw");
      expect(readdirSync(folder)).toContain("source.mp4");
      await ability("reels_cut").invoke({ video: "yt-jNQXAC9IVRw", reels: [{ start: 1, end: 7, title: "Перший" }] }, call());
      await until(() => wakes.length === 2, 120_000);
      expect(wakes[1]).toMatch(/^Cut 1 reel/);
      expect(readdirSync(folder).filter((name) => name.startsWith("source."))).toEqual([]);
      await ability("reels_cut").invoke({ video: "yt-jNQXAC9IVRw", reels: [{ start: 8, end: 15, title: "Другий" }] }, call());
      await until(() => wakes.length === 3, 180_000);
      expect(wakes[2]).toMatch(/^Cut 1 reel/);
      expect(readdirSync(join(folder, "reels"))).toEqual(["01-pershyi.mp4", "02-druhyi.mp4"]);
      expect(readdirSync(folder).filter((name) => name.startsWith("source."))).toEqual([]);
      expect((await modules.stop()).incomplete).toEqual([]);
    }, 400_000);
});

