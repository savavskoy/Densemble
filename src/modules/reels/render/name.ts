/** Ukrainian national transliteration (KMU 2010); word-initial forms for є, ї, й, ю, я. Russian letters too. */
const LETTERS: Record<string, [string, string?]> = {
  а: ["a"], б: ["b"], в: ["v"], г: ["h"], ґ: ["g"], д: ["d"], е: ["e"], є: ["ie", "ye"], ж: ["zh"], з: ["z"], и: ["y"],
  і: ["i"], ї: ["i", "yi"], й: ["i", "y"], к: ["k"], л: ["l"], м: ["m"], н: ["n"], о: ["o"], п: ["p"], р: ["r"], с: ["s"],
  т: ["t"], у: ["u"], ф: ["f"], х: ["kh"], ц: ["ts"], ч: ["ch"], ш: ["sh"], щ: ["shch"], ь: [""], ю: ["iu", "yu"],
  я: ["ia", "ya"], ё: ["e"], ы: ["y"], э: ["e"], ъ: [""], "'": [""], "’": [""], "ʼ": [""],
};

export function transliterate(text: string): string {
  let result = "";
  let wordStart = true;
  for (const char of text.toLocaleLowerCase("uk")) {
    const forms = LETTERS[char];
    if (forms) {
      // "зг" is "zgh" so it is not read as "zh".
      result += char === "г" && result.endsWith("z") && !result.endsWith("zh") ? "gh" : (wordStart && forms[1]) || forms[0];
      if (forms[0] !== "") wordStart = false;
    } else {
      result += char;
      wordStart = !/[\p{L}\p{N}]/u.test(char);
    }
  }
  return result;
}

/** `NN-<slug>.mp4` for the 0-based `index`: ASCII slug of the title, at most 48 characters, `reel` when empty. */
export function reelFileName(index: number, title: string): string {
  const slug = transliterate(title).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return `${String(index + 1).padStart(2, "0")}-${slug || "reel"}.mp4`;
}
