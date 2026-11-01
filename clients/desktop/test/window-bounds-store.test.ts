import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { restorableWindowBounds, WindowBoundsFileStore } from "../src/platform/window-bounds-store.js";

const limits = { minWidth: 820, minHeight: 560 };
const primary = { x: 0, y: 25, width: 1920, height: 1055 };
const secondary = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("window bounds restore", () => {
  it("keeps saved bounds that sit on a connected display", () => {
    expect(restorableWindowBounds({ x: 2000, y: 100, width: 1600, height: 1000 }, [primary, secondary], limits))
      .toEqual({ x: 2000, y: 100, width: 1600, height: 1000 });
  });

  it("drops the position but keeps the size when the display is gone", () => {
    expect(restorableWindowBounds({ x: 2000, y: 100, width: 1600, height: 1000 }, [primary], limits))
      .toEqual({ width: 1600, height: 1000 });
  });

  it("clamps size to the work area and the minimum limits", () => {
    expect(restorableWindowBounds({ x: 10, y: 30, width: 5000, height: 300 }, [primary], limits))
      .toEqual({ x: 0, y: 30, width: 1920, height: 560 });
  });

  it("pulls a partially off-screen window back inside its display", () => {
    expect(restorableWindowBounds({ x: 1500, y: 900, width: 1000, height: 800 }, [primary], limits))
      .toEqual({ x: 920, y: 280, width: 1000, height: 800 });
  });
});

describe("window bounds file store", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("round-trips saved geometry", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "termloop-window-bounds-"));
    const store = new WindowBoundsFileStore(path.join(directory, "window-bounds.v1.json"));
    expect(store.load()).toBeUndefined();
    store.save({ bounds: { x: 12, y: 40, width: 1400, height: 900 }, maximized: true, fullScreen: false });
    expect(store.load()).toEqual({ bounds: { x: 12, y: 40, width: 1400, height: 900 }, maximized: true, fullScreen: false });
    expect(JSON.parse(await readFile(path.join(directory, "window-bounds.v1.json"), "utf8")).version).toBe(1);
  });

  it("ignores corrupt or invalid documents", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "termloop-window-bounds-"));
    const file = path.join(directory, "window-bounds.v1.json");
    const store = new WindowBoundsFileStore(file);
    await writeFile(file, "{not json");
    expect(store.load()).toBeUndefined();
    await writeFile(file, JSON.stringify({ version: 1, window: { bounds: { x: 0, y: 0, width: -5, height: 10 } } }));
    expect(store.load()).toBeUndefined();
    await writeFile(file, JSON.stringify({ version: 2, window: { bounds: { x: 0, y: 0, width: 900, height: 700 } } }));
    expect(store.load()).toBeUndefined();
  });
});
