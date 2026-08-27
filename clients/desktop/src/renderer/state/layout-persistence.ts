import { decodeLayoutDocument, type LayoutDocument } from "../../layout/model.js";

type PersistableLayoutState = {
  layoutLoaded: boolean;
  layoutRevision: number;
  layoutDocument(): LayoutDocument;
};

export function createLayoutPersistence(
  save: (document: LayoutDocument) => Promise<void>,
  report: (error: unknown) => void,
  schedule: (callback: () => void) => void = (callback) => { setTimeout(callback, 0); },
): (state: PersistableLayoutState) => void {
  let pending: PersistableLayoutState | undefined;
  let scheduled = false;

  return (state) => {
    if (!state.layoutLoaded) return;
    pending = state;
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      const latest = pending;
      pending = undefined;
      if (!latest) return;
      const document = decodeLayoutDocument(latest.layoutDocument());
      if (!document) {
        report(new Error("invalidLayoutDocument"));
        return;
      }
      void save(document).catch(report);
    });
  };
}
