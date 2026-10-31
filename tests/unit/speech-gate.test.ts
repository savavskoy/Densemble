import { describe, expect, it } from "vitest";
import { MediaError } from "../../src/media/index.js";
import { SpeechGate } from "../../src/media/speech-gate.js";

function control() {
  const calls: string[] = [];
  return { calls, pause: () => { calls.push("pause"); }, resume: () => { calls.push("resume"); } };
}

describe("SpeechGate", () => {
  it("pauses background processes during voice and resumes after the last voice ends", () => {
    const gate = new SpeechGate();
    const background = control();
    gate.registerBackground(background);
    const first = gate.enterVoice();
    const second = gate.enterVoice();
    expect(gate.voiceActive).toBe(true);
    first();
    first();
    expect(background.calls).toEqual(["pause"]);
    second();
    expect(gate.voiceActive).toBe(false);
    expect(background.calls).toEqual(["pause", "resume"]);
  });

  it("pauses a process registered during voice and forgets unregistered ones", () => {
    const gate = new SpeechGate();
    const release = gate.enterVoice();
    const late = control();
    const unregister = gate.registerBackground(late);
    expect(late.calls).toEqual(["pause"]);
    unregister();
    release();
    expect(late.calls).toEqual(["pause"]);
  });

  it("waits until idle and reports changes to observers", async () => {
    const gate = new SpeechGate();
    const changes: boolean[] = [];
    gate.subscribe((active) => changes.push(active));
    await gate.waitUntilIdle(new AbortController().signal);
    const release = gate.enterVoice();
    let idle = false;
    const waiting = gate.waitUntilIdle(new AbortController().signal).then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(idle).toBe(true);
    expect(changes).toEqual([true, false]);
  });

  it("aborts a waiter without affecting voice", async () => {
    const gate = new SpeechGate();
    const release = gate.enterVoice();
    const abort = new AbortController();
    const waiting = gate.waitUntilIdle(abort.signal);
    abort.abort();
    await expect(waiting).rejects.toBeInstanceOf(MediaError);
    expect(gate.voiceActive).toBe(true);
    release();
  });

  it("keeps voice working when a background control throws", () => {
    const gate = new SpeechGate();
    gate.registerBackground({ pause: () => { throw new Error("ESRCH"); }, resume: () => { throw new Error("ESRCH"); } });
    const release = gate.enterVoice();
    expect(() => release()).not.toThrow();
  });
});
