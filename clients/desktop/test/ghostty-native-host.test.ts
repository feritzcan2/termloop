import { describe, expect, it } from "vitest";
import source from "@termloop/ghostty-host/native-source.mm?raw";
import { DOUBLE_SHIFT_WINDOW_MS, TERMLOOP_NATIVE_INPUT_POLICY } from "../src/ghostty-shell-shortcut.js";

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

  it("applies separate light and original dark configs to live native surfaces", () => {
    const handler = source.slice(
      source.indexOf("static Napi::Value SetSurfaceColorScheme"),
      source.indexOf("static Napi::Value FocusSurface"),
    );

    expect(handler).toContain("config = g_light_config");
    expect(handler).toContain("config = g_config");
    expect(handler).toContain("ghostty_surface_update_config(e->surface, config)");
    expect(handler).not.toContain("ghostty_surface_set_color_scheme");
    expect(handler).toContain("colorWithSRGBRed:0.976 green:0.976 blue:0.976");
    expect(handler).toContain("colorWithSRGBRed:0.157 green:0.173 blue:0.204");
    expect(handler).toContain("ghostty_surface_draw(e->surface)");
    expect(source).toContain('exports.Set("setSurfaceColorScheme"');
  });

  it("loads the light config on top of the original embedded config", () => {
    const handler = source.slice(
      source.indexOf("static Napi::Value InitApp"),
      source.indexOf("static Napi::Value CreateSurface"),
    );

    expect(handler).toContain('opts.Has("lightConfigFile")');
    expect(handler).toContain("ghostty_config_load_file(g_light_config, configFile.c_str())");
    expect(handler).toContain("ghostty_config_load_file(g_light_config, lightConfigFile.c_str())");
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
    const termLoopRoute = handler.indexOf("embedderShortcutForEvent(event)");
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
    expect(handler).toContain('notifyShellShortcut(g_inputPolicy->imagePasteAction.c_str())');
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

    expect(handler).toContain("event.timestamp - self.firstShiftDownAt <= g_inputPolicy->doubleShiftWindow");
    expect(handler).toContain('notifyShellShortcut(g_inputPolicy->doubleShiftAction.c_str())');
    // Focus decides which detector sees the taps, so a window that drifts from
    // the renderer's would open Quick Action from only some surfaces.
    expect(TERMLOOP_NATIVE_INPUT_POLICY.doubleShiftWindowMs).toBe(DOUBLE_SHIFT_WINDOW_MS);
    expect(handler.indexOf("[self dispatchKeyEvent:event")).toBeLessThan(
      handler.indexOf('notifyShellShortcut(g_inputPolicy->doubleShiftAction.c_str())'),
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
