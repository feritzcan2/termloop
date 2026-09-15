import type { FileLanguageId } from "./file-language.js";

export type FileToken = { content: string; light: string; dark: string };
export type FileHighlight = { kind: "colored"; lines: FileToken[][] } | { kind: "plain"; reason: "size" | "unavailable" };
export type FileHighlightRequest = { id: number; language: FileLanguageId; content: string };
export type FileHighlightReply = { id: number; result: FileHighlight };
const unavailable: FileHighlight = { kind: "plain", reason: "unavailable" };

/** One cancellable CPU worker per preview, reused while idle. Neither its
 * messages nor its lifetime have filesystem, network or daemon authority. */
export class FileHighlighter {
  private worker: Worker | undefined;
  private sequence = 0;
  private pending: { id: number; resolve(result: FileHighlight): void; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(private readonly createWorker = () => new Worker(new URL("./file-highlight-worker.js", import.meta.url), { type: "module" }), private readonly timeoutMs = 2500) {}

  highlight(language: FileLanguageId, content: string): Promise<FileHighlight> {
    this.cancel();
    return new Promise((resolve) => {
      try {
        if (!this.worker) {
          const worker = this.createWorker();
          this.worker = worker;
          worker.onmessage = (event: MessageEvent<FileHighlightReply>) => {
            if (this.worker === worker && event.data.id === this.pending?.id) this.finish(event.data.result);
          };
          worker.onerror = () => { if (this.worker === worker) this.dispose(); };
          worker.onmessageerror = () => { if (this.worker === worker) this.dispose(); };
        }
        const id = ++this.sequence;
        const timer = setTimeout(() => this.dispose(), this.timeoutMs);
        this.pending = { id, resolve, timer };
        this.worker.postMessage({ id, language, content } satisfies FileHighlightRequest);
      } catch {
        this.dispose(); resolve(unavailable);
      }
    });
  }
  private finish(result: FileHighlight): void {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.resolve(result); }
  }
  cancel(): void { if (this.pending) this.dispose(); }
  dispose(): void {
    if (this.worker) {
      this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = undefined;
    }
    this.finish(unavailable);
  }
}
