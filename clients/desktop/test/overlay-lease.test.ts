// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useOverlayLease, useOverlayLeaseCount } from "../src/renderer/ui/overlay-lease.js";

function Consumer(props: { visible: boolean; report(visible: boolean): void }) {
  useOverlayLease(props.visible, props.report);
  return null;
}

describe("overlay leases", () => {
  it("keeps a sibling's open dialog covered when another overlay consumer mounts, opens, closes, or unmounts", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    const observed: boolean[] = [];
    function Host(props: { dialog: boolean; sibling: boolean | undefined }) {
      const [open, report] = useOverlayLeaseCount();
      observed.push(open);
      return createElement(Fragment, null,
        createElement(Consumer, { visible: props.dialog, report }),
        props.sibling === undefined ? null : createElement(Consumer, { visible: props.sibling, report }));
    }
    const render = (dialog: boolean, sibling: boolean | undefined) =>
      act(async () => root.render(createElement(Host, { dialog, sibling })));

    await render(true, undefined);
    expect(observed.at(-1)).toBe(true);
    // A closed sibling mounting in the background must not clear the dialog's lease.
    await render(true, false);
    expect(observed.at(-1)).toBe(true);
    await render(true, true);
    await render(true, false);
    expect(observed.at(-1)).toBe(true);
    await render(true, undefined);
    expect(observed.at(-1)).toBe(true);
    await render(false, undefined);
    expect(observed.at(-1)).toBe(false);
    await act(async () => root.unmount());
  });
});
