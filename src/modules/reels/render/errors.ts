import { ModuleError } from "../../core-api.js";

export const REELS_RENDER_FAILURES = ["REELS_CUT_INVALID", "REELS_TARGET_EXISTS", "REELS_DISK_FULL", "REELS_ABORTED",
  "REELS_TIMEOUT", "REELS_TOOLS_MISSING", "REELS_OVERLAY_FAILED", "REELS_RENDER_FAILED", "REELS_OUTPUT_INVALID"] as const;
export type ReelsRenderFailure = typeof REELS_RENDER_FAILURES[number];

/** A fixed code only; never a path or content. `errorCode(error, …)` from core-api reads it. */
export class ReelsRenderError extends ModuleError {
  readonly reason: ReelsRenderFailure;
  constructor(reason: ReelsRenderFailure) {
    super(reason);
    this.name = "ReelsRenderError";
    this.reason = reason;
  }
}
