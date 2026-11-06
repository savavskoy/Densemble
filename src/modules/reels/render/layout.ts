import { cleanWords, type ReelWord } from "./words.js";

/** Output frame (FR-011: vertical 9:16). */
export const FRAME = Object.freeze({ width: 1080, height: 1920, fps: 30 });
/** The title is shown during the first seconds of a reel. */
export const TITLE_SECONDS = 3;
const SUBTITLE = Object.freeze({ fontSize: 68, lineHeight: 90, maxWidth: 940, maxLines: 2, baseline: 1380 });
const TITLE = Object.freeze({ fontSize: 72, lineHeight: 92, maxWidth: 940, maxLines: 3, top: 300 });
/** Bold sans glyphs average about this share of the font size; wrapping is an estimate with margin. */
const CHAR_WIDTH = 0.6;
/** A gap this long ends a subtitle card; the last word stays visible this long after it ends. */
const CARD_GAP_SECONDS = 0.8;
const HOLD_SECONDS = 0.4;

/** A subtitle card: up to two lines of one phrase; `words` have times relative to the reel start. */
export interface SubtitleCard { words: ReelWord[]; lines: number[][]; start: number; end: number }
/** One stretch of the overlay stream: what is drawn from `start` to `end` (seconds from the reel start). */
export interface OverlayState { start: number; end: number; title: boolean; card?: number; word?: number }

/** Greedy wrap by estimated width; returns word indexes per line. */
export function wrap(texts: readonly string[], fontSize: number, maxWidth: number): number[][] {
  const lines: number[][] = [];
  let width = 0;
  texts.forEach((text, index) => {
    const wordWidth = [...text].length * fontSize * CHAR_WIDTH;
    const space = fontSize * CHAR_WIDTH * 0.5;
    const line = lines.at(-1);
    if (line && width + space + wordWidth <= maxWidth) { line.push(index); width += space + wordWidth; }
    else { lines.push([index]); width = wordWidth; }
  });
  return lines;
}

/**
 * Words of a reel (relative times, clipped to it) grouped into cards: a card never joins two phrases or speakers,
 * ends after a sentence or a pause, and fits two lines.
 */
export function subtitleCards(words: readonly ReelWord[], start: number, end: number): SubtitleCard[] {
  const duration = end - start;
  const inside = cleanWords(words).filter((word) => word.end > start && word.start < end)
    .map((word) => ({ ...word, start: Math.max(0, word.start - start), end: Math.min(duration, word.end - start) }));
  const groups: ReelWord[][] = [];
  for (const word of inside) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    const fits = group && wrap([...group, word].map((item) => item.text), SUBTITLE.fontSize, SUBTITLE.maxWidth).length <= SUBTITLE.maxLines;
    if (!group || !previous || !fits || previous.phrase !== word.phrase || previous.speaker !== word.speaker ||
        word.start - previous.end > CARD_GAP_SECONDS || /[.!?…]$/u.test(previous.text)) groups.push([word]);
    else group.push(word);
  }
  return groups.map((group, index) => {
    const next = groups[index + 1]?.[0]?.start ?? duration;
    return { words: group, lines: wrap(group.map((word) => word.text), SUBTITLE.fontSize, SUBTITLE.maxWidth),
      start: group[0]!.start, end: Math.min(next, duration, group.at(-1)!.end + HOLD_SECONDS) };
  });
}

/**
 * The overlay timeline: frame-aligned stretches with the title (first `TITLE_SECONDS`), the visible card and its
 * highlighted word (the one being spoken, kept through short gaps). Equal neighbours are merged.
 */
export function overlayTimeline(cards: readonly SubtitleCard[], duration: number, showTitle: boolean): OverlayState[] {
  const frame = (seconds: number) => Math.round(Math.min(duration, Math.max(0, seconds)) * FRAME.fps) / FRAME.fps;
  const points = new Set([0, frame(duration)]);
  if (showTitle) points.add(frame(TITLE_SECONDS));
  for (const card of cards) {
    points.add(frame(card.start)); points.add(frame(card.end));
    for (const word of card.words) points.add(frame(word.start));
  }
  const sorted = [...points].filter((point) => point <= frame(duration)).sort((a, b) => a - b);
  const states: OverlayState[] = [];
  for (let index = 0; index + 1 < sorted.length; index++) {
    const start = sorted[index]!;
    const end = sorted[index + 1]!;
    if (end - start <= 0) continue;
    const at = start + 1e-6;
    const card = cards.findIndex((item) => frame(item.start) <= at && at < frame(item.end));
    let word: number | undefined;
    if (card >= 0) {
      const words = cards[card]!.words;
      for (let candidate = 0; candidate < words.length; candidate++) if (frame(words[candidate]!.start) <= at) word = candidate;
    }
    const state: OverlayState = { start, end, title: showTitle && start < frame(TITLE_SECONDS),
      ...(card >= 0 ? { card } : {}), ...(word !== undefined ? { word } : {}) };
    const previous = states.at(-1);
    if (previous && previous.title === state.title && previous.card === state.card && previous.word === state.word) previous.end = end;
    else states.push(state);
  }
  return states;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = 'font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" text-anchor="middle" stroke="#000" ' +
  'stroke-linejoin="round" paint-order="stroke" fill="#fff" xml:space="preserve"';

/** A transparent full-frame SVG for one overlay state. */
export function overlaySvg(state: Pick<OverlayState, "title" | "card" | "word">, cards: readonly SubtitleCard[], title: string): string {
  const parts: string[] = [];
  if (state.title) {
    const words = title.split(/\s+/u).filter(Boolean);
    const lines = wrap(words, TITLE.fontSize, TITLE.maxWidth).slice(0, TITLE.maxLines);
    parts.push(`<g ${FONT} font-size="${TITLE.fontSize}" stroke-width="12">${lines.map((line, index) =>
      `<text x="${FRAME.width / 2}" y="${TITLE.top + index * TITLE.lineHeight}">${escape(line.map((at) => words[at]).join(" "))}</text>`).join("")}</g>`);
  }
  const card = state.card === undefined ? undefined : cards[state.card];
  if (card) {
    const top = SUBTITLE.baseline - (card.lines.length - 1) * SUBTITLE.lineHeight;
    parts.push(`<g ${FONT} font-size="${SUBTITLE.fontSize}" stroke-width="10">${card.lines.map((line, index) =>
      `<text x="${FRAME.width / 2}" y="${top + index * SUBTITLE.lineHeight}">${line.map((at) => {
        const text = escape(card.words[at]!.text);
        return at === state.word ? `<tspan fill="#FFD400">${text}</tspan>` : text;
      }).join(" ")}</text>`).join("")}</g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME.width}" height="${FRAME.height}">${parts.join("")}</svg>`;
}
