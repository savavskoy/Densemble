import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import type { DiagnosticSink } from "../ports.js";
import { bounded, RuntimeError } from "./contracts.js";

const exec = promisify(execFile);
export interface ProcessIdentity { pid: number; parent: number; started: string; command: string; state?: string | undefined }
export function parseProcesses(text: string): ProcessIdentity[] {
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const match = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new RuntimeError("PROCESS_LIST_INVALID");
    return match[4]!.startsWith("Z") ? [] : [{
      pid: Number(match[1]), parent: Number(match[2]), started: match[3]!, command: match[5]!, state: match[4]!,
    }];
  });
}
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.started === b.started && a.command === b.command;
}
export function descendants(root: ProcessIdentity, snapshot: ProcessIdentity[]): ProcessIdentity[] {
  if (!snapshot.some((entry) => sameProcess(entry, root))) return [];
  const pids = new Set([root.pid]);
  const result: ProcessIdentity[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of snapshot) {
      if (pids.has(entry.parent) && !pids.has(entry.pid)) {
        result.push(entry); pids.add(entry.pid); changed = true;
      }
    }
  }
  return result;
}
export interface ProcessAccess {
  snapshot(): Promise<ProcessIdentity[]>;
  signal(pid: number, signal: NodeJS.Signals): void;
}
export const nativeProcesses: ProcessAccess = {
  async snapshot() {
    const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,lstart=,stat=,comm="], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    return parseProcesses(stdout);
  },
  signal(pid, signal) {
    try { process.kill(pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new RuntimeError("PROCESS_SIGNAL_FAILED"); }
  },
};

const identitySchema = z.object({
  pid: z.number().int().positive(), parent: z.number().int().nonnegative(),
  started: z.string().min(1), command: z.string().min(1),
  state: z.string().min(1).optional(),
}).strict();
const journalSchema = z.object({ version: z.literal(1), root: identitySchema, children: z.array(identitySchema) }).strict();

async function ownedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== resolve(path)) throw new RuntimeError("PROCESS_JOURNAL_UNSAFE");
}

function processKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.started}:${identity.command}`;
}
async function writeJournal(path: string, root: ProcessIdentity, children: ProcessIdentity[]): Promise<void> {
  const staging = `${path}.next`;
  await writeFile(staging, JSON.stringify({ version: 1, root, children }), { mode: 0o600, flush: true });
  await rename(staging, path);
}
function parentsFirst(identities: ProcessIdentity[]): ProcessIdentity[] {
  const byPid = new Map(identities.map((identity) => [identity.pid, identity]));
  const depth = (identity: ProcessIdentity): number => {
    const seen = new Set<number>();
    let parent = byPid.get(identity.parent);
    while (parent && !seen.has(parent.pid)) {
      seen.add(parent.pid); parent = byPid.get(parent.parent);
    }
    return seen.size;
  };
  return [...identities].sort((left, right) => depth(left) - depth(right));
}
export async function terminateOwned(
  identities: ProcessIdentity[], access: ProcessAccess = nativeProcesses, timeoutMs = 3_000,
  persist?: (identities: ProcessIdentity[]) => Promise<void>,
): Promise<void> {
  const owned = new Map(identities.map((identity) => [processKey(identity), identity]));
  const stopRequested = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  async function observe(): Promise<ProcessIdentity[]> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RuntimeError("OWNED_PROCESS_STILL_ALIVE");
    const snapshot = await bounded(access.snapshot(), remaining, "OWNED_PROCESS_STILL_ALIVE");
    let changed = false;
    for (const anchor of [...owned.values()]) {
      for (const child of descendants(anchor, snapshot)) {
        if (!owned.has(processKey(child))) {
          owned.set(processKey(child), child); changed = true;
        }
      }
    }
    // Persist newly adopted children before killing a parent that could orphan them.
    if (changed && persist) await persist([...owned.values()]);
    return snapshot.filter((entry) => owned.has(processKey(entry)));
  }
  const quiesced = (identity: ProcessIdentity): boolean =>
    identity.state?.startsWith("T") === true ||
    (identity.state === undefined && stopRequested.has(processKey(identity)));
  let emptySnapshots = 0;
  for (;;) {
    const live = await observe();
    if (!live.length) {
      if (++emptySnapshots === 2) return;
      continue;
    }
    emptySnapshots = 0;
    if (Date.now() >= deadline) throw new RuntimeError("OWNED_PROCESS_STILL_ALIVE");
    // Freeze roots and parents first; otherwise a live parent can replace a killed child.
    for (const identity of parentsFirst(live)) {
      const current = (await observe()).find((entry) => sameProcess(entry, identity));
      if (current && !quiesced(current)) {
        access.signal(current.pid, "SIGSTOP");
        stopRequested.add(processKey(current));
      }
    }
    const frozen = await observe();
    if (frozen.some((identity) => !quiesced(identity))) { await delay(5); continue; }
    for (const identity of parentsFirst(frozen).reverse()) {
      const current = await observe();
      if (current.some((entry) => !quiesced(entry))) break;
      const verified = current.find((entry) => sameProcess(entry, identity));
      if (verified) access.signal(verified.pid, "SIGKILL");
    }
    await delay(5);
  }
}

/** Call after the single-instance lock, before recovering queued work. */
export async function recoverOwnedProcesses(dataPath: string, access = nativeProcesses): Promise<void> {
  const directory = join(dataPath, "processes");
  await ownedDirectory(directory);
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(directory, name);
    if (await realpath(path) !== path) throw new RuntimeError("PROCESS_JOURNAL_UNSAFE");
    const parsed = journalSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) throw new RuntimeError("PROCESS_JOURNAL_INVALID");
    const snapshot = await access.snapshot();
    const { root, children } = parsed.data;
    await terminateOwned([...children, ...descendants(root, snapshot), root], access, 3_000,
      (owned) => writeJournal(path, root, owned.filter((entry) => !sameProcess(entry, root))));
    await unlink(path);
  }
}

let spawnQueue = Promise.resolve();
export type ProcessFailure = "RUNTIME_PROCESS_EXITED" | "PROCESS_OBSERVATION_FAILED";
export class ProcessSupervisor {
  private root: ProcessIdentity | undefined;
  private readonly children = new Map<string, ProcessIdentity>();
  private timer: NodeJS.Timeout | undefined;
  private observation: Promise<void> = Promise.resolve();
  private fault = false;
  private closing: Promise<void> | undefined;
  private observing = false;
  private readonly failureHandlers = new Set<(code: ProcessFailure) => void>();
  private failureReported = false;
  private readonly path: string;
  private readonly cliPath: string;
  private readonly diagnostics: DiagnosticSink;
  private readonly access: ProcessAccess;
  constructor(
    dataPath: string, cliPath: string, diagnostics: DiagnosticSink, access: ProcessAccess = nativeProcesses,
  ) {
    this.path = join(dataPath, "processes", `${randomUUID()}.json`);
    this.cliPath = cliPath; this.diagnostics = diagnostics; this.access = access;
  }
  onFailure(handler: (code: ProcessFailure) => void): () => void {
    this.failureHandlers.add(handler);
    return () => { this.failureHandlers.delete(handler); };
  }
  private fail(code: ProcessFailure): void {
    if (this.closing || this.failureReported) return;
    this.failureReported = true;
    for (const handler of this.failureHandlers) {
      try { handler(code); } catch { this.diagnostics.record("PROCESS_FAILURE_HANDLER_FAILED"); }
    }
  }

  async start(startClient: () => Promise<void>): Promise<void> {
    // SDK does not expose its child handle. Serialize only spawn/identity acquisition,
    // not turns, so simultaneous conversations cannot claim one another's process.
    let unlock!: () => void;
    const previous = spawnQueue;
    spawnQueue = new Promise<void>((done) => { unlock = done; });
    await previous;
    try {
      await ownedDirectory(dirname(this.path));
      const before = await this.access.snapshot();
      if (this.closing) throw new RuntimeError("RUNTIME_START_CANCELLED");
      const starting = startClient();
      void starting.catch(() => undefined);
      try {
        const deadline = Date.now() + 5_000;
        while (!this.root) {
          const snapshot = await this.access.snapshot();
          const candidates = snapshot.filter((entry) => entry.parent === process.pid && entry.command === this.cliPath &&
            !before.some((old) => sameProcess(entry, old)));
          if (candidates.length > 1) throw new RuntimeError("RUNTIME_IDENTITY_AMBIGUOUS");
          this.root = candidates[0];
          if (!this.root && this.closing) throw new RuntimeError("RUNTIME_START_CANCELLED");
          if (!this.root && Date.now() >= deadline) throw new RuntimeError("RUNTIME_IDENTITY_MISSING");
          if (!this.root) await delay(25);
        }
        this.observation = this.observe();
        await this.observation;
        if (this.closing) throw new RuntimeError("RUNTIME_START_CANCELLED");
        this.timer = setInterval(() => {
          if (this.observing) return;
          this.observing = true;
          this.observation = this.observe().catch(() => {
            this.fault = true; this.diagnostics.record("PROCESS_OBSERVATION_FAILED");
            this.fail("PROCESS_OBSERVATION_FAILED");
          }).finally(() => { this.observing = false; });
        }, 150);
        this.timer.unref();
      } finally { unlock(); }
      await bounded(starting, 25_000, "RUNTIME_START_TIMEOUT");
    } catch (error) { unlock(); throw error; }
  }
  private async observe(): Promise<void> {
    if (!this.root) return;
    // Retain observed descendants even after reparenting. A process-table
    // snapshot is not an OS sandbox: deliberately escaping unobserved children
    // remain a containment limit, hence detached tools are not supported.
    const snapshot = await this.access.snapshot();
    for (const anchor of [this.root, ...this.children.values()]) {
      for (const entry of descendants(anchor, snapshot)) this.children.set(processKey(entry), entry);
    }
    if (!snapshot.some((entry) => sameProcess(entry, this.root!))) this.fail("RUNTIME_PROCESS_EXITED");
    await writeJournal(this.path, this.root, [...this.children.values()]);
  }
  async hasLiveDescendants(): Promise<boolean> {
    const snapshot = await this.access.snapshot();
    return (this.root ? descendants(this.root, snapshot).length > 0 : false) ||
      [...this.children.values()].some((child) => snapshot.some((entry) => sameProcess(child, entry)));
  }
  stop(closeClient: () => Promise<unknown>): Promise<void> {
    this.closing ??= this.close(closeClient);
    return this.closing;
  }
  private async close(closeClient: () => Promise<unknown>): Promise<void> {
    clearInterval(this.timer);
    try {
      await this.observation;
      await this.observe();
      if (this.root) {
        const root = this.root;
        await terminateOwned([...this.children.values(), root], this.access, 3_000, async (owned) => {
          for (const identity of owned) {
            if (!sameProcess(identity, root)) this.children.set(processKey(identity), identity);
          }
          await writeJournal(this.path, root, [...this.children.values()]);
        });
      }
    } finally {
      await bounded(closeClient(), 3_000, "RUNTIME_TRANSPORT_CLOSE_TIMEOUT");
    }
    if (this.fault) throw new RuntimeError("PROCESS_OBSERVATION_FAILED");
    if (this.root) {
      await unlink(this.path);
      this.root = undefined;
    }
  }
}
