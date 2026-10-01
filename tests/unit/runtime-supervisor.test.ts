import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessSupervisor, nativeProcesses, sameProcess } from "../../src/agents/supervisor.js";
import { until } from "./session-runtime-fixtures.js";

function child(): Promise<ChildProcess> {
  const process = spawn(globalThis.process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore", env: { PATH: "/usr/bin:/bin" },
  });
  return new Promise((done, fail) => { process.once("spawn", () => done(process)); process.once("error", fail); });
}
function exit(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
  return new Promise((done) => { process.once("exit", () => done()); process.kill("SIGKILL"); });
}

describe("actual owned process lifecycle without model inference", () => {
  it("reports unexpected native root loss without claiming or terminating a neighboring process", async () => {
    const root = resolve(".cache", `runtime-native-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const neighbor = await child();
    let owned: ChildProcess | undefined;
    const failures: string[] = [];
    const supervisor = new ProcessSupervisor(root, process.execPath, { record: () => undefined });
    supervisor.onFailure((code) => failures.push(code));
    try {
      const neighborIdentity = (await nativeProcesses.snapshot()).find((entry) => entry.pid === neighbor.pid)!;
      await supervisor.start(async () => { owned = await child(); });
      await exit(owned!);
      await until(() => failures.length > 0);
      expect(failures).toEqual(["RUNTIME_PROCESS_EXITED"]);
      await supervisor.stop(async () => undefined);
      expect((await nativeProcesses.snapshot()).some((entry) => sameProcess(entry, neighborIdentity))).toBe(true);
      expect(await readdir(join(root, "processes"))).toEqual([]);
    } finally {
      try { await supervisor.stop(async () => { if (owned) await exit(owned); }); }
      finally {
        if (owned) await exit(owned);
        await exit(neighbor);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 10_000);
  it("journals a concrete native PID/start and stops it without touching a pre-existing neighbor", async () => {
    const root = resolve(".cache", `runtime-native-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    const neighbor = await child();
    let owned: ChildProcess | undefined;
    const supervisor = new ProcessSupervisor(root, process.execPath, { record: () => undefined });
    try {
      const neighborIdentity = (await nativeProcesses.snapshot()).find((entry) => entry.pid === neighbor.pid)!;
      await supervisor.start(async () => { owned = await child(); });
      const identity = (await nativeProcesses.snapshot()).find((entry) => entry.pid === owned?.pid)!;
      expect(identity.pid).not.toBe(neighborIdentity.pid);
      expect(await readdir(join(root, "processes"))).toHaveLength(1);
      await supervisor.stop(async () => { if (owned) await exit(owned); });
      const after = await nativeProcesses.snapshot();
      expect(after.some((entry) => sameProcess(identity, entry))).toBe(false);
      expect(after.some((entry) => sameProcess(neighborIdentity, entry))).toBe(true);
      expect(await readdir(join(root, "processes"))).toEqual([]);
      await until(() => owned?.signalCode !== null);
    } finally {
      try { await supervisor.stop(async () => { if (owned) await exit(owned); }); }
      finally {
        if (owned) await exit(owned);
        await exit(neighbor);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 10_000);
});
