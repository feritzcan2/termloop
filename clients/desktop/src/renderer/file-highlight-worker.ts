import { highlightFileSource } from "./file-highlight-engine.js";
import type { FileHighlightRequest, FileHighlightReply } from "./file-highlight.js";

// Bundled separately and loaded only by the preview's sandboxed browser worker.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<FileHighlightRequest>) => void) | null;
  postMessage(reply: FileHighlightReply): void;
};
worker.onmessage = (event) => {
  const { id, language, content } = event.data;
  void highlightFileSource(language, content).then((result) => worker.postMessage({ id, result }));
};
