#import <Cocoa/Cocoa.h>
#include <ghostty.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

// This fixture never shows a window or resizes a surface. A later resize must
// not be able to hide an incorrect initial VT grid.
static void wakeup(void *unused) {}
static bool action(ghostty_app_t app, ghostty_target_s target, ghostty_action_s value) { return false; }
static bool read_clipboard(void *u, ghostty_clipboard_e c, void *state) { return false; }
static void confirm_clipboard(void *u, const char *text, void *state, ghostty_clipboard_request_e request) {}
static void write_clipboard(void *u, ghostty_clipboard_e c, const ghostty_clipboard_content_s *data, size_t count, bool confirm) {}
static void close_surface(void *u, bool alive) {}
static void consumed(void *context, size_t count) { atomic_fetch_add((_Atomic size_t *)context, count); }

static bool check_surface(ghostty_app_t app, double scale, bool external, bool empty) {
  NSView *view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, empty ? 0 : 1440, empty ? 0 : 900)];
  int sockets[2] = {-1, -1};
  if (external && socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) != 0) return false;
  _Atomic size_t processed = 0;
  ghostty_surface_config_s config = ghostty_surface_config_new();
  config.platform_tag = GHOSTTY_PLATFORM_MACOS;
  config.platform.macos.nsview = (__bridge void *)view;
  config.scale_factor = scale;
  config.font_size = 16;
  config.command = "/usr/bin/true";
  config.external_io_fd = sockets[0];
  config.external_io_consumed_cb = consumed;
  config.external_io_userdata = &processed;
  ghostty_surface_t surface = ghostty_surface_new(app, &config);
  if (sockets[0] >= 0) close(sockets[0]);
  if (!surface) { if (sockets[1] >= 0) close(sockets[1]); return false; }

  const ghostty_surface_size_s size = ghostty_surface_size(surface);
  const uint32_t width = external && !empty ? 1440 * scale : 800;
  const uint32_t height = external && !empty ? 900 * scale : 600;
  bool ok = size.width_px == width && size.height_px == height;
  fprintf(stderr, "initial size: scale=%.0f external=%d empty=%d actual=%ux%u grid=%ux%u expected=%ux%u\n",
          scale, external, empty, size.width_px, size.height_px, size.columns, size.rows, width, height);

  if (ok && external) {
    // Address the bottom-right cell, outside the old placeholder grid. Wait
    // for the external reader's parser acknowledgement, not a UI resize/tick.
    char replay[96];
    const int length = snprintf(replay, sizeof(replay), "\033[?1049h\033[2J\033[%u;%uHX", size.rows, size.columns);
    ok = write(sockets[1], replay, length) == length;
    for (int i = 0; i < 1000 && atomic_load(&processed) < (size_t)length; i++) usleep(1000);
    ok = ok && atomic_load(&processed) >= (size_t)length;
    ghostty_selection_s selection = {
      .top_left = {GHOSTTY_POINT_ACTIVE, GHOSTTY_POINT_COORD_EXACT, size.columns - 1, size.rows - 1},
      .bottom_right = {GHOSTTY_POINT_ACTIVE, GHOSTTY_POINT_COORD_EXACT, size.columns - 1, size.rows - 1},
      .rectangle = false,
    };
    ghostty_text_s text = {0};
    if (ghostty_surface_read_text(surface, selection, &text)) {
      ok = ok && text.text_len == 1 && text.text[0] == 'X';
      if (!ok) fprintf(stderr, "bottom-right replay text length=%lu\n", (unsigned long)text.text_len);
      ghostty_surface_free_text(surface, &text);
    } else ok = false;
  }
  ghostty_surface_free(surface);
  if (sockets[1] >= 0) close(sockets[1]);
  return ok;
}

int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    if (ghostty_init(0, NULL) != 0) return 1;
    ghostty_config_t config = ghostty_config_new();
    ghostty_config_finalize(config);
    ghostty_runtime_config_s runtime = {
      .wakeup_cb = wakeup, .action_cb = action,
      .read_clipboard_cb = read_clipboard, .confirm_read_clipboard_cb = confirm_clipboard,
      .write_clipboard_cb = write_clipboard, .close_surface_cb = close_surface,
    };
    ghostty_app_t app = ghostty_app_new(&runtime, config);
    if (!app) return 1;
    bool ok = true;
    for (int scale = 1; scale <= 2; scale++) {
      ok = check_surface(app, scale, true, false) && ok;
      ok = check_surface(app, scale, true, true) && ok;
      ok = check_surface(app, scale, false, false) && ok;
    }
    ghostty_app_free(app);
    ghostty_config_free(config);
    return ok ? 0 : 1;
  }
}
