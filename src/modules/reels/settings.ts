import { join } from "node:path";
import { z } from "zod";
import { assertDisjoint, isWithin, type CoreOffer, type PrepareResult } from "../core-api.js";

/** Plan D9: videos up to 3 hours. */
export const REELS_DEFAULTS = Object.freeze({ ytDlpPath: "/opt/homebrew/bin/yt-dlp", maxVideoMinutes: 180, maxHeight: 1080 });

const nonempty = z.string().trim().min(1);

/** `modules.reels.settings`; every field is optional. */
export const reelsSchema = z.object({
  /** Folder of prepared videos and their reels; default `<owner workspace>/raw/reels`. */
  folder: nonempty.optional(),
  ytDlpPath: nonempty.optional(),
  maxVideoMinutes: z.number().int().min(1).max(180).optional(),
  maxHeight: z.union([z.literal(720), z.literal(1080), z.literal(1440), z.literal(2160)]).optional(),
}).strict();
export type ReelsConfig = z.infer<typeof reelsSchema>;

export interface ReelsSettings {
  /** Absolute; inside `workspace`. */
  folder: string;
  /** The owner workspace that holds `folder` (FR-020). */
  workspace: string;
  ytDlpPath: string;
  maxVideoSeconds: number;
  maxHeight: number;
  ffmpegPath: string;
  ffprobePath: string;
}

/**
 * The folder resolves from the config file's directory, must lie inside an owner workspace and must not overlap
 * service-owned paths; it is created at start when missing.
 */
export function prepareReels(raw: ReelsConfig, core: CoreOffer): PrepareResult<ReelsConfig> {
  const folder = core.resolveFromConfig(raw.folder ?? join(core.ownerWorkspaces[0] ?? ".", "raw", "reels"));
  if (!core.ownerWorkspaces.some((root) => isWithin(root, folder))) return { ok: false, code: "REELS_FOLDER_OUTSIDE_WORKSPACE" };
  for (const managed of core.managedRoots) assertDisjoint(managed, folder);
  return { ok: true, settings: { ...raw, folder, ...(raw.ytDlpPath ? { ytDlpPath: core.resolveFromConfig(raw.ytDlpPath) } : {}) } };
}

/** Prepared settings → what the module uses. */
export function reelsSettings(raw: ReelsConfig, core: CoreOffer): ReelsSettings {
  const folder = raw.folder ?? join(core.ownerWorkspaces[0] ?? ".", "raw", "reels");
  const workspace = core.ownerWorkspaces.filter((root) => isWithin(root, folder)).sort((a, b) => b.length - a.length)[0] ?? folder;
  return {
    folder, workspace,
    ytDlpPath: raw.ytDlpPath ?? REELS_DEFAULTS.ytDlpPath,
    maxVideoSeconds: (raw.maxVideoMinutes ?? REELS_DEFAULTS.maxVideoMinutes) * 60,
    maxHeight: raw.maxHeight ?? REELS_DEFAULTS.maxHeight,
    ffmpegPath: core.audio.ffmpegPath,
    ffprobePath: core.audio.ffprobePath,
  };
}
