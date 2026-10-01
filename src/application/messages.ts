import { RuntimeError } from "../agents/contracts.js";

const failures: Record<string, string> = {
  MODEL_UNAVAILABLE: "Налаштована модель недоступна. Оберіть доступну через /model; модель субагента змінюється в його launcher.",
  MODEL_IMAGES_UNSUPPORTED: "Поточна модель не підтримує зображення. Оберіть іншу через /model і надішліть фото знову.",
  MEDIA_ABORTED: "Обробку вкладення скасовано.",
  MEDIA_STALE_RUN: "Виконання вже завершене. Надішліть вкладення в поточну розмову знову.",
  MEDIA_SCOPE_INVALID: "Вкладення не належить цій розмові.",
  MEDIA_TOO_LARGE: "Ліміт завантаження — 20 МБ, надсилання файла — 50 МБ. Надішліть менший файл.",
  MEDIA_TEXT_TOO_LARGE: "Документ завеликий. Надішліть менший фрагмент; вміст не обрізався мовчки.",
  MEDIA_EMPTY: "У вкладенні немає придатного для обробки тексту.",
  MEDIA_UNSUPPORTED: "Формат не підтримується. Доступні PNG/JPEG/WebP, TXT/Markdown/CSV, текстовий PDF, DOCX і голосові.",
  MEDIA_MISMATCH: "Заявлений тип або розмір вкладення не відповідає його вмісту.",
  MEDIA_INVALID_UTF8: "Текст має бути у UTF-8 без двійкових даних.",
  MEDIA_CORRUPT: "Вкладення пошкоджене або його неможливо безпечно прочитати.",
  MEDIA_ENCRYPTED: "Зашифровані документи не підтримуються. Надішліть незашифровану копію.",
  MEDIA_PDF_NO_TEXT: "PDF не містить текстового шару. Скановані PDF та OCR не підтримуються.",
  MEDIA_PDF_UNSAFE: "PDF перевищує безпечні межі обробки. Надішліть менший файл або експортуйте його як звичайний текст.",
  MEDIA_DOCX_UNSAFE: "DOCX містить активний вміст або перевищує безпечні межі архіву. Експортуйте його як текст.",
  MEDIA_IMAGE_UNSAFE: "Зображення пошкоджене або має надмірні розміри.",
  MEDIA_TIMEOUT: "Час обробки вкладення вичерпано. Надішліть менший файл.",
  MEDIA_PATH_UNSAFE: "Цей файл неможливо безпечно прочитати або експортувати.",
  MEDIA_NOT_FOUND: "Вкладення вже недоступне або строк зберігання минув. Завантажте його знову.",
  MEDIA_DOWNLOAD_FAILED: "Вкладення не вдалося завантажити. Надішліть його знову.",
  MEDIA_AUDIO_TOO_LONG: "Голосове повідомлення має тривати не більш ніж 10 хвилин.",
  MEDIA_AUDIO_INVALID: "Голосове пошкоджене або неможливо перевірити його фактичну тривалість.",
  MEDIA_AUDIO_TOOLS_MISSING: "Локальне розпізнавання не налаштоване. Потрібні FFmpeg, FFprobe і whisper.cpp.",
  MEDIA_AUDIO_MODEL_MISSING: "Потрібно явно встановити й налаштувати багатомовну модель Whisper. Автоматичного завантаження немає.",
  MEDIA_AUDIO_FAILED: "Локальне розпізнавання не вдалося. Надішліть текст.",
};

export function failureCode(error: unknown): string {
  if (error instanceof RuntimeError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" &&
      Object.hasOwn(failures, error.code)) return error.code;
  return "INPUT_OR_RUNTIME_FAILED";
}
export function failureMessage(code: string): string {
  return Object.hasOwn(failures, code) ? `${failures[code]} (${code})` :
    `Не вдалося завершити операцію (${code}). Повторного запуску дій не було.`;
}
export function mediaNotice(text: string): string {
  return text.replace(/^Automatically transcribed voice \(you can correct it with a message\):\n/,
    "Автоматично розпізнано голосове. За потреби уточніть звичайним повідомленням:\n");
}
