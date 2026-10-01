import type { ServiceConfig } from "../config/index.js";
import type { AudioSettings } from "../media/index.js";

export function audioSettings(config: ServiceConfig): AudioSettings {
  const settings: AudioSettings = {};
  for (const key of ["ffmpegPath", "ffprobePath", "whisperPath", "modelPath", "language"] as const) {
    const value = config.audio?.[key];
    if (value !== undefined) settings[key] = value;
  }
  for (const key of ["threads", "probeTimeoutMs", "decodeTimeoutMs", "asrTimeoutMs"] as const) {
    const value = config.audio?.[key];
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}
