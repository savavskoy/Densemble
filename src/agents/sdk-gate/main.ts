import { bounded, CLI_VERSION, completeChecks, parseGateArgs, safeError, SDK_VERSION, summarize } from "./contracts.js";
import type { AuthMode, Check, Observation } from "./contracts.js";
import { emergencyCleanup, IsolatedRuntime } from "./runtime.js";
import { runBehavior } from "./behavior.js";
import type { BehaviorSummary } from "./behavior.js";
import type { ModelInfo } from "@github/copilot-sdk";

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
let behavior: BehaviorSummary | undefined;
let suppressedSdkDiagnostics = 0;
const originalError = console.error;
const originalWarn = console.warn;
console.error = console.warn = () => { suppressedSdkDiagnostics++; };
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
const watchdog = setTimeout(() => { void interrupt(1); }, readinessOnly ? 180_000 : 20 * 60_000);
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
    let models: ModelInfo[] = [];
    try {
      models = await bounded(runtime.client.listModels(), 15_000, "MODEL_LIST_TIMEOUT");
      modelCount = models.length;
      checks.push({
        contract: "model-discovery", status: models.length ? "PASS" : "BLOCKED",
        evidence: `REAL_MODEL_COUNT=${models.length}`,
      });
    } catch (error) {
      checks.push({ contract: "model-discovery", status: "BLOCKED", evidence: safeError(error) });
    }
    blockedBy = auth.isAuthenticated ? "BEHAVIOR_NOT_REQUESTED_OR_NOT_COMPLETED" : "AUTHENTICATION_REQUIRED";
    if (!readinessOnly && auth.isAuthenticated && models.length && status.version === CLI_VERSION) {
      behavior = await runBehavior(runtime, authMode, models, checks, observations);
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
console.error = originalError;
console.warn = originalWarn;
const complete = completeChecks(checks, real && !readinessOnly ? "BLOCKED" : "SKIPPED", blockedBy);
const status = argumentError || finalCleanup.length || observations.some((o) => o.status === "FAIL") ? "FAIL" : summarize(complete);
if (!interrupted) {
  console.log(JSON.stringify({
    status, sdk: SDK_VERSION, cli: CLI_VERSION,
    scope: readinessOnly ? "READINESS_ONLY_ZERO_INFERENCE" : real ? "AUTHENTICATED_SYNTHETIC_BEHAVIOR" : "OFFLINE",
    authMode,
    readiness: { isAuthenticated, modelCount },
    modelRequests: behavior?.submittedMessages ?? 0,
    behavior,
    suppressedSdkDiagnostics,
    provisioning: "Choose --auth=token with externally supplied COPILOT_GITHUB_TOKEN, --auth=logged-in for empty-mode gh discovery, --auth=cli-login for transient CLI-mode stored-login discovery, or --auth=service-login for a manually provisioned runtime/copilot service home (never removed by gate cleanup). No login or credential migration is performed.",
    checks: complete, observations,
  }, null, 2));
  process.exitCode = status === "PASS" ? 0 : status === "FAIL" ? 1 : 2;
}
