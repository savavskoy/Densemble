import { constants } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  checkedPath, errorCode, isWithin, ModuleError, runManagedProcess,
  type AbilityCall, type AbilityResult, type Json, type ModuleCheck, type ModuleContext, type ModuleDefinition,
  type ModuleInstance, type ProcessControl, type ProcessRunner,
} from "../core-api.js";
import { readTimedTranscript, timecode, type RecordingsApi } from "../recordings/api.js";
import { probeVideo, videoId, workspaceVideo, youtubeDownload, youtubeId, youtubeInfo, type FetchOptions, type VideoSource } from "./fetch.js";
import { createJobs, type Job } from "./jobs.js";
import {
  parseTimecode, reelFileName, renderReel, scratchDirectory, snapToWords, validateCuts, wordsFromPhrases,
  type ReelCut,
} from "./render/index.js";
import { prepareReels, reelsSchema, reelsSettings, type ReelsConfig, type ReelsSettings } from "./settings.js";
import {
  appendCuts, ensureDirectory, existingReels, listVideos, readVideo, reelsDirectory, removeDownloadedSource, sourceMedia, TRANSCRIPT_KEY, VIDEO_ID,
  videoDirectory, wordsPath, writeVideo, type CutEntry, type VideoRecord,
} from "./store.js";

const timeInput = z.union([z.string().trim().min(1).max(16), z.number().nonnegative()]);
const MAX_TRANSCRIPT_CHARS = 40_000;

const settingsFix = "Виправте modules.reels.settings.folder у config.local.json і виконайте make restart.";

/** Reels toolbox (spec 006): prepare a video, read its transcript, cut given reels, see progress. No workflow. */
export const module: ModuleDefinition<ReelsConfig> = {
  id: "reels",
  version: "1.0.0",
  requires: ["recordings"],
  settings: reelsSchema,
  abilities: [
    { name: "reels_prepare", description: "Fetch a YouTube video or take a video file from the owner's workspace and transcribe it " +
      "(timecodes, speakers) in the background; you are woken when it is ready or failed.",
    input: z.object({ source: z.string().trim().min(1).max(2_000), fresh: z.boolean().optional() }).strict() },
    { name: "reels_transcript", description: "Read a prepared video's transcript: `[HH:MM:SS] Speaker: text` lines, whole or for a time range.",
      input: z.object({ video: z.string().trim().min(1).max(40), from: timeInput.optional(), to: timeInput.optional() }).strict(),
      readOnly: true },
    { name: "reels_cut", description: "Cut exactly the given reels (start, end, title, options) from a prepared video into vertical " +
      "videos with subtitles and a title; they are sent to this chat and saved in the video's folder.",
    input: z.object({ video: z.string().trim().min(1).max(40), reels: z.array(z.object({
      start: timeInput, end: timeInput, title: z.string().max(500),
      subtitles: z.boolean().optional(), showTitle: z.boolean().optional(),
    }).strict()).min(1).max(50) }).strict() },
    { name: "reels_status", description: "Progress of reels jobs (stage, percent, time left, failures) and the prepared videos.",
      input: z.object({ video: z.string().trim().min(1).max(40).optional() }).strict(), readOnly: true },
  ],
  reasons: {
    REELS_FOLDER_OUTSIDE_WORKSPACE: { cause: "Папка рілсів лежить поза вашими робочими просторами.",
      fix: "Вкажіть у modules.reels.settings.folder папку всередині робочого простору (наприклад, <workspace>/raw/reels) і виконайте make restart." },
    REELS_FOLDER_UNAVAILABLE: { cause: "Densemble не може створити або прочитати папку рілсів.", fix: settingsFix },
    PATH_MISSING_OR_UNREADABLE: { cause: "Папку рілсів не знайдено або вона не читається.", fix: settingsFix },
    PATH_KIND_INVALID: { cause: "Шлях до папки рілсів веде не до папки.", fix: settingsFix },
    SYMLINK_PATH_REJECTED: { cause: "Шлях до папки рілсів містить символьне посилання.", fix: settingsFix },
    UNSAFE_PATH_OVERLAP: { cause: "Папка рілсів перетинається зі службовими файлами Densemble (код, дані, конфігурація, секрети).",
      fix: settingsFix },
  },
  prepare: (settings, core) => prepareReels(settings, core),
  doctor: (settings, core) => reelsDoctor(reelsSettings(settings, core)),
  start: startReels,
};

/** Doctor lines: the folder, FFmpeg and yt-dlp (missing yt-dlp only blocks links; workspace files still work). */
export async function reelsDoctor(settings: ReelsSettings): Promise<ModuleCheck[]> {
  const executable = async (path: string) => { try { await access(path, constants.X_OK); return true; } catch { return false; } };
  let folder = true;
  try { await access(settings.folder, constants.R_OK | constants.W_OK | constants.X_OK); } catch { folder = false; }
  const ytDlp = await executable(settings.ytDlpPath);
  return [
    { component: "reels-folder", ready: true, code: folder ? "REELS_FOLDER_READY" : "REELS_FOLDER_CREATED_AT_START", detail: settings.folder },
    { component: "reels-yt-dlp", ready: ytDlp, code: ytDlp ? "REELS_YTDLP_READY" : "REELS_YTDLP_MISSING", detail: settings.ytDlpPath },
  ];
}

/** Ability errors: fixed code and an English message for the agent (no paths, no content). */
const MESSAGES: Record<string, string> = {
  REELS_OWNER_ONLY: "Reels work only for the owner.",
  REELS_WORKSPACE_DENIED: "Reels work only in the owner's workspace that holds the reels folder.",
  REELS_SOURCE_INVALID: "The source is neither a YouTube link nor a video file inside the owner's workspace.",
  REELS_YTDLP_MISSING: "yt-dlp is not installed; the owner can install it with `brew install yt-dlp`. Workspace video files still work.",
  REELS_VIDEO_UNAVAILABLE: "YouTube refused the video (private, removed, age- or members-restricted).",
  REELS_FETCH_FAILED: "The video could not be downloaded.",
  REELS_VIDEO_TOO_LONG: "The video is longer than the limit (3 hours by default) and was not processed.",
  REELS_VIDEO_LIVE: "Live or upcoming streams cannot be prepared.",
  REELS_VIDEO_UNKNOWN: "No prepared video has this id; call reels_status or reels_prepare.",
  REELS_VIDEO_NOT_PREPARED: "This video is not prepared yet; wait for the ready note or check reels_status.",
  REELS_VIDEO_BUSY: "A job for this video is already queued or running; check reels_status.",
  REELS_TIME_INVALID: "A time is not HH:MM:SS, MM:SS or seconds.",
  REELS_CUTS_REJECTED: "The list was rejected before anything was cut.",
  REELS_FOLDER_UNSAFE: "A video or reels folder is a symlink or not a folder; nothing was written there.",
  REELS_SOURCE_MISSING: "The downloaded video is missing; it is downloaded again before the next cut.",
  REELS_SOURCE_CHANGED: "The workspace video file changed or disappeared since it was prepared; prepare it again with fresh: true.",
  RECORDINGS_UNAVAILABLE: "Transcription (the recordings module) is not available.",
};
const refuse = (code: string, message = MESSAGES[code] ?? "The reels module refused the request."): AbilityResult =>
  ({ ok: false, code, message });

async function startReels(ctx: ModuleContext<ReelsConfig>): Promise<ModuleInstance> {
  const settings = reelsSettings(ctx.settings, ctx.core);
  const { diagnostics, core } = ctx;
  const gate = core.speechGate;
  const runner: ProcessRunner = runManagedProcess;
  try {
    await mkdir(settings.folder, { recursive: true, mode: 0o755 });
    checkedPath(settings.folder, "directory");
  } catch { throw new ModuleError("REELS_FOLDER_UNAVAILABLE", { unavailable: true }); }
  const recordings = ctx.require<RecordingsApi>("recordings");
  const workRoot = join(ctx.dataPath, "work");
  await rm(workRoot, { recursive: true, force: true });
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  const jobs = createJobs({ dataPath: ctx.dataPath, diagnostics });
  await jobs.load();
  /** Pauses the job's processes while a voice message is recognised (spec 004 priority). */
  const pausable = () => {
    let unregister: (() => void) | undefined;
    return {
      onSpawn: (control: ProcessControl) => { unregister?.(); unregister = gate.registerBackground(control); },
      done: () => { unregister?.(); unregister = undefined; },
    };
  };

  /** Video ids between an ability's checks and its `jobs.add`, so two calls cannot both pass the busy check. */
  const reserved = new Set<string>();
  const busy = (id: string) => reserved.has(id) || jobs.active(id) !== undefined;

  const guard = (call: AbilityCall): AbilityResult | undefined => {
    if (!call.owner) return refuse("REELS_OWNER_ONLY");
    if (!isWithin(call.workspace, settings.folder)) return refuse("REELS_WORKSPACE_DENIED");
    return undefined;
  };

  async function source(raw: string, call: AbilityCall): Promise<VideoSource> {
    const id = youtubeId(raw);
    if (id) return { kind: "youtube", youtubeId: id, url: `https://www.youtube.com/watch?v=${id}` };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new ModuleError("REELS_SOURCE_INVALID");
    return workspaceVideo(raw, call.workspace);
  }

  async function prepare(args: { source: string; fresh?: boolean | undefined }, call: AbilityCall): Promise<AbilityResult> {
    let input: VideoSource;
    try { input = await source(args.source, call); }
    catch (error) { return refuse(errorCode(error, "REELS_SOURCE_INVALID")); }
    const id = videoId(input);
    if (busy(id)) {
      return { ok: true, video: id, state: "running", ...(jobs.active(id) ? { job: jobs.active(id)!.id } : {}),
        message: "Already being prepared or cut; check reels_status." };
    }
    reserved.add(id);
    try {
      const existing = await readVideo(settings.folder, id);
      if (existing && !args.fresh && await readTimedTranscript(wordsPath(settings.folder, id))) {
        return { ok: true, video: id, state: "ready", title: existing.title, durationSeconds: existing.durationSeconds,
          message: "Already prepared; read it with reels_transcript (pass fresh: true to prepare it again)." };
      }
      const job = jobs.add("prepare", id, call.scope, (current) => runPrepare(current, input));
      return { ok: true, video: id, state: "started", job: job.id,
        message: "Preparing in the background; you will get a note in this chat when it is ready or failed." };
    } finally { reserved.delete(id); }
  }

  /** Downloaded aside, then swapped in: earlier source files go only once the new one is complete (reels stay). */
  async function downloadSource(job: Job, youtubeId: string, directory: string, options: FetchOptions): Promise<string> {
    const download = join(directory, `.download-${randomUUID()}`);
    await ensureDirectory(download);
    try {
      const fetched = await youtubeDownload(youtubeId, download, settings, { ...options, onProgress: (percent) => jobs.progress(job, percent) });
      await removeDownloadedSource(directory);
      const media = join(directory, fetched.slice(download.length + 1));
      await rename(fetched, media);
      return media;
    } finally { await rm(download, { recursive: true, force: true }); }
  }

  async function runPrepare(job: Job, input: VideoSource): Promise<void> {
    const directory = videoDirectory(settings.folder, job.videoId);
    const paused = pausable();
    const options = { runner, signal: ctx.signal, onSpawn: paused.onSpawn };
    try {
      await ensureDirectory(directory);
      // Until this run succeeds the video is not "prepared": a failed fresh run never leaves a record without media.
      await rm(join(directory, "video.json"), { force: true });
      let title: string;
      let media: string;
      if (input.kind === "youtube") {
        jobs.stage(job, "fetching");
        const info = await youtubeInfo(input.youtubeId, settings, options);
        if (info.live) throw new ModuleError("REELS_VIDEO_LIVE");
        if (info.durationSeconds !== undefined && info.durationSeconds > settings.maxVideoSeconds) throw new ModuleError("REELS_VIDEO_TOO_LONG");
        title = info.title;
        media = await downloadSource(job, input.youtubeId, directory, options);
      } else {
        title = input.relativePath;
        media = input.path;
      }
      const durationSeconds = await probeVideo(media, settings, options);
      if (durationSeconds > settings.maxVideoSeconds) throw new ModuleError("REELS_VIDEO_TOO_LONG");
      jobs.stage(job, "transcribing");
      const result = await recordings.transcribeMedia({ media, outputDirectory: directory, key: TRANSCRIPT_KEY, durationSeconds,
        signal: ctx.signal, onProgress: (percent) => jobs.progress(job, percent) });
      const record: VideoRecord = { version: 1, id: job.videoId, title, durationSeconds,
        source: input.kind === "youtube" ? input : { kind: "file", relativePath: input.relativePath, size: input.size, mtimeMs: input.mtimeMs },
        media, preparedAt: new Date().toISOString(), speakers: result.speakers };
      await writeVideo(settings.folder, record);
      jobs.finish(job);
      diagnostics.record("REELS_VIDEO_PREPARED");
      const timed = await readTimedTranscript(result.words);
      // The title comes from the uploader: it stays out of the agent's turn (reels_status shows it as data).
      await ctx.chat.wake(job.scope, `Video ${job.videoId} (${timecode(durationSeconds)}) is prepared: ` +
        `${timed?.phrases.length ?? 0} phrases, speakers: ${timed?.speakers.join(", ") || "none"}` +
        `${result.speakers === "unavailable" ? " (speaker separation failed, every phrase is labelled Speaker)" : ""}. ` +
        "Read it with reels_transcript.", `prepare:${job.id}`);
    } catch (error) {
      const code = ctx.signal.aborted ? "REELS_INTERRUPTED" : errorCode(error, "REELS_PREPARE_FAILED");
      const stage = job.stage === "queued" ? "start" : job.stage;
      jobs.finish(job, code);
      diagnostics.record("REELS_PREPARE_FAILED", { code });
      if (!ctx.signal.aborted) {
        await ctx.chat.wake(job.scope, `Preparing video ${job.videoId} failed at stage ${stage}: ${code}` +
          `${MESSAGES[code] ? ` (${MESSAGES[code]})` : ""}.`, `prepare:${job.id}`);
      }
    } finally { paused.done(); }
  }

  /** Prepared video with a readable word-timed transcript, or a refusal. */
  async function prepared(id: string): Promise<{ video: VideoRecord } | { refusal: AbilityResult }> {
    if (!VIDEO_ID.test(id)) return { refusal: refuse("REELS_VIDEO_UNKNOWN") };
    const video = await readVideo(settings.folder, id);
    if (!video) return { refusal: refuse(jobs.active(id) ? "REELS_VIDEO_NOT_PREPARED" : "REELS_VIDEO_UNKNOWN") };
    return { video };
  }

  async function transcript(args: { video: string; from?: string | number | undefined; to?: string | number | undefined }): Promise<AbilityResult> {
    const found = await prepared(args.video);
    if ("refusal" in found) return found.refusal;
    const from = args.from === undefined ? 0 : parseTimecode(args.from);
    const to = args.to === undefined ? Number.POSITIVE_INFINITY : parseTimecode(args.to);
    if (from === undefined || to === undefined || to <= from) return refuse("REELS_TIME_INVALID");
    const timed = await readTimedTranscript(wordsPath(settings.folder, found.video.id));
    if (!timed) return refuse("REELS_VIDEO_NOT_PREPARED");
    const lines: string[] = [];
    let size = 0;
    let next: string | undefined;
    for (const phrase of timed.phrases) {
      if (phrase.end <= from || phrase.start >= to) continue;
      const line = `[${timecode(phrase.start)}] ${phrase.speaker}: ${phrase.text}`;
      if (size + line.length + 1 > MAX_TRANSCRIPT_CHARS) { next = timecode(phrase.start); break; }
      lines.push(line);
      size += line.length + 1;
    }
    return { ok: true, video: found.video.id, title: found.video.title, durationSeconds: found.video.durationSeconds,
      speakers: timed.speakers, text: lines.join("\n"), ...(next ? { truncated: true, next } : {}) };
  }

  async function cut(args: { video: string; reels: { start: string | number; end: string | number; title: string;
    subtitles?: boolean | undefined; showTitle?: boolean | undefined }[] }, call: AbilityCall): Promise<AbilityResult> {
    const found = await prepared(args.video);
    if ("refusal" in found) return found.refusal;
    const { video } = found;
    if (busy(video.id)) return refuse("REELS_VIDEO_BUSY");
    reserved.add(video.id);
    try { return await queueCut(video, args, call); } finally { reserved.delete(video.id); }
  }

  async function queueCut(video: VideoRecord, args: Parameters<typeof cut>[0], call: AbilityCall): Promise<AbilityResult> {
    const parsed: ReelCut[] = [];
    const issues: { index: number; text: string }[] = [];
    args.reels.forEach((reel, index) => {
      const start = parseTimecode(reel.start);
      const end = parseTimecode(reel.end);
      if (start === undefined || end === undefined) issues.push({ index, text: `reel ${index + 1}: REELS_TIME_INVALID` });
      parsed.push({ start: start ?? Number.NaN, end: end ?? Number.NaN, title: reel.title,
        ...(reel.subtitles === undefined ? {} : { subtitles: reel.subtitles }), ...(reel.showTitle === undefined ? {} : { showTitle: reel.showTitle }) });
    });
    const checked = validateCuts(parsed, video.durationSeconds);
    if (!checked.ok) {
      // An unreadable time already explains that entry's REELS_CUT_INVALID.
      for (const issue of checked.issues) {
        if (issue.code === "REELS_CUT_INVALID" && issues.some((known) => known.index === issue.index)) continue;
        issues.push({ index: issue.index ?? -1, text: `${issue.index === null ? "list" : `reel ${issue.index + 1}`}: ${issue.code}` +
          `${issue.other === undefined ? "" : ` (with reel ${issue.other + 1})`}` });
      }
    }
    if (issues.length || !checked.ok) {
      const text = issues.sort((a, b) => a.index - b.index).map((issue) => issue.text).join("; ");
      return { ok: false, code: "REELS_CUTS_REJECTED", message: `${MESSAGES.REELS_CUTS_REJECTED} ${text}.` };
    }
    let media: string | undefined;
    try {
      // A YouTube download is removed after each cut to save disk; the cut job fetches it again when missing.
      media = await sourceMedia(settings.folder, video, settings.workspace).catch((error: unknown) => {
        if (video.source.kind === "youtube" && errorCode(error, "") === "REELS_SOURCE_MISSING") return undefined;
        throw error;
      });
      if (video.source.kind === "file") {
        const current = await workspaceVideo(media!, settings.workspace);
        if (current.size !== video.source.size || current.mtimeMs !== video.source.mtimeMs) return refuse("REELS_SOURCE_CHANGED");
      }
    } catch (error) { return refuse(errorCode(error, "REELS_SOURCE_CHANGED")); }
    const job = jobs.add("cut", video.id, call.scope, (current) => runCut(current, video, media, checked.cuts));
    job.reels = { done: 0, total: checked.cuts.length };
    return { ok: true, video: video.id, job: job.id, reels: checked.cuts.length,
      message: "Cutting in the background; each reel is sent to this chat as it is ready, then you get a note." };
  }

  async function runCut(job: Job, video: VideoRecord, given: string | undefined, cuts: ReelCut[]): Promise<void> {
    const paused = pausable();
    const scratch = await scratchDirectory(workRoot);
    const done: CutEntry[] = [];
    const unsent: number[] = [];
    try {
      let media = given;
      if (!media) {
        if (video.source.kind !== "youtube") throw new ModuleError("REELS_SOURCE_CHANGED");
        jobs.stage(job, "fetching");
        const directory = videoDirectory(settings.folder, video.id);
        await ensureDirectory(directory);
        media = await downloadSource(job, video.source.youtubeId, directory, { runner, signal: ctx.signal, onSpawn: paused.onSpawn });
      }
      jobs.stage(job, "cutting");
      const timed = await readTimedTranscript(wordsPath(settings.folder, video.id));
      if (!timed) throw new ModuleError("REELS_VIDEO_NOT_PREPARED");
      const words = wordsFromPhrases(timed.phrases);
      await ensureDirectory(videoDirectory(settings.folder, video.id));
      const directory = reelsDirectory(settings.folder, video.id);
      await ensureDirectory(directory);
      const { next } = await existingReels(settings.folder, video.id);
      for (const [index, given] of cuts.entries()) {
        const reel = snapToWords(given, words, { durationSeconds: video.durationSeconds });
        const file = reelFileName(next + index, reel.title);
        const workDir = join(scratch.path, String(index));
        await mkdir(workDir, { mode: 0o700 });
        await renderReel({ source: media, cut: reel, words, target: join(directory, file), workDir, ffmpegPath: settings.ffmpegPath,
          runner, signal: ctx.signal, onSpawn: paused.onSpawn,
          onProgress: (percent) => jobs.progress(job, (index + percent / 100) / cuts.length * 100) });
        await rm(workDir, { recursive: true, force: true });
        done.push({ file, start: reel.start, end: reel.end, title: reel.title, subtitles: reel.subtitles !== false, showTitle: reel.showTitle !== false });
        job.reels = { done: done.length, total: cuts.length };
        const sent = await ctx.chat.sendFile(job.scope, join(directory, file), { caption: `${String(next + index + 1).padStart(2, "0")} · ${reel.title}\n` +
          `${timecode(reel.start)}–${timecode(reel.end)}`, dedupKey: `cut:${job.id}:${index}` });
        if (!sent) unsent.push(next + index + 1);
      }
      await appendCuts(settings.folder, video, done, new Date());
      // Disk: the downloaded copy goes once its reels exist; workspace files are never touched (FR-014).
      if (video.source.kind === "youtube") {
        await removeDownloadedSource(videoDirectory(settings.folder, video.id))
          .catch(() => { diagnostics.record("REELS_SOURCE_REMOVE_FAILED"); });
      }
      jobs.finish(job);
      diagnostics.record("REELS_CUT_DONE", { count: done.length });
      await ctx.chat.wake(job.scope, `Cut ${done.length} reel(s) from video ${video.id}: ${done.map((entry) => entry.file).join(", ")}. ` +
        `${unsent.length ? `Reel(s) ${unsent.join(", ")} could not be sent to this chat (they are saved in the video's reels folder); ` +
          "the others were sent" : "They were sent to this chat"} and listed in the video's cuts.md.`, `cut:${job.id}`);
    } catch (error) {
      const code = ctx.signal.aborted ? "REELS_INTERRUPTED" : errorCode(error, "REELS_CUT_FAILED");
      if (done.length) await appendCuts(settings.folder, video, done, new Date()).catch(() => undefined);
      jobs.finish(job, code);
      diagnostics.record("REELS_CUT_FAILED", { code });
      if (!ctx.signal.aborted) {
        await ctx.chat.wake(job.scope, `Cutting reels from video ${video.id} failed after ${done.length} of ${cuts.length}: ${code}. ` +
          "Finished reels were sent and listed in cuts.md; nothing else was cut.", `cut:${job.id}`);
      }
    } finally {
      paused.done();
      await scratch.cleanup();
    }
  }

  async function status(args: { video?: string | undefined }): Promise<AbilityResult> {
    const videos = (await listVideos(settings.folder)).filter((video) => args.video === undefined || video.id === args.video).slice(0, 20);
    const rows = await Promise.all(videos.map(async (video) => ({ id: video.id, title: video.title, durationSeconds: video.durationSeconds,
      preparedAt: video.preparedAt, speakers: video.speakers, reels: (await existingReels(settings.folder, video.id)).files.length })));
    return { ok: true, jobs: jobs.list(args.video) as unknown as Json[], videos: rows as unknown as Json[] };
  }

  return {
    async invoke(name, args, call) {
      const refusal = guard(call);
      if (refusal) return refusal;
      switch (name) {
        case "reels_prepare": return prepare(args as Parameters<typeof prepare>[0], call);
        case "reels_transcript": return transcript(args as Parameters<typeof transcript>[0]);
        case "reels_cut": return cut(args as Parameters<typeof cut>[0], call);
        case "reels_status": return status(args as Parameters<typeof status>[0]);
        default: return refuse("REELS_ABILITY_UNKNOWN", "Unknown reels ability.");
      }
    },
    status() {
      const active = jobs.list().filter((job) => !["done", "failed"].includes(job.stage));
      const current = active.find((job) => job.stage !== "queued");
      const labels: Record<string, string> = { fetching: "завантаження", transcribing: "транскрибування", cutting: "нарізка" };
      return current
        ? `${current.videoId}: ${labels[current.stage]} ${current.percent}%${current.etaSeconds === null ? "" : `, ~${Math.ceil(current.etaSeconds / 60)} хв`}` +
          `${active.length > 1 ? `; у черзі: ${active.length - 1}` : ""}`
        : "задач немає";
    },
    async stop() { await jobs.idle(); },
  };
}
