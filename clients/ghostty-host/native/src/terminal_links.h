#import <AppKit/AppKit.h>
#include <ghostty.h>

// A link click belongs to this desktop, even when the PTY application captures
// the mouse. Keep both button edges out of the PTY so a remote TUI cannot also
// launch its own browser on mouse-down.
@interface TLTerminalLinks : NSObject
@property(nonatomic, copy) NSString *hoveredURL;
@property(nonatomic, strong) NSURL *pressedURL;
@property(nonatomic, assign) NSPoint pressedPoint;
@property(nonatomic, assign) BOOL cancelled;
- (BOOL)mouseDown:(ghostty_surface_t)surface point:(NSPoint)point mods:(ghostty_input_mods_e)mods;
- (BOOL)mouseUp:(ghostty_surface_t)surface point:(NSPoint)point;
- (BOOL)mouseDragged:(NSPoint)point;
- (void)openURL:(NSURL *)url;
@end

@implementation TLTerminalLinks
- (NSURL *)webURL {
  NSString *text = self.hoveredURL;
  if (text.length == 0 || text.length > 8192 ||
      [text rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return nil;
  NSURL *url = [NSURL URLWithString:text];
  NSString *scheme = url.scheme.lowercaseString;
  if ((![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) ||
      url.host.length == 0 || url.user != nil || url.password != nil) return nil;
  return url;
}

- (void)probe:(ghostty_surface_t)surface point:(NSPoint)point {
  // Shift releases Ghostty's mouse capture; it is removed from link modifiers
  // by Ghostty when capture is active. Cmd selects both detected and OSC 8 URLs.
  ghostty_input_mods_e mods = GHOSTTY_MODS_SUPER;
  if (ghostty_surface_mouse_captured(surface)) {
    mods = (ghostty_input_mods_e)(mods | GHOSTTY_MODS_SHIFT);
  }
  ghostty_surface_mouse_pos(surface, point.x, point.y, mods);
}

- (BOOL)mouseDown:(ghostty_surface_t)surface point:(NSPoint)point mods:(ghostty_input_mods_e)mods {
  self.pressedURL = nil;
  self.cancelled = NO;
  // Leave selection-extension and other modified gestures with the terminal.
  if (mods != GHOSTTY_MODS_NONE && mods != GHOSTTY_MODS_SUPER) return NO;
  [self probe:surface point:point];
  NSURL *url = [self webURL];
  if (!url) return NO;
  self.pressedURL = url;
  self.pressedPoint = point;
  return YES;
}

- (BOOL)mouseDragged:(NSPoint)point {
  if (!self.pressedURL) return NO;
  if (hypot(point.x - self.pressedPoint.x, point.y - self.pressedPoint.y) > 4) self.cancelled = YES;
  return YES;
}

- (BOOL)mouseUp:(ghostty_surface_t)surface point:(NSPoint)point {
  NSURL *pressed = self.pressedURL;
  if (!pressed) return NO;
  [self mouseDragged:point];
  [self probe:surface point:point];
  BOOL open = !self.cancelled && [pressed isEqual:[self webURL]];
  self.pressedURL = nil;
  if (open) [self openURL:pressed];
  return YES;
}

- (void)openURL:(NSURL *)url {
  // AppKit opens on the machine displaying the surface, with no daemon call.
  dispatch_async(dispatch_get_main_queue(), ^{
    [[NSWorkspace sharedWorkspace] openURL:url];
  });
}
@end
