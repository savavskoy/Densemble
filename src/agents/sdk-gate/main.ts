import { bounded, CLI_VERSION, completeChecks, parseGateArgs, safeError, SDK_VERSION, summarize } from "./contracts.js";
import type { AuthMode, Check, Observation } from "./contracts.js";
import { emergencyCleanup, IsolatedRuntime, isolatedStopSmoke } from "./runtime.js";

const checks: Check[] = [];
const observations: Observation[] = [];
let real = false;
let readinessOnly = false;
let authMode: AuthMode = "token";
let isAuthenticated: boolean | null = null;
let modelCount: number | null = null;
let runtime: IsolatedRuntime | undefined;
let blockedBy = "REAL_PROBES_NOT_ENABLED";
let argumentError = false;
try {
  ({ real, readinessOnly, authMode } = parseGateArgs(process.argv.slice(2)));
} catch (error) {
  blockedBy = safeError(error);
  argumentError = true;
}

let interrupted = false;
async function interrupt(code: number): Promise<void> {
  if (interrupted) return;
  interrupted = true;
  const errors = await emergencyCleanup();
  console.log(JSON.stringify({ status: "FAIL", reason: "GATE_INTERRUPTED", cleanupErrors: errors }));
  process.exit(code);
}
const onInterrupt = (): void => { void interrupt(130); };
const onTerminate = (): void => { void interrupt(143); };
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
const watchdog = setTimeout(() => { void interrupt(1); }, 180_000);
watchdog.unref();

if (argumentError) {
  // Invalid flags never launch a runtime.
} else if (process.versions.node.split(".")[0] !== "24") {
  blockedBy = "NODE_24_REQUIRED";
} else if (real) {
  try {
    runtime = new IsolatedRuntime(authMode);
    await runtime.start();
    const status = await bounded(runtime.client.getStatus(), 10_000, "STATUS_TIMEOUT");
    checks.push({
      contract: "runtime-version",
      status: status.version === CLI_VERSION ? "PASS" : "FAIL",
      evidence: `SDK=${SDK_VERSION}; runtime=${status.version === CLI_VERSION ? CLI_VERSION : "MISMATCH"}; protocol=${status.protocolVersion}`,
    });
    const auth = await bounded(runtime.client.getAuthStatus(), 10_000, "AUTH_TIMEOUT");
    isAuthenticated = auth.isAuthenticated;
    checks.push({
      contract: "authentication", status: auth.isAuthenticated ? "PASS" : "BLOCKED",
      evidence: `AUTH_MODE=${authMode}; IS_AUTHENTICATED=${isAuthenticated}`,
    });
    // Attempt the actual RPC even when auth says false; do not infer model availability.
    try {
      const models = await bounded(runtime.client.listModels(), 15_000, "MODEL_LIST_TIMEOUT");
      modelCount = models.length;
      checks.push({
        contract: "model-discovery", status: models.length ? "PASS" : "BLOCKED",
        evidence: `REAL_MODEL_COUNT=${models.length}`,
      });
    } catch (error) {
      checks.push({ contract: "model-discovery", status: "BLOCKED", evidence: safeError(error) });
    }
    blockedBy = auth.isAuthenticated ? "AUTHENTICATED_BEHAVIOR_PROBES_NOT_IMPLEMENTED" : "AUTHENTICATION_REQUIRED";
    if (!readinessOnly) {
      try {
        const evidence = await isolatedStopSmoke(runtime);
        observations.push({ name: "two-runtime-forced-stop", status: "PASS", evidence });
        checks.push({
          contract: "process-isolation", status: "BLOCKED",
          evidence: "TWO_RUNTIME_SMOKE_PASSED; ACTIVE_CHAT_AND_RUNTIME_TOOL_TREE_NOT_TESTED",
        });
      } catch (error) {
        observations.push({ name: "two-runtime-forced-stop", status: "FAIL", evidence: safeError(error) });
        checks.push({ contract: "process-isolation", status: "FAIL", evidence: safeError(error) });
      }
    }
  } catch (error) {
    blockedBy = safeError(error);
    observations.push({ name: "readiness-rpc", status: "BLOCKED", evidence: blockedBy });
  } finally {
    if (runtime) {
      try {
        const stopped = await runtime.stop();
        runtime.removeOwnedFiles();
        checks.push({
          contract: "cleanup", status: stopped.issues.length ? "FAIL" : "PASS",
          evidence: stopped.issues.length ? stopped.issues.join(";") :
            `OBSERVED_OWNED_PROCESSES_EXITED_AND_FILES_REMOVED; forced=${stopped.forced}`,
        });
      } catch (error) {
        checks.push({ contract: "cleanup", status: "FAIL", evidence: safeError(error) });
      }
    }
  }
}

const finalCleanup = await emergencyCleanup();
if (finalCleanup.length) {
  observations.push({ name: "final-cleanup", status: "FAIL", evidence: finalCleanup.join(";") });
}
clearTimeout(watchdog);
process.removeListener("SIGINT", onInterrupt);
process.removeListener("SIGTERM", onTerminate);
const complete = completeChecks(checks, real && !readinessOnly ? "BLOCKED" : "SKIPPED", blockedBy);
const status = argumentError || finalCleanup.length ? "FAIL" : summarize(complete);
if (!interrupted) {
  console.log(JSON.stringify({
    status, sdk: SDK_VERSION, cli: CLI_VERSION,
    scope: "READINESS_AND_AUTH_INDEPENDENT_PROCESS_SMOKE_ONLY",
    authMode,
    readiness: { isAuthenticated, modelCount },
    modelRequests: 0,
    provisioning: "Choose --auth=token with externally supplied COPILOT_GITHUB_TOKEN, --auth=logged-in for empty-mode gh discovery, or --auth=cli-login for CLI-mode stored-login discovery. No login or credential migration is performed.",
    checks: complete, observations,
  }, null, 2));
  process.exitCode = status === "PASS" ? 0 : status === "FAIL" ? 1 : 2;
}
