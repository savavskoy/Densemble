import { CopilotClient } from "@github/copilot-sdk";
import { mkdir } from "node:fs/promises";
import type { LoadedConfig } from "../config/index.js";
import { checkedPath } from "../config/paths.js";
import { pinnedRuntimePath, serviceClientOptions } from "../agents/copilot.js";
import { checkAudioReadiness } from "../media/index.js";
import { bounded } from "../agents/contracts.js";
import { audioSettings } from "./audio-settings.js";

export interface DoctorReport {
  ready: boolean;
  checks: { component: string; ready: boolean; code: string; count?: number }[];
}

export async function doctor(config: LoadedConfig): Promise<DoctorReport> {
  const checks: DoctorReport["checks"] = [];
  let client: CopilotClient | undefined;
  try {
    const options = serviceClientOptions(config, await pinnedRuntimePath());
    if (options.env?.TMPDIR) {
      await mkdir(options.env.TMPDIR, { recursive: true, mode: 0o700 });
      checkedPath(options.env.TMPDIR, "directory");
    }
    client = new CopilotClient(options);
    await bounded(client.start(), 25_000, "DOCTOR_RUNTIME_TIMEOUT");
    const [status, auth] = await Promise.all([
      bounded(client.getStatus(), 10_000, "DOCTOR_STATUS_TIMEOUT"),
      bounded(client.getAuthStatus(), 10_000, "DOCTOR_AUTH_TIMEOUT"),
    ]);
    checks.push({ component: "runtime", ready: status.version === "1.0.91", code: status.version === "1.0.91" ? "RUNTIME_READY" : "RUNTIME_VERSION_MISMATCH" });
    checks.push({ component: "authentication", ready: auth.isAuthenticated, code: auth.isAuthenticated ? "AUTHENTICATED" : "SERVICE_LOGIN_REQUIRED" });
    if (auth.isAuthenticated) {
      const models = await bounded(client.listModels(), 15_000, "DOCTOR_MODELS_TIMEOUT");
      const available = new Set(models.map((model) => model.id));
      const missing = config.agents.filter((agent) => !available.has(agent.defaultModel));
      checks.push({ component: "models", ready: missing.length === 0,
        code: missing.length ? "AGENT_MODEL_UNAVAILABLE" : "MODELS_READY", count: models.length });
    }
  } catch {
    checks.push({ component: "runtime", ready: false, code: "RUNTIME_DIAGNOSTIC_FAILED" });
  } finally {
    if (client) {
      try {
        const errors = await bounded(client.stop(), 8_000, "DOCTOR_STOP_TIMEOUT");
        if (errors.length) throw new Error("DOCTOR_STOP_FAILED");
      } catch {
        checks.push({ component: "runtime-cleanup", ready: false, code: "DOCTOR_FORCED_STOP" });
      } finally {
        await bounded(client.forceStop(), 3_000, "DOCTOR_FORCE_STOP_FAILED");
      }
    }
  }
  for (const bot of config.config.bots) {
    try {
      const { Api } = await import("grammy");
      const api = new Api(config.tokenForBot(bot.id), { timeoutSeconds: 10, sensitiveLogs: false });
      const [identity, webhook] = await Promise.all([api.getMe(), api.getWebhookInfo()]);
      const correct = identity.id === Number(config.tokenForBot(bot.id).split(":")[0]);
      checks.push({ component: `bot:${bot.id}`, ready: correct && !webhook.url,
        code: !correct ? "BOT_IDENTITY_MISMATCH" : webhook.url ? "WEBHOOK_CONFLICT" : "BOT_READY" });
    } catch {
      checks.push({ component: `bot:${bot.id}`, ready: false, code: "BOT_DIAGNOSTIC_FAILED" });
    }
  }
  const audio = await checkAudioReadiness(audioSettings(config.config));
  checks.push({ component: "audio", ready: audio.ready, code: audio.code });
  checks.push({ component: "mcp", ready: config.config.mcp.mode === "none",
    code: config.config.mcp.mode === "none" ? "MCP_EXPLICITLY_DISABLED" : "MCP_REQUIRES_TOOL_ACCEPTANCE" });
  return { ready: checks.every((check) => check.ready), checks };
}
