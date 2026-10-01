#import "src/terminal_links.h"
#include <atomic>
#include <cassert>
#include <fcntl.h>
#include <initializer_list>
#include <sys/socket.h>
#include <unistd.h>

@interface TestLinks : TLTerminalLinks
@property(nonatomic, strong) NSURL *opened;
@property(nonatomic, assign) NSUInteger openCount;
@end
@implementation TestLinks
- (void)openURL:(NSURL *)url { self.opened = url; self.openCount++; }
@end

static void wakeup(void *) {}
static bool action(ghostty_app_t, ghostty_target_s target, ghostty_action_s value) {
  if (target.tag == GHOSTTY_TARGET_SURFACE && value.tag == GHOSTTY_ACTION_MOUSE_OVER_LINK) {
    TLTerminalLinks *links = (__bridge TLTerminalLinks *)ghostty_surface_userdata(target.target.surface);
    auto link = value.action.mouse_over_link;
    links.hoveredURL = [[NSString alloc] initWithBytes:link.url length:link.len encoding:NSUTF8StringEncoding];
  }
  return true;
}
static bool readClipboard(void *, ghostty_clipboard_e, void *) { return false; }
static void confirmClipboard(void *, const char *, void *, ghostty_clipboard_request_e) {}
static void writeClipboard(void *, ghostty_clipboard_e, const ghostty_clipboard_content_s *, size_t, bool) {}
static void closeSurface(void *, bool) {}
static void consumed(void *context, size_t count) { static_cast<std::atomic<size_t> *>(context)->fetch_add(count); }

static void check(ghostty_app_t app, int capture, bool osc8, ghostty_input_mods_e mods) {
  NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 800, 600)];
  TestLinks *links = [TestLinks new];
  int sockets[2];
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  std::atomic<size_t> processed{0};
  ghostty_surface_config_s config = ghostty_surface_config_new();
  config.platform_tag = GHOSTTY_PLATFORM_MACOS;
  config.platform.macos.nsview = (__bridge void *)view;
  config.userdata = (__bridge void *)links;
  config.scale_factor = 1;
  config.font_size = 16;
  config.external_io_fd = sockets[0];
  config.external_io_consumed_cb = consumed;
  config.external_io_userdata = &processed;
  ghostty_surface_t surface = ghostty_surface_new(app, &config);
  close(sockets[0]);
  assert(surface);
  NSString *output = [NSString stringWithFormat:@"\033[2J\033[H%@%@",
      capture ? [NSString stringWithFormat:@"\033[?%dh\033[?1006h", capture] : @"",
      osc8 ? @"\033]8;;https://example.com/auth?state=test#finish\033\\Sign in\033]8;;\033\\"
           : @"https://example.com/auth?state=test#finish"];
  NSData *bytes = [output dataUsingEncoding:NSUTF8StringEncoding];
  assert(write(sockets[1], bytes.bytes, bytes.length) == (ssize_t)bytes.length);
  for (int i = 0; i < 1000 && processed.load() < bytes.length; ++i) usleep(1000);
  assert(processed.load() == bytes.length);
  fcntl(sockets[1], F_SETFL, O_NONBLOCK);
  auto size = ghostty_surface_size(surface);
  NSPoint point = NSMakePoint(size.cell_width_px * 2.5, size.cell_height_px * .5);
  assert([links mouseDown:surface point:point mods:mods]);
  assert(links.openCount == 0);
  assert([links mouseUp:surface point:point]);
  assert(links.openCount == 1);
  assert([links.opened.absoluteString isEqualToString:@"https://example.com/auth?state=test#finish"]);
  usleep(20000);
  char input[1024];
  ssize_t count = read(sockets[1], input, sizeof(input) - 1);
  if (capture == 1003 && count > 0) {
    // All-motion tracking can still report hover, but never either click edge.
    input[count] = '\0';
    const char *cursor = input;
    while (*cursor) {
      int code, column, row, length = 0;
      char suffix;
      assert(sscanf(cursor, "\033[<%d;%d;%d%c%n", &code, &column, &row, &suffix, &length) == 4);
      assert((code & 32) != 0 && suffix == 'M');
      cursor += length;
    }
  } else assert(count == -1 && errno == EAGAIN);

  // Dragging a URL cancels opening and consumes the corresponding release.
  assert([links mouseDown:surface point:point mods:mods]);
  assert([links mouseDragged:NSMakePoint(point.x + 10, point.y)]);
  assert([links mouseUp:surface point:point]);
  assert(links.openCount == 1);
  assert(![links mouseUp:surface point:point]);

  // Plain text and selection gestures remain available to the terminal.
  NSPoint blank = NSMakePoint(point.x, size.cell_height_px * 2.5);
  assert(![links mouseDown:surface point:blank mods:mods]);
  ghostty_surface_mouse_pos(surface, blank.x, blank.y, GHOSTTY_MODS_NONE);
  ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, GHOSTTY_MODS_NONE);
  ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, GHOSTTY_MODS_NONE);
  usleep(20000);
  if (capture) assert(read(sockets[1], input, sizeof(input)) > 0);
  assert(![links mouseDown:surface point:point mods:GHOSTTY_MODS_SHIFT]);
  ghostty_surface_free(surface);
  close(sockets[1]);
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    assert(ghostty_init(0, nullptr) == 0);
    ghostty_config_t config = ghostty_config_new();
    ghostty_config_finalize(config);
    ghostty_runtime_config_s runtime = {};
    runtime.wakeup_cb = wakeup;
    runtime.action_cb = action;
    runtime.read_clipboard_cb = readClipboard;
    runtime.confirm_read_clipboard_cb = confirmClipboard;
    runtime.write_clipboard_cb = writeClipboard;
    runtime.close_surface_cb = closeSurface;
    ghostty_app_t app = ghostty_app_new(&runtime, config);
    assert(app);
    for (int capture : {0, 1000, 1002, 1003}) {
      for (bool osc8 : {false, true}) {
        for (auto mods : {GHOSTTY_MODS_NONE, GHOSTTY_MODS_SUPER}) check(app, capture, osc8, mods);
      }
    }
    TestLinks *links = [TestLinks new];
    for (NSString *url in @[@"file:///tmp/test", @"javascript:alert(1)", @"https://user:pass@example.com", @"https://example.com/\n"]) {
      links.hoveredURL = url;
      assert([links webURL] == nil);
    }
    ghostty_app_free(app);
    ghostty_config_free(config);
  }
}
