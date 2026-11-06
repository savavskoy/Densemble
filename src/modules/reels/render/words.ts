/** Seconds from the start of the source; `text` is the word as spoken (whitespace is trimmed here). */
export interface TimedWord { start: number; end: number; text: string }
export interface TranscriptPhrase { start: number; end: number; speaker: string; text: string; words: readonly TimedWord[] }
/** A word with the phrase it belongs to, so subtitles never join two phrases or speakers. */
export interface ReelWord extends TimedWord { phrase?: number; speaker?: string }

/** Flattens phrases into words tagged with their phrase index and speaker. */
export function wordsFromPhrases(phrases: readonly TranscriptPhrase[]): ReelWord[] {
  return phrases.flatMap((phrase, index) => phrase.words.map((word) => ({ ...word, phrase: index, speaker: phrase.speaker })));
}

/** Drops unusable words (non-finite or reversed times, empty text), trims text and sorts by start. */
export function cleanWords<T extends TimedWord>(words: readonly T[]): T[] {
  return words
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end >= word.start &&
      typeof word.text === "string" && word.text.trim() !== "")
    .map((word) => ({ ...word, text: word.text.trim().replace(/\s+/gu, " ") }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}
