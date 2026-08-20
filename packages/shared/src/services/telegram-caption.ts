const TELEGRAM_CAPTION_MAX = 1024;

export interface ClipCaptionInput {
  title: string;
  description?: string | null;
  lowQuality?: boolean;
  /** Localized note, injected by the bot (i18n lives bot-side). */
  lowQualityNote?: string;
  /** Localized "Would you post this?" - injected the same way lowQualityNote
   *  is, and only when the feedback keyboard is actually attached. Buttons
   *  reading "As is / I'd edit it / No" mean nothing without it. */
  feedbackPrompt?: string;
}

/** Plain-text caption (sendVideo uses no parse_mode). ALWAYS clamped to 1024. */
export function buildClipCaption(input: ClipCaptionInput): string {
  const parts: string[] = [];
  if (input.lowQuality && input.lowQualityNote) parts.push(input.lowQualityNote);
  parts.push(input.title);
  if (input.description) parts.push(input.description);
  if (input.feedbackPrompt) parts.push(input.feedbackPrompt);
  const caption = parts.join("\n\n").trim();
  if (caption.length <= TELEGRAM_CAPTION_MAX) return caption;
  return caption.slice(0, TELEGRAM_CAPTION_MAX - 1).trimEnd() + "…";
}
