import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/index.js";
import { checkedPath, isWithin } from "./config/paths.js";
import { parseArguments } from "./operations/arguments.js";
import { createDiagnostics } from "./operations/diagnostics.js";

const diagnostics = createDiagnostics();
const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (!existsSync(args.config)) {
    process.stderr.write("Densemble is not configured. Create a private config.local.json from config.example.json; credentials stay in your external secrets.local.json.\n");
    process.exitCode = 1;
    return;
  }
  if (process.versions.node.split(".")[0] !== "24") throw new Error("NODE_24_REQUIRED");
  const config = loadConfig(args.config, { codeRoot });
  if (args.target) {
    const target = resolve(args.target);
    const parent = checkedPath(dirname(target), "directory");
    if (isWithin(codeRoot, parent)) throw new Error("BACKUP_OUTSIDE_CODE_REQUIRED");
  }
  if (args.command === "launchd") {
    const { launchdTemplate } = await import("./operations/launchd.js");
    const logs = join(config.config.runtimeDataPath, "logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    checkedPath(logs, "directory");
    process.stdout.write(launchdTemplate({
      node: process.execPath, codeRoot, config: resolve(args.config), logs,
    }));
    return;
  }
  if (args.command === "start") {
    const { startService } = await import("./service.js");
    let stopping = false;
    let service: Awaited<ReturnType<typeof startService>> | undefined;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void service?.stop().catch(() => {
        diagnostics.record("SERVICE_SHUTDOWN_FAILED");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      service = await startService(config);
      if (stopping) await service.stop();
    } catch (error) {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      throw error;
    }
    return;
  }
  const { acquireProcessLock } = await import("./storage/process-lock.js");
  const lock = acquireProcessLock(config.config.runtimeDataPath);
  try {
    const { createCopilotRuntime } = await import("./agents/index.js");
    const runtime = createCopilotRuntime({ config, diagnostics });
    try { await runtime.recoverOwnedProcesses(); } finally { await runtime.shutdown(); }
    if (args.command === "doctor") {
      const { doctor } = await import("./operations/doctor.js");
      const report = await doctor(config);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = report.ready ? 0 : 2;
    } else if (args.command === "restore") {
      const { restoreService } = await import("./operations/backup.js");
      restoreService(config.config, args.target!);
      diagnostics.record("RESTORE_COMPLETE");
    } else {
      const { openStore } = await import("./storage/index.js");
      const { backupService } = await import("./operations/backup.js");
      const store = openStore({ path: join(config.config.runtimeDataPath, "state.sqlite") });
      try { await backupService(config.config, store, args.target!); } finally { store.close(); }
      diagnostics.record("BACKUP_COMPLETE");
    }
  } finally { lock.release(); }
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.message)
    ? error.message : "SERVICE_OPERATION_FAILED";
  diagnostics.record(code);
  process.exitCode = 1;
});
