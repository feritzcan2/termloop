// Production macOS host for native Ghostty surfaces inside an Electron BrowserWindow.
//
// Loaded in the Electron MAIN process only. Electron's main process runs
// on the AppKit main thread, so every N-API entry point here executes on
// the thread AppKit and libghostty expect.
//
// IO model: each surface gets one end of a socketpair via the patched
// ghostty_surface_config_s.external_io_fd (termloop-external-io branch).
// Ghostty never spawns a process; JS wraps the host end of the pair in a
// net.Socket and bridges bytes wherever it wants.

#include <napi.h>

#import <AppKit/AppKit.h>
#import <IOKit/hidsystem/IOLLEvent.h>
#import <QuartzCore/QuartzCore.h>

#include <ghostty.h>

#include <sys/socket.h>
#include <fcntl.h>
#include <unistd.h>

#include <cstring>
#include <atomic>
#include <map>
#include <string>

// ---------------------------------------------------------------------------
// Ghostty app singleton + runtime callbacks
// ---------------------------------------------------------------------------

static ghostty_app_t g_app = nullptr;
static ghostty_config_t g_config = nullptr;
static Napi::ThreadSafeFunction *g_surfaceClosed = nullptr;
static Napi::ThreadSafeFunction *g_surfaceConsumed = nullptr;
static Napi::ThreadSafeFunction *g_shellShortcut = nullptr;

struct SurfaceCallbackContext {
  uint32_t id;
  std::atomic<bool> alive{true};
};

struct ConsumedPayload {
  uint32_t id;
  size_t bytes;
};

struct ShellShortcutPayload {
  std::string id;
};

static void externalIoConsumedCallback(void *userdata, size_t bytes) {
  auto *context = static_cast<SurfaceCallbackContext *>(userdata);
  if (context == nullptr || !context->alive.load(std::memory_order_acquire) ||
      g_surfaceConsumed == nullptr) return;
  auto *payload = new ConsumedPayload{context->id, bytes};
  const napi_status status = g_surfaceConsumed->NonBlockingCall(
      payload, [](Napi::Env env, Napi::Function callback,
                  ConsumedPayload *value) {
        callback.Call({Napi::Number::New(env, value->id),
                       Napi::Number::New(env, (double)value->bytes)});
        delete value;
      });
  if (status != napi_ok) delete payload;
}

static void tickApp() {
  if (g_app != nullptr) ghostty_app_tick(g_app);
}

static void wakeupCallback(void *) {
  // May be called from any thread; tick must happen on the main thread.
  dispatch_async(dispatch_get_main_queue(), ^{
    tickApp();
  });
}

static bool actionCallback(ghostty_app_t, ghostty_target_s, ghostty_action_s) {
  // TermLoop owns application actions (new windows, titles, and process
  // lifecycle); this byte-renderer host does not delegate them to Ghostty.
  return false;
}

// The userdata for surface-scoped callbacks is the surface config
// userdata; we set it to the TLGhosttyView so we can recover the
// surface handle.
@class TLGhosttyView;
static ghostty_surface_t surfaceFromUserdata(void *userdata);
static void notifySurfaceClosed(TLGhosttyView *view);

static bool readClipboardCallback(void *userdata,
                                  ghostty_clipboard_e,
                                  void *state) {
  ghostty_surface_t surface = surfaceFromUserdata(userdata);
  if (surface == nullptr) return false;
  // Complete synchronously from the general pasteboard.
  NSString *str = [[NSPasteboard generalPasteboard]
      stringForType:NSPasteboardTypeString];
  const char *utf8 = str ? str.UTF8String : "";
  ghostty_surface_complete_clipboard_request(surface, utf8, state, true);
  return true;
}

static void confirmReadClipboardCallback(void *userdata,
                                         const char *str,
                                         void *state,
                                         ghostty_clipboard_request_e request) {
  ghostty_surface_t surface = surfaceFromUserdata(userdata);
  if (surface == nullptr) return;
  // Phase 1 has no confirmation sheet. Preserve explicit paste while denying
  // terminal-initiated OSC 52 reads by completing them empty.
  const char *result = request == GHOSTTY_CLIPBOARD_REQUEST_PASTE && str
                           ? str
                           : "";
  ghostty_surface_complete_clipboard_request(surface, result, state, true);
}

static void writeClipboardCallback(void *,
                                   ghostty_clipboard_e,
                                   const ghostty_clipboard_content_s *contents,
                                   size_t count,
                                   bool confirm) {
  // A confirmation request here is an OSC 52 write. Until TermLoop owns a
  // native confirmation UI, fail closed instead of mutating the pasteboard.
  if (confirm) return;
  for (size_t i = 0; i < count; i++) {
    const ghostty_clipboard_content_s &c = contents[i];
    if (c.mime == nullptr || c.data == nullptr) continue;
    if (strcmp(c.mime, "text/plain") != 0) continue;
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    [pb setString:[NSString stringWithUTF8String:c.data]
          forType:NSPasteboardTypeString];
    return;
  }
}

static void closeSurfaceCallback(void *userdata, bool) {
  if (userdata == nullptr) return;
  notifySurfaceClosed((__bridge TLGhosttyView *)userdata);
}

// ---------------------------------------------------------------------------
// Input translation helpers
// ---------------------------------------------------------------------------

static ghostty_input_mods_e modsFromNSEvent(NSEventModifierFlags flags) {
  int mods = GHOSTTY_MODS_NONE;
  if (flags & NSEventModifierFlagShift) mods |= GHOSTTY_MODS_SHIFT;
  if (flags & NSEventModifierFlagControl) mods |= GHOSTTY_MODS_CTRL;
  if (flags & NSEventModifierFlagOption) mods |= GHOSTTY_MODS_ALT;
  if (flags & NSEventModifierFlagCommand) mods |= GHOSTTY_MODS_SUPER;
  if (flags & NSEventModifierFlagCapsLock) mods |= GHOSTTY_MODS_CAPS;
  const NSUInteger raw = flags;
  if (raw & NX_DEVICERSHIFTKEYMASK) mods |= GHOSTTY_MODS_SHIFT_RIGHT;
  if (raw & NX_DEVICERCTLKEYMASK) mods |= GHOSTTY_MODS_CTRL_RIGHT;
  if (raw & NX_DEVICERALTKEYMASK) mods |= GHOSTTY_MODS_ALT_RIGHT;
  if (raw & NX_DEVICERCMDKEYMASK) mods |= GHOSTTY_MODS_SUPER_RIGHT;
  return (ghostty_input_mods_e)mods;
}

static NSEventModifierFlags modsToNSEvent(ghostty_input_mods_e mods) {
  NSEventModifierFlags flags = 0;
  if (mods & GHOSTTY_MODS_SHIFT) flags |= NSEventModifierFlagShift;
  if (mods & GHOSTTY_MODS_CTRL) flags |= NSEventModifierFlagControl;
  if (mods & GHOSTTY_MODS_ALT) flags |= NSEventModifierFlagOption;
  if (mods & GHOSTTY_MODS_SUPER) flags |= NSEventModifierFlagCommand;
  if (mods & GHOSTTY_MODS_CAPS) flags |= NSEventModifierFlagCapsLock;
  return flags;
}

static const char *termLoopShortcutForEvent(NSEvent *event) {
  const NSEventModifierFlags flags = event.modifierFlags &
      (NSEventModifierFlagShift | NSEventModifierFlagControl |
       NSEventModifierFlagOption | NSEventModifierFlagCommand);
  if ((flags & NSEventModifierFlagCommand) == 0 ||
      (flags & NSEventModifierFlagControl) != 0) return nullptr;

  const NSEventModifierFlags chord = flags &
      (NSEventModifierFlagShift | NSEventModifierFlagOption);
  if (event.keyCode == 0x23 && chord == NSEventModifierFlagShift) {
    return "commandPalette";
  }
  if (event.keyCode == 0x11 && chord == 0) return "newTerminal";
  if (event.keyCode == 0x7B && chord == NSEventModifierFlagOption) {
    return "focusPreviousPane";
  }
  if (event.keyCode == 0x7C && chord == NSEventModifierFlagOption) {
    return "focusNextPane";
  }
  if (chord != 0) return nullptr;

  switch (event.keyCode) {
    case 0x12: return "project.1";
    case 0x13: return "project.2";
    case 0x14: return "project.3";
    case 0x15: return "project.4";
    case 0x17: return "project.5";
    case 0x16: return "project.6";
    case 0x1A: return "project.7";
    case 0x1C: return "project.8";
    case 0x19: return "project.9";
    default: return nullptr;
  }
}

static bool embedderOwnsLifecycleKeyEquivalent(NSEvent *event) {
  const NSEventModifierFlags flags = event.modifierFlags &
      (NSEventModifierFlagShift | NSEventModifierFlagControl |
       NSEventModifierFlagOption | NSEventModifierFlagCommand);
  if ((flags & NSEventModifierFlagCommand) == 0 ||
      (flags & NSEventModifierFlagControl) != 0) return false;
  const NSEventModifierFlags chord = flags &
      (NSEventModifierFlagShift | NSEventModifierFlagOption);
  if (event.keyCode == 0x0C || event.keyCode == 0x2D) {
    return chord == 0;  // Cmd+Q and Cmd+N belong to Electron/AppKit.
  }
  return event.keyCode == 0x0D;  // Every Cmd+W variant is window lifecycle.
}

static bool isImageOnlyPasteKeyEquivalent(NSEvent *event) {
  const NSEventModifierFlags flags = event.modifierFlags &
      (NSEventModifierFlagShift | NSEventModifierFlagControl |
       NSEventModifierFlagOption | NSEventModifierFlagCommand);
  if (flags != NSEventModifierFlagCommand || event.keyCode != 0x09) {
    return false;
  }
  NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
  NSString *text = [pasteboard stringForType:NSPasteboardTypeString];
  return text.length == 0 && [NSImage canInitWithPasteboard:pasteboard];
}

// Budget for the whole Shift-release-Shift cycle. Must stay equal to
// DOUBLE_SHIFT_WINDOW_MS in src/renderer/command-surface.ts, which runs the
// same detection whenever the renderer rather than a native surface has focus.
static const NSTimeInterval kTermLoopDoubleShiftWindow = 0.5;

static void notifyShellShortcut(const char *shortcut) {
  if (shortcut == nullptr || g_shellShortcut == nullptr) return;
  auto *payload = new ShellShortcutPayload{shortcut};
  const napi_status status = g_shellShortcut->NonBlockingCall(
      payload, [](Napi::Env env, Napi::Function callback,
                  ShellShortcutPayload *value) {
        callback.Call({Napi::String::New(env, value->id)});
        delete value;
      });
  if (status != napi_ok) delete payload;
}

// ---------------------------------------------------------------------------
// TLGhosttyView: minimal AppKit host view for one surface
// ---------------------------------------------------------------------------

@interface TLGhosttyView : NSView <NSTextInputClient>
@property(nonatomic, assign) ghostty_surface_t surface;
@property(nonatomic, assign) BOOL surfaceFocused;
@property(nonatomic, assign) NSTimeInterval firstShiftDownAt;
@property(nonatomic, assign) BOOL shiftReleased;
@property(nonatomic, strong) NSMutableAttributedString *markedText;
@property(nonatomic, strong, nullable) NSMutableArray<NSString *> *keyTextAccumulator;
@property(nonatomic, weak, nullable) NSResponder *restorationResponder;
- (void)syncSurfaceSize;
- (void)focusSurface;
- (void)restoreFocusIfOwned;
@end

@implementation TLGhosttyView

- (instancetype)initWithFrame:(NSRect)frame {
  self = [super initWithFrame:frame];
  if (self) {
    self.wantsLayer = YES;
    self.layer.backgroundColor =
        [NSColor colorWithSRGBRed:0.157 green:0.173 blue:0.204 alpha:1.0]
            .CGColor;
    self.markedText = [[NSMutableAttributedString alloc] initWithString:@""];
    NSTrackingArea *area = [[NSTrackingArea alloc]
        initWithRect:NSZeroRect
             options:NSTrackingMouseMoved | NSTrackingActiveInKeyWindow |
                     NSTrackingInVisibleRect
               owner:self
            userInfo:nil];
    [self addTrackingArea:area];
  }
  return self;
}

- (BOOL)acceptsFirstResponder {
  return YES;
}

- (BOOL)isFlipped {
  return NO;
}

- (void)syncSurfaceSize {
  if (self.surface == nullptr) return;
  const CGFloat scale =
      self.window ? self.window.backingScaleFactor
                  : [NSScreen mainScreen].backingScaleFactor;
  ghostty_surface_set_content_scale(self.surface, scale, scale);
  const NSSize size = self.bounds.size;
  ghostty_surface_set_size(self.surface, (uint32_t)(size.width * scale),
                           (uint32_t)(size.height * scale));
}

- (void)setFrameSize:(NSSize)newSize {
  [super setFrameSize:newSize];
  [self syncSurfaceSize];
}

- (void)viewDidChangeBackingProperties {
  [super viewDidChangeBackingProperties];
  [self syncSurfaceSize];
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  [self syncSurfaceSize];
}

- (BOOL)becomeFirstResponder {
  const BOOL accepted = [super becomeFirstResponder];
  if (accepted && self.surface) ghostty_surface_set_focus(self.surface, true);
  self.surfaceFocused = accepted;
  return accepted;
}

- (BOOL)resignFirstResponder {
  const BOOL accepted = [super resignFirstResponder];
  if (accepted && self.surface) ghostty_surface_set_focus(self.surface, false);
  if (accepted) self.surfaceFocused = NO;
  return accepted;
}

- (void)focusSurface {
  NSWindow *window = self.window;
  if (window == nil || window.firstResponder == self) return;
  NSResponder *current = window.firstResponder;
  if ([current isKindOfClass:[TLGhosttyView class]]) {
    current = ((TLGhosttyView *)current).restorationResponder;
  }
  if (current != nil) self.restorationResponder = current;
  [window makeFirstResponder:self];
}

- (void)restoreFocusIfOwned {
  NSWindow *window = self.window;
  if (window == nil || window.firstResponder != self) return;
  NSResponder *responder = self.restorationResponder;
  self.restorationResponder = nil;
  if (responder != nil && [window makeFirstResponder:responder]) return;
  if ([window makeFirstResponder:self.superview]) return;
  [window makeFirstResponder:nil];
}

// -- keyboard / IME ---------------------------------------------------------

- (void)dispatchKeyEvent:(NSEvent *)event
        translationEvent:(NSEvent *)translationEvent
                  action:(ghostty_input_action_e)action
                    text:(nullable NSString *)textOverride
               composing:(BOOL)composing {
  if (self.surface == nullptr) return;

  ghostty_input_key_s key = {};
  key.action = action;
  key.mods = modsFromNSEvent(event.modifierFlags);
  key.consumed_mods = modsFromNSEvent(
      translationEvent.modifierFlags &
      ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));
  key.keycode = (uint32_t)event.keyCode;
  key.composing = composing;

  // AppKit modifier transitions are NSEventTypeFlagsChanged events. Character
  // accessors are invalid for that event type and raise an Objective-C
  // exception (terminating Electron). Modifier presses/releases carry no text,
  // so forward the physical key and modifier state directly.
  if (event.type == NSEventTypeFlagsChanged) {
    key.text = nullptr;
    key.unshifted_codepoint = 0;
    ghostty_surface_key(self.surface, key);
    return;
  }

  NSString *chars = textOverride ?: translationEvent.characters;
  // Electron's content-view event route can provide an empty `characters`
  // value even though AppKit can still translate the physical key. Legacy
  // keyboard mode can encode that key from its keycode, but Kitty's enhanced
  // protocol requires the translated text and otherwise drops printable keys.
  // Ask AppKit for the translation explicitly before falling back to the
  // unmodified codepoint below.
  if (chars.length == 0) {
    chars = [translationEvent
        charactersByApplyingModifiers:translationEvent.modifierFlags];
  }
  if (chars.length == 1 && [chars characterAtIndex:0] < 0x20) {
    chars = [translationEvent charactersByApplyingModifiers:
        translationEvent.modifierFlags & ~NSEventModifierFlagControl];
  }
  NSString *unshifted = [event charactersByApplyingModifiers:0];
  if (chars.length == 0) chars = unshifted;
  const char *text = nullptr;
  if (action != GHOSTTY_ACTION_RELEASE && chars.length > 0) {
    const unichar c0 = [chars characterAtIndex:0];
    // Suppress control/function characters; ghostty encodes those from
    // the keycode. Pass through printable text only.
    if (c0 >= 0x20 && c0 != 0x7f && !(c0 >= 0xF700 && c0 <= 0xF8FF)) {
      text = chars.UTF8String;
    }
  }
  key.text = text;

  if (unshifted.length > 0) {
    const unichar first = [unshifted characterAtIndex:0];
    if (CFStringIsSurrogateHighCharacter(first) && unshifted.length > 1) {
      key.unshifted_codepoint = CFStringGetLongCharacterForSurrogatePair(
          first, [unshifted characterAtIndex:1]);
    } else {
      key.unshifted_codepoint = first;
    }
  }

  ghostty_surface_key(self.surface, key);
}

- (void)keyDown:(NSEvent *)event {
  self.firstShiftDownAt = 0;
  self.shiftReleased = NO;
  const ghostty_input_action_e action =
      event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS;
  const BOOL markedBefore = self.markedText.length > 0;
  const ghostty_input_mods_e translatedMods =
      ghostty_surface_key_translation_mods(
          self.surface, modsFromNSEvent(event.modifierFlags));
  NSEventModifierFlags translatedFlags = event.modifierFlags;
  translatedFlags &= ~(NSEventModifierFlagShift | NSEventModifierFlagControl |
                       NSEventModifierFlagOption | NSEventModifierFlagCommand |
                       NSEventModifierFlagCapsLock);
  translatedFlags |= modsToNSEvent(translatedMods);
  NSEvent *translationEvent = event;
  if (translatedFlags != event.modifierFlags) {
    NSString *characters = [event charactersByApplyingModifiers:translatedFlags] ?: @"";
    translationEvent = [NSEvent keyEventWithType:event.type
                                        location:event.locationInWindow
                                   modifierFlags:translatedFlags
                                       timestamp:event.timestamp
                                    windowNumber:event.windowNumber
                                         context:nil
                                      characters:characters
                     charactersIgnoringModifiers:event.charactersIgnoringModifiers ?: @""
                                        isARepeat:event.isARepeat
                                          keyCode:event.keyCode] ?: event;
  }
  self.keyTextAccumulator = [NSMutableArray array];
  [self interpretKeyEvents:@[ translationEvent ]];
  NSArray<NSString *> *committed = [self.keyTextAccumulator copy];
  self.keyTextAccumulator = nil;
  [self syncPreedit:markedBefore];

  if (committed.count > 0) {
    for (NSString *text in committed) {
      [self dispatchKeyEvent:event
             translationEvent:translationEvent
                       action:action
                         text:text
                    composing:NO];
    }
  } else {
    [self dispatchKeyEvent:event
           translationEvent:translationEvent
                    action:action
                      text:nil
                 composing:(self.markedText.length > 0 || markedBefore)];
  }
}

- (void)keyUp:(NSEvent *)event {
  [self dispatchKeyEvent:event
         translationEvent:event
                  action:GHOSTTY_ACTION_RELEASE
                    text:nil
               composing:NO];
}

- (BOOL)performKeyEquivalent:(NSEvent *)event {
  if (self.surface == nullptr || event.type != NSEventTypeKeyDown ||
      self.window.firstResponder != self) {
    return [super performKeyEquivalent:event];
  }
  self.firstShiftDownAt = 0;
  self.shiftReleased = NO;

  // TermLoop owns shell navigation. Deliver these exact physical chords to
  // the renderer instead of allowing Ghostty's default tab/split bindings to
  // consume them while the native surface is first responder.
  if (const char *shortcut = termLoopShortcutForEvent(event)) {
    notifyShellShortcut(shortcut);
    return YES;
  }

  // A remote Agent cannot read the local AppKit pasteboard. Route an
  // image-only Cmd+V to Electron so it can upload the PNG and ask the daemon
  // to paste the resulting remote path into the active Agent composer. Text
  // and mixed-content pasteboards retain Ghostty's native paste behavior.
  if (isImageOnlyPasteKeyEquivalent(event)) {
    notifyShellShortcut("pasteImage");
    return YES;
  }

  // Ghostty's standalone defaults include window/process lifecycle bindings.
  // In the embedded renderer those operations belong to Electron. Give the
  // responder chain a chance to perform its menu action, then consume the key
  // even if no menu item exists so Cmd+W can never destroy only the surface.
  if (embedderOwnsLifecycleKeyEquivalent(event)) {
    [super performKeyEquivalent:event];
    return YES;
  }

  // AppKit routes command shortcuts here before the normal keyDown responder
  // path. Ask Ghostty whether the event is one of its bindings (Cmd+V paste,
  // Cmd+C copy, etc.) and, if so, feed it through the same keyboard path.
  ghostty_input_key_s key = {};
  key.action = GHOSTTY_ACTION_PRESS;
  key.mods = modsFromNSEvent(event.modifierFlags);
  key.consumed_mods = modsFromNSEvent(
      event.modifierFlags &
      ~(NSEventModifierFlagControl | NSEventModifierFlagCommand));
  key.keycode = (uint32_t)event.keyCode;
  NSString *chars = event.characters ?: @"";
  key.text = chars.UTF8String;
  NSString *unshifted = [event charactersByApplyingModifiers:0];
  if (unshifted.length > 0) key.unshifted_codepoint = [unshifted characterAtIndex:0];

  ghostty_binding_flags_e flags = {};
  if (!ghostty_surface_key_is_binding(self.surface, key, &flags)) {
    return [super performKeyEquivalent:event];
  }
  [self keyDown:event];
  return YES;
}

- (void)flagsChanged:(NSEvent *)event {
  NSUInteger mask = 0;
  switch (event.keyCode) {
    case 0x39: mask = NSEventModifierFlagCapsLock; break;
    case 0x38: mask = NX_DEVICELSHIFTKEYMASK; break;
    case 0x3C: mask = NX_DEVICERSHIFTKEYMASK; break;
    case 0x3B: mask = NX_DEVICELCTLKEYMASK; break;
    case 0x3E: mask = NX_DEVICERCTLKEYMASK; break;
    case 0x3A: mask = NX_DEVICELALTKEYMASK; break;
    case 0x3D: mask = NX_DEVICERALTKEYMASK; break;
    case 0x37: mask = NX_DEVICELCMDKEYMASK; break;
    case 0x36: mask = NX_DEVICERCMDKEYMASK; break;
    default: return;
  }
  if (self.markedText.length > 0) return;
  const ghostty_input_action_e action =
      ((NSUInteger)event.modifierFlags & mask) != 0
          ? GHOSTTY_ACTION_PRESS
          : GHOSTTY_ACTION_RELEASE;
  [self dispatchKeyEvent:event
         translationEvent:event
                   action:action
                     text:nil
                composing:NO];

  const BOOL isShift = event.keyCode == 0x38 || event.keyCode == 0x3C;
  const NSEventModifierFlags conflictingModifiers = event.modifierFlags &
      (NSEventModifierFlagControl | NSEventModifierFlagOption |
       NSEventModifierFlagCommand);
  if (!isShift || conflictingModifiers != 0) {
    self.firstShiftDownAt = 0;
    self.shiftReleased = NO;
  } else if (action == GHOSTTY_ACTION_PRESS) {
    if (self.firstShiftDownAt > 0 && self.shiftReleased &&
        event.timestamp - self.firstShiftDownAt <= kTermLoopDoubleShiftWindow) {
      self.firstShiftDownAt = 0;
      self.shiftReleased = NO;
      notifyShellShortcut("quickAction");
    } else {
      self.firstShiftDownAt = event.timestamp;
      self.shiftReleased = NO;
    }
  } else if (self.firstShiftDownAt > 0) {
    if (event.timestamp - self.firstShiftDownAt <= kTermLoopDoubleShiftWindow) {
      self.shiftReleased = YES;
    } else {
      self.firstShiftDownAt = 0;
      self.shiftReleased = NO;
    }
  }
}

- (BOOL)hasMarkedText {
  return self.markedText.length > 0;
}

- (NSRange)markedRange {
  return self.markedText.length > 0
             ? NSMakeRange(0, self.markedText.length)
             : NSMakeRange(NSNotFound, 0);
}

- (NSRange)selectedRange {
  return NSMakeRange(NSNotFound, 0);
}

- (void)setMarkedText:(id)value
         selectedRange:(NSRange)selectedRange
        replacementRange:(NSRange)replacementRange {
  (void)selectedRange;
  (void)replacementRange;
  if ([value isKindOfClass:[NSAttributedString class]]) {
    self.markedText = [[NSMutableAttributedString alloc]
        initWithAttributedString:(NSAttributedString *)value];
  } else if ([value isKindOfClass:[NSString class]]) {
    self.markedText =
        [[NSMutableAttributedString alloc] initWithString:(NSString *)value];
  } else {
    return;
  }
  if (self.keyTextAccumulator == nil) [self syncPreedit:YES];
}

- (void)unmarkText {
  if (self.markedText.length == 0) return;
  [self.markedText.mutableString setString:@""];
  [self syncPreedit:YES];
}

- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText {
  return @[];
}

- (nullable NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range
                                                          actualRange:(NSRangePointer)actualRange {
  (void)range;
  if (actualRange) *actualRange = NSMakeRange(NSNotFound, 0);
  return nil;
}

- (NSUInteger)characterIndexForPoint:(NSPoint)point {
  (void)point;
  return 0;
}

- (NSRect)firstRectForCharacterRange:(NSRange)range
                          actualRange:(NSRangePointer)actualRange {
  if (actualRange) *actualRange = range;
  double x = 0, y = 0, width = 0, height = 0;
  if (self.surface)
    ghostty_surface_ime_point(self.surface, &x, &y, &width, &height);
  NSRect rect = NSMakeRect(x, self.bounds.size.height - y - height,
                           width, height);
  rect = [self convertRect:rect toView:nil];
  return self.window ? [self.window convertRectToScreen:rect] : rect;
}

- (void)insertText:(id)value replacementRange:(NSRange)replacementRange {
  (void)replacementRange;
  NSString *text = nil;
  if ([value isKindOfClass:[NSAttributedString class]])
    text = ((NSAttributedString *)value).string;
  else if ([value isKindOfClass:[NSString class]])
    text = (NSString *)value;
  if (text == nil) return;

  [self unmarkText];
  if (self.keyTextAccumulator != nil) {
    [self.keyTextAccumulator addObject:text];
  } else if (self.surface != nullptr) {
    const NSData *utf8 = [text dataUsingEncoding:NSUTF8StringEncoding];
    ghostty_surface_text(self.surface, (const char *)utf8.bytes, utf8.length);
  }
}

- (void)doCommandBySelector:(SEL)selector {
  // Required by NSTextInputClient. Unhandled selectors must not bubble to
  // NSResponder because that produces an audible beep; Ghostty still receives
  // the original key event from keyDown.
  (void)selector;
}

- (void)syncPreedit:(BOOL)clearIfNeeded {
  if (self.surface == nullptr) return;
  if (self.markedText.length > 0) {
    NSData *utf8 = [self.markedText.string dataUsingEncoding:NSUTF8StringEncoding];
    ghostty_surface_preedit(self.surface, (const char *)utf8.bytes, utf8.length);
  } else if (clearIfNeeded) {
    ghostty_surface_preedit(self.surface, nullptr, 0);
  }
}

// -- mouse ------------------------------------------------------------------

- (void)reportMousePos:(NSEvent *)event {
  if (self.surface == nullptr) return;
  const NSPoint p = [self convertPoint:event.locationInWindow fromView:nil];
  // Embedded Ghostty applies the content scale internally. AppKit points are
  // therefore the correct unit here (the prior pixel conversion double-scaled
  // input on Retina displays).
  const double x = p.x;
  const double y = self.bounds.size.height - p.y;
  ghostty_surface_mouse_pos(self.surface, x, y,
                            modsFromNSEvent(event.modifierFlags));
}

- (void)mouseDown:(NSEvent *)event {
  [self focusSurface];
  [self reportMousePos:event];
  if (self.surface)
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS,
                                 GHOSTTY_MOUSE_LEFT,
                                 modsFromNSEvent(event.modifierFlags));
}

- (void)mouseUp:(NSEvent *)event {
  [self reportMousePos:event];
  if (self.surface)
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE,
                                 GHOSTTY_MOUSE_LEFT,
                                 modsFromNSEvent(event.modifierFlags));
}

- (void)rightMouseDown:(NSEvent *)event {
  [self reportMousePos:event];
  if (self.surface)
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_PRESS,
                                 GHOSTTY_MOUSE_RIGHT,
                                 modsFromNSEvent(event.modifierFlags));
}

- (void)rightMouseUp:(NSEvent *)event {
  [self reportMousePos:event];
  if (self.surface)
    ghostty_surface_mouse_button(self.surface, GHOSTTY_MOUSE_RELEASE,
                                 GHOSTTY_MOUSE_RIGHT,
                                 modsFromNSEvent(event.modifierFlags));
}

- (void)mouseMoved:(NSEvent *)event {
  [self reportMousePos:event];
}

- (void)mouseDragged:(NSEvent *)event {
  [self reportMousePos:event];
}

- (void)scrollWheel:(NSEvent *)event {
  if (self.surface == nullptr) return;
  [self reportMousePos:event];
  double dx = event.scrollingDeltaX;
  double dy = event.scrollingDeltaY;
  ghostty_input_scroll_mods_t mods = 0;
  if (event.hasPreciseScrollingDeltas) mods |= 1; // precision bit
  ghostty_input_mouse_momentum_e momentum = GHOSTTY_MOUSE_MOMENTUM_NONE;
  switch (event.momentumPhase) {
    case NSEventPhaseBegan: momentum = GHOSTTY_MOUSE_MOMENTUM_BEGAN; break;
    case NSEventPhaseStationary: momentum = GHOSTTY_MOUSE_MOMENTUM_STATIONARY; break;
    case NSEventPhaseChanged: momentum = GHOSTTY_MOUSE_MOMENTUM_CHANGED; break;
    case NSEventPhaseEnded: momentum = GHOSTTY_MOUSE_MOMENTUM_ENDED; break;
    case NSEventPhaseCancelled: momentum = GHOSTTY_MOUSE_MOMENTUM_CANCELLED; break;
    case NSEventPhaseMayBegin: momentum = GHOSTTY_MOUSE_MOMENTUM_MAY_BEGIN; break;
    default: break;
  }
  mods |= ((ghostty_input_scroll_mods_t)momentum) << 1;
  ghostty_surface_mouse_scroll(self.surface, dx, dy, mods);
}

@end

static ghostty_surface_t surfaceFromUserdata(void *userdata) {
  if (userdata == nullptr) return nullptr;
  TLGhosttyView *view = (__bridge TLGhosttyView *)userdata;
  return view.surface;
}

// ---------------------------------------------------------------------------
// Surface registry
// ---------------------------------------------------------------------------

struct SurfaceEntry {
  ghostty_surface_t surface = nullptr;
  __strong TLGhosttyView *view = nil;
  SurfaceCallbackContext *callbacks = nullptr;
};

// No C++ globals with dynamic constructors: node addon bundles link with
// -undefined dynamic_lookup and the Xcode 26 linker cannot materialize
// ___dso_handle for static-init atexit registration.
static std::map<uint32_t, SurfaceEntry> &surfaces() {
  static std::map<uint32_t, SurfaceEntry> *map =
      new std::map<uint32_t, SurfaceEntry>();
  return *map;
}
static uint32_t g_nextSurfaceId = 1;

static NSView *contentViewFromHandle(Napi::Buffer<uint8_t> handle) {
  // Electron's getNativeWindowHandle() returns the NSView* of the window
  // content view, stored raw in a 8-byte buffer.
  if (handle.Length() != sizeof(void *)) return nil;
  void *ptr = nullptr;
  memcpy(&ptr, handle.Data(), sizeof(void *));
  return (__bridge NSView *)ptr;
}

static SurfaceEntry *entryForId(uint32_t id) {
  auto it = surfaces().find(id);
  return it == surfaces().end() ? nullptr : &it->second;
}

static void notifySurfaceClosed(TLGhosttyView *view) {
  if (g_surfaceClosed == nullptr) return;
  uint32_t id = 0;
  for (const auto &item : surfaces()) {
    if (item.second.view == view) {
      id = item.first;
      break;
    }
  }
  if (id == 0) return;
  uint32_t *payload = new uint32_t(id);
  const napi_status status = g_surfaceClosed->NonBlockingCall(
      payload, [](Napi::Env env, Napi::Function callback, uint32_t *value) {
        callback.Call({Napi::Number::New(env, *value)});
        delete value;
      });
  if (status != napi_ok) delete payload;
}

// Convert web-content coordinates (top-left origin, DIP) to an AppKit
// frame in the parent view (bottom-left origin).
static NSRect appkitFrame(NSView *parent, double x, double y, double w,
                          double h) {
  const CGFloat parentH = parent.bounds.size.height;
  return NSMakeRect(x, parentH - y - h, w, h);
}

static bool setCloseOnExec(int fd) {
  const int flags = fcntl(fd, F_GETFD);
  return flags >= 0 && fcntl(fd, F_SETFD, flags | FD_CLOEXEC) == 0;
}

// ---------------------------------------------------------------------------
// N-API bindings
// ---------------------------------------------------------------------------

static Napi::Value InitApp(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (g_app != nullptr) return env.Undefined();

  if (ghostty_init(0, nullptr) != 0) {
    Napi::Error::New(env, "ghostty_init failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Deterministic config: do NOT load the user's Ghostty config files.
  g_config = ghostty_config_new();
  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("onSurfaceClosed") && opts.Get("onSurfaceClosed").IsFunction()) {
      g_surfaceClosed = new Napi::ThreadSafeFunction(
          Napi::ThreadSafeFunction::New(
              env, opts.Get("onSurfaceClosed").As<Napi::Function>(),
              "GhosttySurfaceClosed", 0, 1));
    }
    if (opts.Has("onOutputConsumed") && opts.Get("onOutputConsumed").IsFunction()) {
      g_surfaceConsumed = new Napi::ThreadSafeFunction(
          Napi::ThreadSafeFunction::New(
              env, opts.Get("onOutputConsumed").As<Napi::Function>(),
              "GhosttyOutputConsumed", 0, 1));
    }
    if (opts.Has("onShellShortcut") && opts.Get("onShellShortcut").IsFunction()) {
      g_shellShortcut = new Napi::ThreadSafeFunction(
          Napi::ThreadSafeFunction::New(
              env, opts.Get("onShellShortcut").As<Napi::Function>(),
              "GhosttyShellShortcut", 0, 1));
    }
    if (opts.Has("configFile")) {
      std::string path = opts.Get("configFile").As<Napi::String>();
      ghostty_config_load_file(g_config, path.c_str());
    }
  }
  ghostty_config_finalize(g_config);
  const uint32_t diagnosticCount = ghostty_config_diagnostics_count(g_config);
  if (diagnosticCount > 0) {
    const ghostty_diagnostic_s diagnostic =
        ghostty_config_get_diagnostic(g_config, 0);
    const std::string message = diagnostic.message
        ? std::string("invalid embedded Ghostty config: ") + diagnostic.message
        : "invalid embedded Ghostty config";
    ghostty_config_free(g_config);
    g_config = nullptr;
    Napi::Error::New(env, message).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_runtime_config_s runtime = {};
  runtime.userdata = nullptr;
  runtime.supports_selection_clipboard = false;
  runtime.wakeup_cb = wakeupCallback;
  runtime.action_cb = actionCallback;
  runtime.read_clipboard_cb = readClipboardCallback;
  runtime.confirm_read_clipboard_cb = confirmReadClipboardCallback;
  runtime.write_clipboard_cb = writeClipboardCallback;
  runtime.close_surface_cb = closeSurfaceCallback;

  g_app = ghostty_app_new(&runtime, g_config);
  if (g_app == nullptr) {
    Napi::Error::New(env, "ghostty_app_new failed")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_app_set_focus(g_app, true);
  return env.Undefined();
}

// createSurface({handle, x, y, width, height}) -> {id, hostFd, rows, cols}
static Napi::Value CreateSurface(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (g_app == nullptr) {
    Napi::Error::New(env, "initApp not called").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  NSView *parent =
      contentViewFromHandle(opts.Get("handle").As<Napi::Buffer<uint8_t>>());
  if (parent == nil) {
    Napi::Error::New(env, "bad native window handle")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const double x = opts.Get("x").As<Napi::Number>().DoubleValue();
  const double y = opts.Get("y").As<Napi::Number>().DoubleValue();
  const double w = opts.Get("width").As<Napi::Number>().DoubleValue();
  const double h = opts.Get("height").As<Napi::Number>().DoubleValue();

  // The IO socketpair. fds[0] -> ghostty (ownership transfers with the
  // surface config), fds[1] -> returned to JS for net.Socket wrapping.
  int fds[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) {
    Napi::Error::New(env, "socketpair failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!setCloseOnExec(fds[0]) || !setCloseOnExec(fds[1])) {
    close(fds[0]);
    close(fds[1]);
    Napi::Error::New(env, "failed to set socketpair CLOEXEC")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  TLGhosttyView *view =
      [[TLGhosttyView alloc] initWithFrame:appkitFrame(parent, x, y, w, h)];
  view.autoresizingMask = NSViewNotSizable;
  [parent addSubview:view];

  const CGFloat scale = parent.window
                            ? parent.window.backingScaleFactor
                            : [NSScreen mainScreen].backingScaleFactor;

  const uint32_t id = g_nextSurfaceId++;
  auto *callbacks = new SurfaceCallbackContext{id};
  ghostty_surface_config_s cfg = ghostty_surface_config_new();
  cfg.platform_tag = GHOSTTY_PLATFORM_MACOS;
  cfg.platform.macos.nsview = (__bridge void *)view;
  cfg.userdata = (__bridge void *)view;
  cfg.scale_factor = scale;
  cfg.external_io_fd = fds[0];
  cfg.external_io_consumed_cb = externalIoConsumedCallback;
  cfg.external_io_userdata = callbacks;

  ghostty_surface_t surface = ghostty_surface_new(g_app, &cfg);
  // The external backend duplicates the descriptor synchronously. The addon
  // retains ownership of the supplied descriptor on both success and failure.
  close(fds[0]);
  if (surface == nullptr) {
    callbacks->alive.store(false, std::memory_order_release);
    delete callbacks;
    [view removeFromSuperview];
    close(fds[1]);
    Napi::Error::New(env, "ghostty_surface_new failed")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  view.surface = surface;
  [view syncSurfaceSize];

  surfaces()[id] = SurfaceEntry{surface, view, callbacks};

  const ghostty_surface_size_s size = ghostty_surface_size(surface);
  Napi::Object result = Napi::Object::New(env);
  result.Set("id", Napi::Number::New(env, id));
  result.Set("hostFd", Napi::Number::New(env, fds[1]));
  result.Set("rows", Napi::Number::New(env, size.rows));
  result.Set("cols", Napi::Number::New(env, size.columns));
  return result;
}

static Napi::Value SetSurfaceFrame(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr) return env.Undefined();
  const double x = info[1].As<Napi::Number>().DoubleValue();
  const double y = info[2].As<Napi::Number>().DoubleValue();
  const double w = info[3].As<Napi::Number>().DoubleValue();
  const double h = info[4].As<Napi::Number>().DoubleValue();
  e->view.frame = appkitFrame(e->view.superview, x, y, w, h);
  [e->view syncSurfaceSize];
  const ghostty_surface_size_s size = ghostty_surface_size(e->surface);
  Napi::Object result = Napi::Object::New(env);
  result.Set("rows", Napi::Number::New(env, size.rows));
  result.Set("cols", Napi::Number::New(env, size.columns));
  return result;
}

static Napi::Value SetSurfaceVisible(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr) return env.Undefined();
  const bool visible = info[1].As<Napi::Boolean>().Value();
  if (!visible) [e->view restoreFocusIfOwned];
  e->view.hidden = !visible;
  // Despite the API name, Ghostty expects whether the surface is visible,
  // matching NSWindow.occlusionState.contains(.visible). Passing the inverse
  // leaves the native view present while pausing its renderer.
  ghostty_surface_set_occlusion(e->surface, visible);
  if (visible) {
    // Unhiding an embedded CAMetalLayer does not itself guarantee that its
    // drawable is repainted. In particular, reopening the desktop window can
    // expose the last partially presented atlas until an AppKit resize forces
    // a synchronous draw. Refreshing only schedules work on Ghostty's render
    // loop; draw now gives the newly visible layer the same full repaint that
    // a window resize would have triggered.
    ghostty_surface_draw(e->surface);
  }
  return env.Undefined();
}

static Napi::Value SetSurfaceColorScheme(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr) return env.Undefined();
  const std::string theme = info[1].As<Napi::String>();
  ghostty_color_scheme_e scheme;
  if (theme == "light") {
    scheme = GHOSTTY_COLOR_SCHEME_LIGHT;
  } else if (theme == "dark") {
    scheme = GHOSTTY_COLOR_SCHEME_DARK;
  } else {
    Napi::TypeError::New(env, "theme must be light or dark")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  ghostty_surface_set_color_scheme(e->surface, scheme);
  ghostty_surface_draw(e->surface);
  return env.Undefined();
}

static Napi::Value FocusSurface(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr) return env.Undefined();
  [e->view focusSurface];
  return env.Undefined();
}

static Napi::Value SurfaceSize(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr) return env.Undefined();
  const ghostty_surface_size_s size = ghostty_surface_size(e->surface);
  Napi::Object result = Napi::Object::New(env);
  result.Set("rows", Napi::Number::New(env, size.rows));
  result.Set("cols", Napi::Number::New(env, size.columns));
  result.Set("cellWidthPx", Napi::Number::New(env, size.cell_width_px));
  result.Set("cellHeightPx", Napi::Number::New(env, size.cell_height_px));
  result.Set("widthPx", Napi::Number::New(env, size.width_px));
  result.Set("heightPx", Napi::Number::New(env, size.height_px));
  return result;
}

// Match Ghostty's official macOS SurfaceView.asImage implementation. This
// captures the already-rendered AppKit view without reinterpreting terminal
// bytes or duplicating Ghostty's renderer in JavaScript.
static Napi::Value SurfacePng(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr || e->view.bounds.size.width <= 0 ||
      e->view.bounds.size.height <= 0) return env.Undefined();
  NSBitmapImageRep *bitmap =
      [e->view bitmapImageRepForCachingDisplayInRect:e->view.bounds];
  if (bitmap == nil) return env.Undefined();
  [e->view cacheDisplayInRect:e->view.bounds toBitmapImageRep:bitmap];
  NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG
                                      properties:@{}];
  if (png == nil || png.length == 0) return env.Undefined();
  return Napi::Buffer<uint8_t>::Copy(
      env, static_cast<const uint8_t *>(png.bytes), png.length);
}

// Diagnostics: read back rendered text so the harness can assert the
// round trip without screenshots (mirrors the TerminalSurface probe).
static Napi::Value SurfaceText(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr) return env.Undefined();
  ghostty_text_s text = {};
  ghostty_selection_s sel = {};
  sel.top_left.tag = GHOSTTY_POINT_SCREEN;
  sel.top_left.coord = GHOSTTY_POINT_COORD_TOP_LEFT;
  sel.bottom_right.tag = GHOSTTY_POINT_SCREEN;
  sel.bottom_right.coord = GHOSTTY_POINT_COORD_BOTTOM_RIGHT;
  sel.rectangle = false;
  if (!ghostty_surface_read_text(e->surface, sel, &text)) {
    return env.Undefined();
  }
  Napi::String result =
      Napi::String::New(env, text.text ? text.text : "", text.text_len);
  ghostty_surface_free_text(e->surface, &text);
  return result;
}

// Diagnostics: exercise NSTextInputClient marked-text and commit handling,
// then verify Ghostty's input encoding through the external backend fd.
static Napi::Value SendText(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  SurfaceEntry *e =
      entryForId(info[0].As<Napi::Number>().Uint32Value());
  if (e == nullptr) return env.Undefined();
  std::string text = info[1].As<Napi::String>();
  NSString *value = [[NSString alloc] initWithBytes:text.data()
                                             length:text.size()
                                           encoding:NSUTF8StringEncoding];
  if (value == nil) return env.Undefined();
  [e->view setMarkedText:value
           selectedRange:NSMakeRange(value.length, 0)
         replacementRange:NSMakeRange(NSNotFound, 0)];
  [e->view insertText:value replacementRange:NSMakeRange(NSNotFound, 0)];
  return env.Undefined();
}

static Napi::Value DestroySurface(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  const uint32_t id = info[0].As<Napi::Number>().Uint32Value();
  SurfaceEntry *e = entryForId(id);
  if (e == nullptr) return env.Undefined();
  [e->view restoreFocusIfOwned];
  e->view.surface = nullptr;
  e->callbacks->alive.store(false, std::memory_order_release);
  ghostty_surface_free(e->surface);
  delete e->callbacks;
  [e->view removeFromSuperview];
  surfaces().erase(id);
  return env.Undefined();
}

static Napi::Value SurfaceCount(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), (double)surfaces().size());
}

static Napi::Value Tick(const Napi::CallbackInfo &info) {
  tickApp();
  return info.Env().Undefined();
}

static void CleanupAddon() {
  for (auto &item : surfaces()) {
    SurfaceEntry &entry = item.second;
    entry.view.surface = nullptr;
    entry.callbacks->alive.store(false, std::memory_order_release);
    ghostty_surface_free(entry.surface);
    delete entry.callbacks;
    [entry.view removeFromSuperview];
  }
  surfaces().clear();
  if (g_surfaceClosed != nullptr) {
    g_surfaceClosed->Release();
    delete g_surfaceClosed;
    g_surfaceClosed = nullptr;
  }
  if (g_surfaceConsumed != nullptr) {
    g_surfaceConsumed->Release();
    delete g_surfaceConsumed;
    g_surfaceConsumed = nullptr;
  }
  if (g_shellShortcut != nullptr) {
    g_shellShortcut->Release();
    delete g_shellShortcut;
    g_shellShortcut = nullptr;
  }
  if (g_app != nullptr) {
    ghostty_app_free(g_app);
    g_app = nullptr;
  }
  if (g_config != nullptr) {
    ghostty_config_free(g_config);
    g_config = nullptr;
  }
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  env.AddCleanupHook(CleanupAddon);
  exports.Set("initApp", Napi::Function::New(env, InitApp));
  exports.Set("createSurface", Napi::Function::New(env, CreateSurface));
  exports.Set("setSurfaceFrame", Napi::Function::New(env, SetSurfaceFrame));
  exports.Set("setSurfaceVisible",
              Napi::Function::New(env, SetSurfaceVisible));
  exports.Set("setSurfaceColorScheme",
              Napi::Function::New(env, SetSurfaceColorScheme));
  exports.Set("focusSurface", Napi::Function::New(env, FocusSurface));
  exports.Set("surfaceSize", Napi::Function::New(env, SurfaceSize));
  exports.Set("surfacePng", Napi::Function::New(env, SurfacePng));
  exports.Set("surfaceText", Napi::Function::New(env, SurfaceText));
  exports.Set("sendText", Napi::Function::New(env, SendText));
  exports.Set("destroySurface", Napi::Function::New(env, DestroySurface));
  exports.Set("surfaceCount", Napi::Function::New(env, SurfaceCount));
  exports.Set("tick", Napi::Function::New(env, Tick));
  return exports;
}

NODE_API_MODULE(ghostty_host, Init)
