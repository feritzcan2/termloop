/// Formats the one ordinary user turn delivered after an image reaches the
/// Session's ignored runtime directory. The path is always cwd-relative so the
/// phone never exposes an absolute Mac path in terminal text.
export function attachedImageMessage(attachmentPath: string, text: string): string {
  const prompt = text.trim();
  return prompt.length === 0
    ? `I attached an image at ${attachmentPath}. Please inspect it.`
    : `${prompt}\n\nI attached an image at ${attachmentPath}. Please inspect it before responding.`;
}
