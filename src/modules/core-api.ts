/**
 * The only core surface a module may import (FR-012). Anything else a module needs is added here
 * explicitly, so core internals can change without breaking modules.
 */
export { SpeechGate, type PausableProcess } from "../media/speech-gate.js";
export { runManagedProcess, type ProcessControl, type ProcessOptions, type ProcessResult, type ProcessRunner } from "../media/process.js";
export { checkVadModel, checkWhisperModel, vocabularyPrompt, whisperArgs, type VadSettings, type WhisperModelCode } from "../media/whisper.js";
export { MediaError } from "../media/errors.js";
/** Reads at most `max` bytes of a file. */
export { readBounded } from "../media/paths.js";
/** Synchronous path rules used by config: throw an error with a fixed `code` (see `errorCode`). */
export { assertDisjoint, checkedPath, isWithin } from "../config/paths.js";
export type { DiagnosticSink } from "../ports.js";
export type { Json, Scope } from "../domain.js";
export {
  errorCode, FIXED_CODE, ModuleError,
  type AbilityCall, type AbilityResult, type AbilitySpec, type CoreOffer, type ModuleCheck, type ModuleContext,
  type ModuleDefinition, type ModuleInstance, type ModuleReason, type PrepareResult,
} from "./contract.js";
