/** Reel rendering (spec 006, US3): validation, word snapping, overlays and FFmpeg; no module state. */
export { MAX_REEL_SECONDS, MAX_REELS, MIN_REEL_SECONDS, parseTimecode, titleValid, validateCuts,
  type CutIssue, type CutIssueCode, type ReelCut } from "./cuts.js";
export { REELS_RENDER_FAILURES, ReelsRenderError, type ReelsRenderFailure } from "./errors.js";
export { reelFileName, transliterate } from "./name.js";
export { MAX_REEL_BYTES, renderReel, scratchDirectory, videoBitrate, type RenderRequest } from "./render.js";
export { snapToWords, type SnappedCut } from "./snap.js";
export { cleanWords, wordsFromPhrases, type ReelWord, type TimedWord, type TranscriptPhrase } from "./words.js";
