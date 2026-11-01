import { readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DiagnosticSink, Scope } from "../core-api.js";

export type JobKind = "prepare" | "cut";
export type JobStage = "queued" | "fetching" | "transcribing" | "cutting" | "done" | "failed";

/** What `reels_status` and `/status` show; no paths and no transcript text. */
export interface JobView {
  id: string;
  kind: JobKind;
  videoId: string;
  stage: JobStage;
  /** Of the current stage. */
  percent: number;
  etaSeconds: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Fixed code of a failure. */
  code?: string;
  /** Cut jobs: reels finished / requested. */
  reels?: { done: number; total: number };
}

export interface Job extends JobView { scope: Scope }

const KEEP = 20;
const ACTIVE: ReadonlySet<JobStage> = new Set(["queued", "fetching", "transcribing", "cutting"]);

/**
 * Jobs run one at a time in request order (fetching, transcription and rendering are heavy). The list survives a
 * restart in `jobs.json`; a job that was running then is reported failed with `REELS_INTERRUPTED`.
 */
export function createJobs(options: { dataPath: string; diagnostics: DiagnosticSink; now?: () => number }) {
  const now = options.now ?? Date.now;
  const path = join(options.dataPath, "jobs.json");
  const jobs: Job[] = [];
  const stageStarted = new Map<string, number>();
  let tail: Promise<unknown> = Promise.resolve();
  let writing: Promise<void> = Promise.resolve();
  const iso = () => new Date(now()).toISOString();

  const persist = () => {
    const views = jobs.map(view);
    writing = writing.then(async () => {
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify({ version: 1, jobs: views })}\n`, { mode: 0o600 });
      await rename(temp, path);
    }).catch(() => { options.diagnostics.record("REELS_JOBS_WRITE_FAILED"); });
    return writing;
  };
  const view = (job: Job): JobView => { const { scope: _scope, ...rest } = job; return structuredClone(rest); };

  return {
    async load(): Promise<void> {
      try {
        const data = JSON.parse(await readFile(path, "utf8")) as { jobs?: JobView[] };
        for (const saved of (data.jobs ?? []).slice(0, KEEP)) {
          if (typeof saved?.id !== "string" || typeof saved.videoId !== "string") continue;
          const interrupted = ACTIVE.has(saved.stage);
          // Restored jobs never talk to a chat again: the scope is not kept.
          jobs.push({ ...saved, scope: { ownerId: 0, botId: "", chatId: 0, topicId: null },
            ...(interrupted ? { stage: "failed" as const, code: "REELS_INTERRUPTED", etaSeconds: null, finishedAt: iso() } : {}) });
        }
      } catch { /* First start. */ }
      await persist();
    },
    /** Queues `work`; it runs after every earlier job. Never rejects. */
    add(kind: JobKind, videoId: string, scope: Scope, work: (job: Job) => Promise<void>): Job {
      const job: Job = { id: randomUUID().slice(0, 8), kind, videoId, scope, stage: "queued", percent: 0, etaSeconds: null,
        createdAt: iso(), updatedAt: iso() };
      jobs.unshift(job);
      jobs.splice(KEEP);
      void persist();
      tail = tail.then(() => work(job)).catch(() => undefined);
      return job;
    },
    active(videoId: string): Job | undefined {
      return jobs.find((job) => job.videoId === videoId && ACTIVE.has(job.stage));
    },
    stage(job: Job, stage: JobStage): void {
      job.stage = stage;
      job.percent = 0;
      job.etaSeconds = null;
      job.updatedAt = iso();
      stageStarted.set(job.id, now());
      void persist();
    },
    progress(job: Job, percent: number): void {
      const value = Math.max(0, Math.min(100, Math.floor(percent)));
      if (value === job.percent) return;
      job.percent = value;
      const elapsed = (now() - (stageStarted.get(job.id) ?? now())) / 1000;
      job.etaSeconds = value >= 3 && value < 100 ? Math.round(elapsed * (100 - value) / value) : null;
      job.updatedAt = iso();
      void persist();
    },
    finish(job: Job, code?: string): void {
      job.stage = code ? "failed" : "done";
      job.percent = code ? job.percent : 100;
      job.etaSeconds = null;
      job.finishedAt = job.updatedAt = iso();
      if (code) job.code = code;
      stageStarted.delete(job.id);
      void persist();
    },
    list(videoId?: string): JobView[] {
      return jobs.filter((job) => videoId === undefined || job.videoId === videoId).map(view);
    },
    /** Waits for the running job and pending writes (the caller aborts the jobs first). */
    async idle(): Promise<void> {
      await tail;
      await writing;
    },
  };
}
export type Jobs = ReturnType<typeof createJobs>;
