export const mediaMessages = {
  MEDIA_ABORTED: "Media processing was cancelled.",
  MEDIA_STALE_RUN: "This run is no longer active. Send the attachment again in the current conversation.",
  MEDIA_SCOPE_INVALID: "The attachment does not belong to this conversation.",
  MEDIA_TOO_LARGE: "The attachment exceeds the 20 MB download limit, or the file exceeds the 50 MB export limit.",
  MEDIA_TEXT_TOO_LARGE: "This document is too long. Send a smaller section; no content was silently truncated.",
  MEDIA_EMPTY: "The attachment contains no usable text.",
  MEDIA_UNSUPPORTED: "This format is not supported. Send PNG/JPEG/WebP, TXT/Markdown/CSV, a text PDF, DOCX, or a voice message.",
  MEDIA_MISMATCH: "The attachment's declared type or size does not match its contents.",
  MEDIA_INVALID_UTF8: "The text file is not valid UTF-8, or contains binary data.",
  MEDIA_CORRUPT: "The attachment is damaged or cannot be read safely.",
  MEDIA_ENCRYPTED: "Encrypted documents are not supported. Send an unencrypted copy.",
  MEDIA_PDF_NO_TEXT: "This PDF has no extractable text. Scanned/image-only PDFs and OCR are not supported.",
  MEDIA_PDF_UNSAFE: "This PDF cannot be processed within safe decoded-memory limits. Send a smaller document or a plain-text export.",
  MEDIA_DOCX_UNSAFE: "This DOCX contains active content or exceeds safe archive limits. Send a plain-text export.",
  MEDIA_IMAGE_UNSAFE: "This image is damaged or exceeds safe image dimensions.",
  MEDIA_TIMEOUT: "Media processing exceeded its time limit. Send a smaller file.",
  MEDIA_PATH_UNSAFE: "This file cannot be accessed or exported safely.",
  MEDIA_NOT_FOUND: "This attachment has expired or is unavailable. Please upload it again.",
  MEDIA_DOWNLOAD_FAILED: "The attachment could not be downloaded. Please try uploading it again.",
  MEDIA_AUDIO_TOO_LONG: "Voice messages must be at most 10 minutes long.",
  MEDIA_AUDIO_INVALID: "The voice message is damaged or its actual duration cannot be verified.",
  MEDIA_AUDIO_TOOLS_MISSING: "Local voice recognition is not configured. Explicitly install/configure ffmpeg, ffprobe and whisper.cpp first.",
  MEDIA_AUDIO_MODEL_MISSING: "Provision and configure the multilingual Whisper small model explicitly. No model is downloaded automatically.",
  MEDIA_AUDIO_FAILED: "Local voice recognition failed. Please send text instead.",
} as const;

export type MediaErrorCode = keyof typeof mediaMessages;

export class MediaError extends Error {
  readonly code: MediaErrorCode;
  readonly userMessage: string;
  constructor(code: MediaErrorCode) {
    super(code);
    this.name = "MediaError";
    this.code = code;
    this.userMessage = mediaMessages[code];
  }
}

export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaError("MEDIA_ABORTED");
}

export function mediaError(error: unknown, fallback: MediaErrorCode = "MEDIA_CORRUPT"): MediaError {
  return error instanceof MediaError ? error : new MediaError(fallback);
}
