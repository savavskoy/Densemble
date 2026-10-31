import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { defaultQuietHours, type LoadedConfig } from "../config/index.js";
import type { SpeechGate } from "../media/speech-gate.js";
import type { CoreOffer } from "./contract.js";

/** What the core offers modules, from the loaded configuration; tool defaults match voice transcription. */
export function createCoreOffer(loaded: LoadedConfig, speechGate: SpeechGate): CoreOffer {
  const config = loaded.config;
  const configDirectory = loaded.paths ? dirname(loaded.paths.configFile) : undefined;
  return {
    speechGate,
    audio: {
      ffmpegPath: config.audio?.ffmpegPath ?? "ffmpeg",
      ffprobePath: config.audio?.ffprobePath ?? "ffprobe",
      whisperPath: config.audio?.whisperPath ?? "whisper-cli",
      vocabulary: [...config.audio?.vocabulary ?? []],
    },
    ownerWorkspaces: [config.workspacePath, ...(config.workspaces ?? [])
      .filter((workspace) => workspace.ownerUserId === config.ownerId).map((workspace) => workspace.path)],
    managedRoots: [
      ...(loaded.paths ? [loaded.paths.codeRoot, loaded.paths.configFile] : []),
      config.runtimeDataPath, config.runtimeHomePath, config.interactiveHomePath ?? resolve(homedir(), ".copilot"),
      ...(config.claudeCode ? [config.claudeCode.homePath] : []),
      config.secretsPath,
    ],
    resolveFromConfig: (path) => configDirectory === undefined ? resolve(path) : resolve(configDirectory, path),
    quietHours: config.quietHours ?? { ...defaultQuietHours },
  };
}
