import { describe, expect, it } from "vitest";
import source from "../native/ghostty-host/src/ghostty_host.mm?raw";
import { DOUBLE_SHIFT_WINDOW_MS } from "../src/renderer/command-surface.js";

describe("Ghostty native host visibility", () => {
  it("forwards visibility using Ghostty's visible-boolean semantics", () => {
    const handler = source.slice(
      source.indexOf("static Napi::Value SetSurfaceVisible"),
      source.indexOf("static Napi::Value FocusSurface"),
    );

    expect(handler).toContain("e->view.hidden = !visible;");
    expect(handler).toContain("ghostty_surface_set_occlusion(e->surface, visible);");
    expect(handler).not.toContain("ghostty_surface_set_occlusion(e->surface, !visible);");
  });

  it("forces a full draw when a hidden native surface becomes visible", () => {
    const handler = source.slice(
      source.indexOf("static Napi::Value SetSurfaceVisible"),
      source.indexOf("static Napi::Value FocusSurface"),
    );
    const unhide = handler.indexOf("e->view.hidden = !visible;");
    const visibility = handler.indexOf("ghostty_surface_set_occlusion(e->surface, visible);");
    const draw = handler.indexOf("ghostty_surface_draw(e->surface);");

    expect(handler).toContain("if (visible)");
    expect(unhide).toBeGreaterThanOrEqual(0);
    expect(visibility).toBeGreaterThan(unhide);
    expect(draw).toBeGreaterThan(visibility);
  });

  it("restores Chromium focus before hiding a focused native surface", () => {
    const focusMethods = source.slice(
      source.indexOf("- (void)focusSurface"),
      source.indexOf("// -- keyboard / IME"),
    );
    const visibilityHandler = source.slice(
      source.indexOf("static Napi::Value SetSurfaceVisible"),
      source.indexOf("static Napi::Value FocusSurface"),
    );
    const restore = visibilityHandler.indexOf("[e->view restoreFocusIfOwned]");
    const hide = visibilityHandler.indexOf("e->view.hidden = !visible;");

    expect(focusMethods).toContain("self.restorationResponder = current;");
    expect(focusMethods).toContain("[window makeFirstResponder:responder]");
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(hide);
  });

  it("routes AppKit command key equivalents through Ghostty bindings", () => {
    const handler = source.slice(
      source.indexOf("- (BOOL)performKeyEquivalent"),
      source.indexOf("- (void)flagsChanged"),
    );

    expect(handler).toContain("ghostty_surface_key_is_binding");
    expect(handler).toContain("[self keyDown:event]");
  });

  it("reserves TermLoop and Electron lifecycle shortcuts before Ghostty bindings", () => {
    const handler = source.slice(
      source.indexOf("- (BOOL)performKeyEquivalent"),
      source.indexOf("- (void)flagsChanged"),
    );
    const termLoopRoute = handler.indexOf("termLoopShortcutForEvent(event)");
    const lifecycleGuard = handler.indexOf("embedderOwnsLifecycleKeyEquivalent(event)");
    const ghosttyLookup = handler.indexOf("ghostty_surface_key_is_binding");

    expect(termLoopRoute).toBeGreaterThanOrEqual(0);
    expect(lifecycleGuard).toBeGreaterThan(termLoopRoute);
    expect(ghosttyLookup).toBeGreaterThan(lifecycleGuard);
    expect(handler).toContain("notifyShellShortcut(shortcut)");
    expect(handler).toContain("[super performKeyEquivalent:event]");
  });

  it("routes image-only Cmd+V to the remote image paste intent", () => {
    const handler = source.slice(
      source.indexOf("- (BOOL)performKeyEquivalent"),
      source.indexOf("- (void)flagsChanged"),
    );
    const imagePaste = handler.indexOf("isImageOnlyPasteKeyEquivalent(event)");
    const ghosttyLookup = handler.indexOf("ghostty_surface_key_is_binding");

    expect(source).toContain("[NSImage canInitWithPasteboard:pasteboard]");
    expect(handler).toContain('notifyShellShortcut("pasteImage")');
    expect(imagePaste).toBeGreaterThanOrEqual(0);
    expect(imagePaste).toBeLessThan(ghosttyLookup);
  });

  it("fails closed when the embedded Ghostty config has diagnostics", () => {
    const initialization = source.slice(
      source.indexOf("static Napi::Value InitApp"),
      source.indexOf("static Napi::Value CreateSurface"),
    );

    expect(initialization).toContain("ghostty_config_diagnostics_count(g_config)");
    expect(initialization).toContain("invalid embedded Ghostty config");
    expect(initialization).toContain("ThrowAsJavaScriptException");
  });

  it("detects double Shift natively while the Ghostty surface is first responder", () => {
    const handler = source.slice(
      source.indexOf("- (void)flagsChanged"),
      source.indexOf("- (BOOL)hasMarkedText"),
    );

    expect(handler).toContain("event.timestamp - self.firstShiftDownAt <= kTermLoopDoubleShiftWindow");
    expect(handler).toContain('notifyShellShortcut("quickAction")');
    // Focus decides which detector sees the taps, so a window that drifts from
    // the renderer's would open Quick Action from only some surfaces.
    expect(source).toContain(
      `static const NSTimeInterval kTermLoopDoubleShiftWindow = ${DOUBLE_SHIFT_WINDOW_MS / 1000};`,
    );
    expect(handler.indexOf("[self dispatchKeyEvent:event")).toBeLessThan(
      handler.indexOf('notifyShellShortcut("quickAction")'),
    );
  });

  it("captures the rendered AppKit surface for pixel-faithful overlay snapshots", () => {
    const handler = source.slice(
      source.indexOf("static Napi::Value SurfacePng"),
      source.indexOf("static Napi::Value SurfaceText"),
    );

    expect(handler).toContain("bitmapImageRepForCachingDisplayInRect");
    expect(handler).toContain("cacheDisplayInRect");
    expect(handler).toContain("NSBitmapImageFileTypePNG");
  });
});
