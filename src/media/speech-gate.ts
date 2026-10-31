import { checkAbort } from "./errors.js";

export interface PausableProcess { pause(): void; resume(): void }

/**
 * Voice first: while any voice message is being recognised, registered background speech
 * processes are paused (their whole group is stopped) and no new background work starts.
 */
export class SpeechGate {
  private voices = 0;
  private readonly background = new Set<PausableProcess>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly listeners = new Set<(voiceActive: boolean) => void>();

  get voiceActive(): boolean { return this.voices > 0; }

  /** Returns an idempotent release; the last release resumes background processes. */
  enterVoice(): () => void {
    if (this.voices++ === 0) {
      for (const control of this.background) safely(() => control.pause());
      this.emit(true);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.voices > 0) return;
      for (const control of this.background) safely(() => control.resume());
      this.emit(false);
      for (const wake of [...this.idleWaiters]) wake();
    };
  }

  /** A process registered during voice activity is paused at once; the returned function unregisters it. */
  registerBackground(control: PausableProcess): () => void {
    this.background.add(control);
    if (this.voiceActive) safely(() => control.pause());
    return () => { this.background.delete(control); };
  }

  /** Resolves once no voice message is being recognised; rejects with MEDIA_ABORTED on abort. */
  async waitUntilIdle(signal: AbortSignal): Promise<void> {
    checkAbort(signal);
    while (this.voiceActive) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { this.idleWaiters.delete(wake); signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.idleWaiters.delete(wake); try { checkAbort(signal); } catch (error) { reject(error); } };
        this.idleWaiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
  }

  /** Observes voice activity changes (pause/resume of background work). */
  subscribe(listener: (voiceActive: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(voiceActive: boolean): void {
    for (const listener of this.listeners) safely(() => listener(voiceActive));
  }
}

function safely(action: () => void): void {
  try { action(); } catch { /* A finished process or a failing observer must not break voice recognition. */ }
}
