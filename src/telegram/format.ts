type Tag = "b" | "i" | "s" | "code" | "pre";
interface Span { text: string; tags: Tag[] }
export interface HtmlChunk { html: string; text: string }

export function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function inline(text: string, tags: Tag[] = [], depth = 0): Span[] {
  if (depth > 8) return [{ text, tags }];
  const spans: Span[] = [];
  const pattern = /`+|\*+|_+|~+/g;
  let from = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const delimiter = match[0];
    const at = match.index;
    const code = delimiter[0] === "`";
    if (escaped(text, at) || (!code && (delimiter.length > 3 || (delimiter[0] === "~" && delimiter.length !== 2)))) continue;
    if (!code && !flanking(text, at, delimiter.length, delimiter[0] === "_").opens) continue;
    const matchingRun = delimiter[0] === "*" ? "\\*+" : `${delimiter[0]}+`;
    const close = new RegExp(matchingRun + "|`+", "g");
    close.lastIndex = at + delimiter.length;
    let end = code ? codeEnd(text, at + delimiter.length, delimiter.length) : -1;
    for (let candidate = !code ? close.exec(text) : null; candidate; candidate = close.exec(text)) {
      if (escaped(text, candidate.index)) continue;
      if (candidate[0][0] === "`") {
        const codeClose = codeEnd(text, candidate.index + candidate[0].length, candidate[0].length);
        if (codeClose >= 0) close.lastIndex = codeClose + candidate[0].length;
      } else if (candidate[0].length >= delimiter.length && candidate[0].length <= 3 &&
          flanking(text, candidate.index, candidate[0].length, delimiter[0] === "_").closes) {
        end = candidate.index + candidate[0].length - delimiter.length;
        break;
      }
    }
    if (end <= at + delimiter.length) continue;
    spans.push({ text: text.slice(from, at), tags });
    const content = text.slice(at + delimiter.length, end);
    const emphasis: Tag[] = delimiter === "~~" ? ["s"] : delimiter.length === 3 ? ["b", "i"] :
      delimiter.length === 2 ? ["b"] : ["i"];
    spans.push(...(code ? [{ text: content, tags: ["code"] as Tag[] }] :
      inline(content, [...new Set([...tags, ...emphasis])], depth + 1)));
    from = end + delimiter.length;
    pattern.lastIndex = from;
  }
  spans.push({ text: text.slice(from), tags });
  return spans;
}

function codeEnd(text: string, from: number, length: number): number {
  const ticks = /`+/g;
  ticks.lastIndex = from;
  for (let candidate = ticks.exec(text); candidate; candidate = ticks.exec(text)) {
    // A shorter run must never borrow characters from a longer backtick run.
    if (candidate[0].length === length) return candidate.index;
  }
  return -1;
}

function escaped(text: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && text[--at] === "\\") slashes++;
  return slashes % 2 === 1;
}

function flanking(text: string, at: number, length: number, underscore: boolean): { opens: boolean; closes: boolean } {
  const before = at > 0 ? text.slice(at >= 2 && /[\uDC00-\uDFFF]/.test(text[at - 1]!) ? at - 2 : at - 1, at) : "";
  const point = text.codePointAt(at + length);
  const after = point === undefined ? "" : String.fromCodePoint(point);
  const beforeSpace = !before || /\s/u.test(before);
  const afterSpace = !after || /\s/u.test(after);
  const beforePunctuation = /[\p{P}\p{S}]/u.test(before);
  const afterPunctuation = /[\p{P}\p{S}]/u.test(after);
  const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
  const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
  return {
    opens: left && (!underscore || !right || beforePunctuation),
    closes: right && (!underscore || !left || afterPunctuation),
  };
}

function parse(text: string): Span[] {
  const spans: Span[] = [];
  // Only a complete fenced block is formatting. Unmatched delimiters stay literal.
  const fence = /^(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
  let from = 0;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    const marker = match[1]!;
    const close = new RegExp(`^${marker[0]}{${marker.length},}[ \\t]*(?=\\r?$)`, "gm");
    close.lastIndex = fence.lastIndex;
    const end = close.exec(text);
    if (!end) continue;
    spans.push(...inline(text.slice(from, match.index)));
    // The language label is syntax, while every byte of code and its newline is retained.
    spans.push({ text: text.slice(fence.lastIndex, end.index), tags: ["pre"] });
    from = end.index + end[0].length;
    fence.lastIndex = from;
  }
  spans.push(...inline(text.slice(from)));
  return spans;
}

/** Telegram measures decoded text in UTF-16 units; never split a Unicode scalar or an HTML entity. */
export function renderTelegramHtml(text: string, limit = 4096): HtmlChunk[] {
  if (!Number.isInteger(limit) || limit < 2 || limit > 4096) throw new Error("TG_TEXT_LIMIT_INVALID");
  const chunks: HtmlChunk[] = [];
  let html = "";
  let plain = "";
  let tags: Tag[] = [];
  const close = () => { html += tags.toReversed().map((tag) => `</${tag}>`).join(""); tags = []; };
  const flush = () => {
    close();
    if (plain) chunks.push({ html, text: plain });
    html = "";
    plain = "";
  };
  for (const span of parse(text)) {
    for (const scalar of span.text) {
      if (plain.length + scalar.length > limit) flush();
      if (tags.join("/") !== span.tags.join("/")) {
        close();
        tags = span.tags;
        html += tags.map((tag) => `<${tag}>`).join("");
      }
      html += escapeHtml(scalar);
      plain += scalar;
    }
  }
  flush();
  return chunks;
}
