import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { bounded, CLI_VERSION, GateError, safeError, SDK_VERSION } from "./contracts.js";

export type ProcessIdentity = { pid: number; parent: number; started: string; command: string; state: string };

export function processes(): ProcessIdentity[] {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart=,stat=,comm="], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
  return parseProcessList(output);
}

export function parseProcessList(output: string): ProcessIdentity[] {
  return output.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const match = /^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) throw new GateError("PROCESS_LIST_PARSE_FAILED");
    if (match[4]?.startsWith("Z")) return [];
    return [{
      pid: Number(match[1]), parent: Number(match[2]),
      started: match[3]!, command: match[5]!, state: match[4]!,
    }];
  });
}

export function sameProcess(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.started === right.started && left.command === right.command;
}

export function descendants(root: ProcessIdentity, snapshot: ProcessIdentity[]): ProcessIdentity[] {
  if (!snapshot.some((current) => sameProcess(root, current))) return [];
  const result: ProcessIdentity[] = [];
  const parents = new Set([root.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of snapshot) {
      if (parents.has(candidate.parent) && !parents.has(candidate.pid)) {
        result.push(candidate);
        parents.add(candidate.pid);
        changed = true;
      }
    }
  }
  return result;
}

export function signalOwned(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  if (!processes().some((current) => sameProcess(identity, current))) return;
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new GateError("PROCESS_SIGNAL_FAILED");
  }
}

export function pinnedCli(): string {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new GateError("GATE_REQUIRES_MACOS_ARM64");
  }
  const sdkEntry = fileURLToPath(import.meta.resolve("@github/copilot-sdk"));
  const sdkManifest = JSON.parse(readFileSync(resolve(dirname(sdkEntry), "../package.json"), "utf8")) as { version: string };
  const cliPath = realpathSync(fileURLToPath(import.meta.resolve("@github/copilot-darwin-arm64")));
  const cliManifest = JSON.parse(readFileSync(join(dirname(cliPath), "package.json"), "utf8")) as { version: string };
  if (sdkManifest.version !== SDK_VERSION || cliManifest.version !== CLI_VERSION) {
    throw new GateError("PINNED_PACKAGE_VERSION_MISMATCH");
  }
  return cliPath;
}

export class IsolatedRuntime {
  readonly root: string;
  readonly workspace: string;
  readonly client: CopilotClient;
  readonly cliPath: string;
  identity: ProcessIdentity | undefined;
  private tracked = new Map<string, ProcessIdentity>();
  private monitor: NodeJS.Timeout | undefined;
  private monitorError: string | undefined;
  private readonly parentDirectory: string;
  private removed = false;
  private cleanupVerified = false;
  private closing: Promise<{ forced: boolean; issues: string[] }> | undefined;

  constructor() {
    if (shuttingDown) throw new GateError("GATE_SHUTTING_DOWN");
    this.cliPath = pinnedCli();
    const cache = resolve(".cache");
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    if (realpathSync(cache) !== cache) throw new GateError("CACHE_MUST_NOT_BE_SYMLINKED");
    this.parentDirectory = join(cache, "sdk-contract");
    mkdirSync(this.parentDirectory, { recursive: true, mode: 0o700 });
    if (realpathSync(this.parentDirectory) !== this.parentDirectory) {
      throw new GateError("CACHE_MUST_NOT_BE_SYMLINKED");
    }
    this.root = join(this.parentDirectory, randomUUID());
    this.workspace = join(this.root, "workspace");
    try {
      for (const path of [this.workspace, join(this.root, "home"), join(this.root, "scratch"), join(this.root, "copilot")]) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
      }
      const token = process.env.COPILOT_GITHUB_TOKEN;
      this.client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
          path: this.cliPath,
          args: ["--no-auto-update", "--no-custom-instructions", "--disable-builtin-mcps", "--no-remote-export", "--no-bash-env"],
        }),
        mode: "empty",
        baseDirectory: join(this.root, "copilot"),
        workingDirectory: this.workspace,
        env: {
          HOME: join(this.root, "home"),
          XDG_CONFIG_HOME: join(this.root, "home", ".config"),
          XDG_CACHE_HOME: join(this.root, "home", ".cache"),
          TMPDIR: join(this.root, "scratch"),
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          LANG: "en_US.UTF-8",
        },
        ...(token ? { gitHubToken: token } : {}),
        useLoggedInUser: false,
        logLevel: "none",
      });
    } catch (error) {
      if (existsSync(this.root)) rmSync(this.root, { recursive: true });
      throw error;
    }
    ownedRuntimes.add(this);
  }

  async start(): Promise<void> {
    if (this.closing || this.identity || this.removed) throw new GateError("RUNTIME_ALREADY_USED");
    this.monitor = setInterval(() => {
      try {
        this.observeProcesses();
      } catch (error) {
        this.monitorError = safeError(error);
      }
    }, 200);
    this.monitor.unref();
    try {
      await bounded(this.client.start(), 25_000, "RUNTIME_START_TIMEOUT");
    } finally {
      this.observeProcesses();
    }
    if (!this.identity) throw new GateError("RUNTIME_IDENTITY_NOT_VERIFIED");
  }

  private observeProcesses(): void {
    const snapshot = processes();
    if (!this.identity) {
      const candidates = snapshot.filter((p) =>
        p.parent === process.pid && p.command === this.cliPath && !activePids.has(p.pid));
      if (candidates.length > 1) throw new GateError("AMBIGUOUS_RUNTIME_IDENTITY");
      if (candidates.length === 1) {
        this.identity = candidates[0]!;
        activePids.add(this.identity.pid);
      }
    }
    if (this.identity) {
      const liveRoot = snapshot.some((current) => sameProcess(this.identity!, current));
      if (liveRoot) {
        for (const child of descendants(this.identity, snapshot)) {
          this.tracked.set(`${child.pid}:${child.started}:${child.command}`, child);
        }
      }
    }
  }

  stop(force = false): Promise<{ forced: boolean; issues: string[] }> {
    this.closing ??= this.close(force);
    return this.closing;
  }

  private async close(force: boolean): Promise<{ forced: boolean; issues: string[] }> {
    const issues: string[] = [];
    clearInterval(this.monitor);
    let forced = force;
    try {
      this.observeProcesses();
    } catch (error) {
      issues.push(safeError(error));
    }
    try {
      if (!force) {
        const errors = await bounded(this.client.stop(), 8_000, "RUNTIME_STOP_TIMEOUT");
        if (errors.length) issues.push("SDK_STOP_REPORTED_ERRORS");
      }
    } catch (error) {
      issues.push(safeError(error));
    }
    let owned: ProcessIdentity[] = [];
    try {
      this.observeProcesses();
      owned = [...this.tracked.values()].reverse().concat(this.identity ?? []);
      const snapshot = processes();
      forced ||= owned.some((identity) => snapshot.some((current) => sameProcess(identity, current)));
      for (const identity of owned) signalOwned(identity, "SIGKILL");
    } catch (error) {
      issues.push(safeError(error));
    }
    // Always close the SDK-owned child handle, including when OS inspection failed.
    try {
      await bounded(this.client.forceStop(), 2_000, "TRANSPORT_CLOSE_TIMEOUT");
    } catch (error) {
      issues.push(safeError(error));
    }
    try {
      // OS exit/reaping is not implied by either the signal or SDK forceStop acknowledgement.
      const deadline = Date.now() + 3_000;
      for (;;) {
        const live = processes();
        if (!owned.some((identity) => live.some((current) => sameProcess(identity, current)))) break;
        if (Date.now() >= deadline) throw new GateError("OWNED_PROCESS_SURVIVED_CLEANUP");
        await delay(50);
      }
      if (this.identity) activePids.delete(this.identity.pid);
      this.identity = undefined;
      this.cleanupVerified = issues.length === 0;
    } catch (error) {
      issues.push(safeError(error));
    }
    if (this.monitorError) issues.push(`PROCESS_OBSERVATION_FAILED:${this.monitorError}`);
    return { forced, issues };
  }

  async freezeAndVerify(): Promise<void> {
    if (!this.identity) throw new GateError("RUNTIME_IDENTITY_NOT_VERIFIED");
    signalOwned(this.identity, "SIGSTOP");
    await delay(100);
    const frozen = processes().find((current) => sameProcess(this.identity!, current));
    if (!frozen?.state.includes("T")) throw new GateError("RUNTIME_FREEZE_NOT_OBSERVED");
    try {
      await bounded(this.client.ping("frozen-probe"), 300, "FROZEN_PING_TIMEOUT");
    } catch (error) {
      if (safeError(error) === "FROZEN_PING_TIMEOUT") return;
      throw error;
    }
    throw new GateError("FROZEN_RUNTIME_UNEXPECTEDLY_RESPONDED");
  }

  removeOwnedFiles(): void {
    if (this.removed) return;
    if (this.identity || !this.cleanupVerified) throw new GateError("REFUSING_CLEANUP_WITH_UNVERIFIED_RUNTIME");
    if (dirname(realpathSync(this.root)) !== this.parentDirectory ||
        realpathSync(this.root) !== this.root) {
      throw new GateError("REFUSING_UNOWNED_PATH_CLEANUP");
    }
    rmSync(this.root, { recursive: true });
    this.removed = true;
    ownedRuntimes.delete(this);
    if (existsSync(this.root)) throw new GateError("RUNTIME_FILES_SURVIVED_CLEANUP");
  }
}

export async function isolatedStopSmoke(neighbor: IsolatedRuntime): Promise<string> {
  const victim = new IsolatedRuntime();
  const neighborIdentity = neighbor.identity;
  let cleanupIssue = false;
  try {
    await victim.start();
    if (!neighborIdentity || victim.identity?.pid === neighborIdentity.pid) {
      throw new GateError("RUNTIMES_NOT_DISTINCT");
    }
    await victim.freezeAndVerify();
    const stopped = await victim.stop(true);
    cleanupIssue = stopped.issues.length !== 0;
    if (cleanupIssue) throw new GateError("FROZEN_RUNTIME_CLEANUP_ERROR");
    if (!processes().some((current) => sameProcess(neighborIdentity, current))) {
      throw new GateError("NEIGHBOR_RUNTIME_EXITED");
    }
    await bounded(neighbor.client.ping("neighbor-survived"), 5_000, "NEIGHBOR_UNRESPONSIVE");
    return "FROZEN_RUNTIME_EXIT_VERIFIED; DISTINCT_NEIGHBOR_PID_ALIVE_AND_PING_RESPONSIVE; NO_MODEL_SESSIONS";
  } finally {
    const stopped = await victim.stop(true);
    victim.removeOwnedFiles();
    if (stopped.issues.length && !cleanupIssue) {
      throw new GateError("ISOLATION_PROBE_CLEANUP_ERROR");
    }
  }
}

const activePids = new Set<number>();
const ownedRuntimes = new Set<IsolatedRuntime>();
let shuttingDown = false;

export async function emergencyCleanup(): Promise<string[]> {
  shuttingDown = true;
  const errors: string[] = [];
  for (const runtime of [...ownedRuntimes]) {
    try {
      const result = await runtime.stop(true);
      errors.push(...result.issues);
      runtime.removeOwnedFiles();
    } catch (error) {
      errors.push(safeError(error));
    }
  }
  return errors;
}
