import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModuleHost, instructionsReader } from "../../src/modules/host.js";
import { adoptLegacyData, module } from "../../src/modules/recordings/index.js";
import { RECORDING_DEFAULTS, type RecordingSettings } from "../../src/modules/recordings/settings.js";
import { createRecordingWorker } from "../../src/modules/recordings/worker.js";
import { entry, fakeCore } from "../fixtures/modules/index.js";

let tmp: string;
let runtime: string;
let folder: string;
beforeEach(() => {
  tmp = resolve(".cache", `recordings-module-${randomUUID()}`);
  runtime = join(tmp, "data");
  folder = join(tmp, "workspace", "raw", "recordings");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(folder, { recursive: true });
});
afterEach(() => {
  chmodSync(folder, 0o700);
  rmSync(tmp, { recursive: true, force: true });
});
const diagnostics = () => ({ record: vi.fn() });

describe("recordings module data directory (R14)", () => {
  it("renames the spec 004 directory once, keeping active-process.json for the orphan check", async () => {
    const legacy = join(runtime, "recordings");
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "active-process.json"), JSON.stringify({ pid: 12345 }));
    const target = join(runtime, "modules", "recordings");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const sink = diagnostics();
    await adoptLegacyData(target, sink);
    expect(existsSync(legacy)).toBe(false);
    expect(JSON.parse(readFileSync(join(target, "active-process.json"), "utf8"))).toEqual({ pid: 12345 });
    expect(sink.record).toHaveBeenCalledWith("RECORDINGS_DATA_MOVED");
    sink.record.mockClear();
    await adoptLegacyData(target, sink);
    expect(sink.record).not.toHaveBeenCalled();
  });

  it("keeps both directories when both hold data, but hands the legacy active process over to the orphan check", async () => {
    const legacy = join(runtime, "recordings");
    mkdirSync(legacy, { mode: 0o700 });
    writeFileSync(join(legacy, "status.json"), "{\"old\":true}");
    writeFileSync(join(legacy, "active-process.json"), JSON.stringify({ pid: 12345 }));
    const target = join(runtime, "modules", "recordings");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, "status.json"), "{\"new\":true}");
    const sink = diagnostics();
    await adoptLegacyData(target, sink);
    expect(sink.record).toHaveBeenCalledWith("RECORDINGS_DATA_MOVE_FAILED");
    expect(readFileSync(join(legacy, "status.json"), "utf8")).toBe("{\"old\":true}");
    expect(readFileSync(join(target, "status.json"), "utf8")).toBe("{\"new\":true}");
    expect(JSON.parse(readFileSync(join(target, "active-process.json"), "utf8"))).toEqual({ pid: 12345 });
    expect(existsSync(join(legacy, "active-process.json"))).toBe(false);

    // The module's own active process wins; the legacy one stays where it is.
    writeFileSync(join(legacy, "active-process.json"), JSON.stringify({ pid: 777 }));
    await adoptLegacyData(target, sink);
    expect(JSON.parse(readFileSync(join(target, "active-process.json"), "utf8"))).toEqual({ pid: 12345 });
    expect(existsSync(join(legacy, "active-process.json"))).toBe(true);
  });
});

describe("recordings module lifecycle", () => {
  const settings = () => ({ path: folder, modelPath: join(tmp, "absent.bin"), vadModelPath: join(tmp, "absent-vad.bin") });
  const host = (raw: unknown) => createModuleHost({ entries: [entry("recordings", { settings: raw })],
    core: fakeCore({ ownerWorkspaces: [join(tmp, "workspace")] }), runtimeDataPath: runtime, diagnostics: diagnostics() });
  it("is unavailable with the model code and a disabled status after moving old data", async () => {
    mkdirSync(join(runtime, "recordings"));
    writeFileSync(join(runtime, "recordings", "status.json"), "{}");
    const modules = host(settings());
    await modules.start();
    expect(modules.health("recordings")).toMatchObject({ state: "unavailable", code: "RECORDING_MODEL_MISSING" });
    expect(modules.report()[0]).toMatchObject({ cause: expect.any(String), fix: expect.any(String) });
    expect(existsSync(join(runtime, "recordings"))).toBe(false);
    const status = JSON.parse(readFileSync(join(runtime, "modules", "recordings", "status.json"), "utf8")) as { enabled: boolean };
    expect(status.enabled).toBe(false);
    await modules.stop();
  });
  it("answers recordings_status with the status snapshot when ready", async () => {
    const header = Buffer.alloc(48);
    [0x67676d6c, 51866, 1500, 1280, 20, 32, 448, 1280, 20, 4, 128, 1].forEach((value, index) => header.writeInt32LE(value, index * 4));
    writeFileSync(join(tmp, "model.bin"), header);
    writeFileSync(join(tmp, "vad.bin"), Buffer.from([0x6c, 0x6d, 0x67, 0x67, 0]));
    const modules = host({ ...settings(), modelPath: join(tmp, "model.bin"), vadModelPath: join(tmp, "vad.bin") });
    await modules.start();
    expect(modules.health("recordings")?.state).toBe("ready");
    const [ability] = modules.abilities();
    expect(ability?.spec.name).toBe("recordings_status");
    const result = await ability!.invoke({}, { scope: { ownerId: 1, botId: "b", chatId: 1, topicId: null }, agentId: "a",
      userId: 1, owner: true, workspace: tmp, signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: true, current: null, queue: [], waiting: [], conflicts: [], failed: [], recent: [] });
    expect(modules.report()[0]?.status).toMatch(/у черзі: 0/);
    expect((await modules.stop()).incomplete).toEqual([]);
  });
  it("is unavailable, not a config error, for a folder outside owner workspaces", async () => {
    const modules = host({ ...settings(), path: tmp });
    await modules.resolve();
    expect(modules.health("recordings")).toMatchObject({ state: "unavailable", code: "RECORDINGS_PATH_OUTSIDE_WORKSPACE" });
  });
  it("documents every ability with the required sections", async () => {
    const text = (await instructionsReader()("recordings"))!;
    for (const ability of module.abilities ?? []) {
      const section = text.split(/^## /m).find((part) => part.startsWith(`${ability.name}\n`))!;
      for (const heading of ["Purpose", "Inputs", "Returns", "Limits", "Errors"]) expect(section).toContain(`### ${heading}`);
    }
    expect(text.trim().endsWith("How abilities are combined is decided by the owner's skills and requests.")).toBe(true);
  });
});

describe("recording worker health hooks", () => {
  it("fails the module when the watched folder is unreadable and recovers on the next good pass", async () => {
    const settings: RecordingSettings = {
      path: folder, modelPath: "/m.bin", vadModelPath: "/v.bin", ffmpegPath: "ffmpeg", ffprobePath: "ffprobe",
      whisperPath: "whisper-cli", language: "auto", threads: 4, vocabulary: [], quietMinutes: 2, pollIntervalMs: 60_000,
      vad: { ...RECORDING_DEFAULTS.vad }, ...RECORDING_DEFAULTS.decoding,
      retry: { modelPath: "/m.bin", vad: { ...RECORDING_DEFAULTS.vad }, ...RECORDING_DEFAULTS.decoding },
      silence: { ...RECORDING_DEFAULTS.silence }, notifications: false,
    };
    const health = { fail: vi.fn(), recovered: vi.fn() };
    const worker = createRecordingWorker({ settings, dataPath: join(runtime, "modules", "recordings"), diagnostics: diagnostics(),
      runner: async () => { throw new Error("no process expected"); }, health,
      legacy: { plist: join(tmp, "missing.plist"), lock: join(tmp, "lock") } });
    chmodSync(folder, 0o000);
    await expect(worker.pass()).rejects.toThrow();
    expect(health.fail).toHaveBeenCalledWith("RECORDINGS_FOLDER_UNREADABLE");
    expect(health.recovered).not.toHaveBeenCalled();
    chmodSync(folder, 0o700);
    await worker.pass();
    expect(health.recovered).toHaveBeenCalledTimes(1);
    expect(worker.snapshot()).toMatchObject({ current: null, queue: [], failed: [] });
  });
});
