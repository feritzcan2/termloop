#include <napi.h>
#include <windows.h>
#include <commctrl.h>
#include <array>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include "snapshot.hpp"
#include "paste-mode.hpp"

// ABI of Microsoft's v1.24.11911.0 HwndTerminal.hpp. The DLL is loaded from
// our pinned application resources; no installed Windows Terminal is used.
struct Grid { int cols; int rows; };
struct Theme { COLORREF background, foreground, selection; unsigned cursor; COLORREF colors[16]; };
struct Api {
  HRESULT (__stdcall *create)(HWND, HWND*, void**);
  void (__stdcall *destroy)(void*);
  void (__stdcall *output)(void*, LPCWSTR);
  HRESULT (__stdcall *resize)(void*, int, int, Grid*);
  void (__stdcall *dpi)(void*, int);
  void (__stdcall *writeCallback)(void*, void (__stdcall *)(wchar_t*));
  void (__stdcall *scrollCallback)(void*, void (__stdcall *)(int, int, int));
  void (__stdcall *scroll)(void*, int);
  void (__stdcall *key)(void*, WORD, WORD, WORD, bool);
  void (__stdcall *character)(void*, wchar_t, WORD, WORD);
  void (__stdcall *theme)(void*, Theme, LPCWSTR, int, int);
  void (__stdcall *focus)(void*);
  void (__stdcall *blur)(void*);
  void (__stdcall *blink)(void*);
  void (__stdcall *cursor)(void*, bool);
  bool (__stdcall *selected)(void*);
  wchar_t* (__stdcall *selection)(void*);
  void (__stdcall *clearSelection)(void*);
} api{};

struct Events {
  Napi::ThreadSafeFunction callback;
  std::atomic<bool> failed{false};
  std::atomic<bool> notified{false};
};
struct Surface {
  unsigned id{}, slot{};
  HWND window{}, parent{};
  void* terminal{};
  Grid grid{};
  int dpi{96};
  int x{-1}, y{-1}, width{-1}, height{-1};
  int wheelRemainder{};
  std::atomic<int> viewTop{0}, bufferSize{0}, viewHeight{0};
  unsigned inputGeneration{};
  std::shared_ptr<Events> events;
  ULONGLONG shiftReleased{};
  bool shiftOnly{}, suppressChar{};
  std::array<bool, 256> suppressedKeys{};
  PasteMode pasteMode;
};

constexpr size_t kCapacity = 128;
std::array<std::unique_ptr<Surface>, kCapacity> surfaces;
unsigned nextId = 1;
HMODULE library = nullptr;

void Emit(Surface& surface, std::string kind, std::u16string value = {}) {
  auto events = surface.events;
  auto status = events->callback.NonBlockingCall([events, id = surface.id, kind, value](Napi::Env env, Napi::Function callback) {
    if (events->failed) {
      if (!events->notified.exchange(true)) callback.Call({ Napi::String::New(env, "closed"), Napi::Number::New(env, id), env.Undefined() });
      return;
    }
    callback.Call({ Napi::String::New(env, kind), Napi::Number::New(env, id), Napi::String::New(env, value) });
  });
  if (status != napi_ok) events->failed = true;
}

template<size_t Slot> void __stdcall OnWrite(wchar_t* value) {
  if (surfaces[Slot] && value) {
    ++surfaces[Slot]->inputGeneration;
    const auto text = std::u16string(reinterpret_cast<char16_t*>(value));
    Emit(*surfaces[Slot], "input", text);
  }
  // HwndTerminal transfers ownership of a CoTaskMem string to this callback.
  CoTaskMemFree(value);
}
template<size_t Slot> void __stdcall OnScroll(int top, int height, int size) {
  if (auto* surface = surfaces[Slot].get()) { surface->viewTop = top; surface->viewHeight = height; surface->bufferSize = size; }
}
template<size_t... Slots> auto WriteCallbacks(std::index_sequence<Slots...>) { return std::array{ &OnWrite<Slots>... }; }
template<size_t... Slots> auto ScrollCallbacks(std::index_sequence<Slots...>) { return std::array{ &OnScroll<Slots>... }; }
const auto writeCallbacks = WriteCallbacks(std::make_index_sequence<kCapacity>{});
const auto scrollCallbacks = ScrollCallbacks(std::make_index_sequence<kCapacity>{});

bool Down(int key) { return (GetKeyState(key) & 0x8000) != 0; }
void Shortcut(Surface& surface, const char16_t* action) { Emit(surface, "shortcut", action); }

void CopySelection(Surface& surface) {
  wchar_t* text = api.selection(surface.terminal);
  if (!text) return;
  const size_t bytes = (wcslen(text) + 1) * sizeof(wchar_t);
  HGLOBAL buffer = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (buffer) {
    if (auto* target = GlobalLock(buffer)) {
      memcpy(target, text, bytes); GlobalUnlock(buffer);
      if (OpenClipboard(surface.window)) {
        EmptyClipboard();
        if (SetClipboardData(CF_UNICODETEXT, buffer)) buffer = nullptr;
        CloseClipboard();
      }
    }
    if (buffer) GlobalFree(buffer);
  }
  CoTaskMemFree(text);
  api.clearSelection(surface.terminal);
}

void PasteClipboard(Surface& surface) {
  if (IsClipboardFormatAvailable(CF_DIB) || IsClipboardFormatAvailable(CF_DIBV5)) { Shortcut(surface, u"pasteImage"); return; }
  if (!OpenClipboard(surface.window)) return;
  const auto data = GetClipboardData(CF_UNICODETEXT);
  std::u16string text;
  if (data && GlobalSize(data) <= 2 * 1024 * 1024) {
    if (const auto value = static_cast<const char16_t*>(GlobalLock(data))) {
      const size_t max = GlobalSize(data) / sizeof(char16_t);
      size_t length = 0;
      while (length < max && value[length]) ++length;
      text.assign(value, length);
      GlobalUnlock(data);
    }
  }
  CloseClipboard();
  if (!text.empty()) { api.clearSelection(surface.terminal); Emit(surface, "input", surface.pasteMode.Prepare(text)); }
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM key, LPARAM flags, UINT_PTR, DWORD_PTR reference) {
  auto& surface = *reinterpret_cast<Surface*>(reference);
  switch (message) {
    case WM_SETCURSOR:
      // DefWindowProc asks Chromium first, which can retain the sidebar's
      // resize cursor while the pointer is over this native child window.
      if (LOWORD(flags) == HTCLIENT) {
        SetCursor(LoadCursorW(nullptr, IDC_IBEAM));
        return TRUE;
      }
      break;
    case WM_WINDOWPOSCHANGING:
      reinterpret_cast<WINDOWPOS*>(flags)->flags |= SWP_NOACTIVATE;
      break;
    case WM_SETFOCUS:
      api.focus(surface.terminal); api.cursor(surface.terminal, true);
      if (auto blink = GetCaretBlinkTime(); blink != INFINITE && blink != 0) SetTimer(window, 1, blink, nullptr);
      break;
    case WM_KILLFOCUS:
      KillTimer(window, 1); api.blur(surface.terminal);
      surface.shiftOnly = false; surface.shiftReleased = 0;
      surface.suppressedKeys.fill(false); surface.suppressChar = false;
      break;
    case WM_TIMER: if (key == 1) { api.blink(surface.terminal); return 0; } break;
    case WM_MOUSEACTIVATE: SetFocus(window); return MA_ACTIVATE;
    case WM_LBUTTONDOWN: SetFocus(window); break;
    case WM_RBUTTONDOWN: {
      SetFocus(window);
      if (surface.pasteMode.MouseReporting() && !Down(VK_SHIFT)) break;
      if (api.selected(surface.terminal)) CopySelection(surface);
      else PasteClipboard(surface);
      return 0;
    }
    case WM_KEYDOWN: case WM_SYSKEYDOWN: {
      const bool ctrl = Down(VK_CONTROL), shift = Down(VK_SHIFT), alt = Down(VK_MENU);
      const bool repeat = (flags & (1LL << 30)) != 0;
      surface.suppressChar = false;
      if (key == VK_SHIFT && !repeat) surface.shiftOnly = !ctrl && !alt;
      else if (key != VK_SHIFT) { surface.shiftOnly = false; surface.shiftReleased = 0; }
      const char16_t* shortcut = nullptr;
      if (ctrl && shift && !alt && key == 'P') shortcut = u"commandPalette";
      else if (ctrl && !shift && !alt && key == 'T') shortcut = u"newTerminal";
      else if (ctrl && shift && !alt && key == 'R') shortcut = u"renameSession";
      else if (ctrl && alt && !shift && key == VK_LEFT) shortcut = u"focusPreviousPane";
      else if (ctrl && alt && !shift && key == VK_RIGHT) shortcut = u"focusNextPane";
      else if (ctrl && !alt && key == 'V' && (IsClipboardFormatAvailable(CF_DIB) || IsClipboardFormatAvailable(CF_DIBV5))) shortcut = u"pasteImage";
      bool handled = shortcut != nullptr;
      if (shortcut && !repeat) Shortcut(surface, shortcut);
      if (ctrl && !shift && !alt && key >= '1' && key <= '9') {
        if (!repeat) Emit(surface, "shortcut", u"project." + std::u16string(1, static_cast<char16_t>(key)));
        handled = true;
      }
      if (ctrl && !alt && key == 'C' && api.selected(surface.terminal)) { CopySelection(surface); handled = true; }
      if (!handled && ((ctrl && !alt && key == 'V') || (shift && !ctrl && key == VK_INSERT))) {
        PasteClipboard(surface);
        handled = true;
      }
      if (handled) {
        if (key < 256) surface.suppressedKeys[key] = true;
        surface.suppressChar = true;
        return 0;
      }
      api.key(surface.terminal, static_cast<WORD>(key), static_cast<WORD>((flags >> 16) & 255), static_cast<WORD>((flags >> 16) & 0xff00), true);
      return 0;
    }
    case WM_KEYUP: case WM_SYSKEYUP:
      if (key == VK_SHIFT && surface.shiftOnly) {
        const auto now = GetTickCount64();
        if (surface.shiftReleased && now - surface.shiftReleased <= 500) { Shortcut(surface, u"quickAction"); surface.shiftReleased = 0; }
        else surface.shiftReleased = now;
        surface.shiftOnly = false;
      }
      if (key < 256 && surface.suppressedKeys[key]) { surface.suppressedKeys[key] = false; return 0; }
      api.key(surface.terminal, static_cast<WORD>(key), static_cast<WORD>((flags >> 16) & 255), static_cast<WORD>((flags >> 16) & 0xff00), false);
      return 0;
    case WM_CHAR: case WM_SYSCHAR:
      if (!surface.suppressChar) api.character(surface.terminal, static_cast<wchar_t>(key), static_cast<WORD>((flags >> 16) & 255), static_cast<WORD>((flags >> 16) & 0xff00));
      return 0;
    case WM_MOUSEWHEEL: {
      const auto before = surface.viewTop.load();
      const auto inputGeneration = surface.inputGeneration;
      const auto result = DefSubclassProc(window, message, key, flags);
      // If VT mouse reporting consumed the wheel, don't also scroll history.
      if (surface.inputGeneration == inputGeneration) {
        surface.wheelRemainder += GET_WHEEL_DELTA_WPARAM(key);
        const int ticks = surface.wheelRemainder / WHEEL_DELTA;
        surface.wheelRemainder %= WHEEL_DELTA;
        UINT lines = 3;
        SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, &lines, 0);
        const int distance = lines == WHEEL_PAGESCROLL ? surface.viewHeight.load() : static_cast<int>(std::min(lines, 100u));
        if (ticks) api.scroll(surface.terminal, std::max(0, before - ticks * distance));
      }
      return result;
    }
  }
  return DefSubclassProc(window, message, key, flags);
}

Surface& Get(const Napi::CallbackInfo& info) {
  const auto id = info[0].As<Napi::Number>().Uint32Value();
  for (auto& surface : surfaces) if (surface && surface->id == id) return *surface;
  throw Napi::Error::New(info.Env(), "windowsTerminalSurfaceClosed");
}
Napi::Object GridObject(Napi::Env env, const Surface& surface) {
  auto result = Napi::Object::New(env);
  result.Set("surfaceId", surface.id); result.Set("rows", surface.grid.rows); result.Set("cols", surface.grid.cols);
  return result;
}
void Destroy(size_t slot) {
  auto& surface = surfaces[slot];
  if (!surface) return;
  RemoveWindowSubclass(surface->window, WindowProc, 1);
  KillTimer(surface->window, 1);
  api.destroy(surface->terminal);
  surface->events->callback.Abort();
  surface.reset();
}
void Cleanup(void*) { for (size_t slot = 0; slot < kCapacity; ++slot) Destroy(slot); }

template<typename Function> void Load(Function& target, const char* name, Napi::Env env) {
  target = reinterpret_cast<Function>(GetProcAddress(library, name));
  if (!target) throw Napi::Error::New(env, std::string("Windows Terminal export missing: ") + name);
}
Napi::Value Initialize(const Napi::CallbackInfo& info) {
  if (library) return info.Env().Undefined();
  const auto file = info[0].As<Napi::String>().Utf16Value();
  library = LoadLibraryExW(reinterpret_cast<LPCWSTR>(file.c_str()), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!library) throw Napi::Error::New(info.Env(), "Windows Terminal DLL load failed: " + std::to_string(GetLastError()));
  const auto font = file.substr(0, file.find_last_of(u"/\\") + 1) + u"CascadiaMono.ttf";
  AddFontResourceExW(reinterpret_cast<LPCWSTR>(font.c_str()), FR_PRIVATE, nullptr);
  try {
#define LOAD(member, name) Load(api.member, name, info.Env())
    LOAD(create, "CreateTerminal"); LOAD(destroy, "DestroyTerminal"); LOAD(output, "TerminalSendOutput");
    LOAD(resize, "TerminalTriggerResize"); LOAD(dpi, "TerminalDpiChanged");
    LOAD(writeCallback, "TerminalRegisterWriteCallback"); LOAD(scrollCallback, "TerminalRegisterScrollCallback");
    LOAD(scroll, "TerminalUserScroll"); LOAD(key, "TerminalSendKeyEvent"); LOAD(character, "TerminalSendCharEvent");
    LOAD(theme, "TerminalSetTheme"); LOAD(focus, "TerminalSetFocus"); LOAD(blur, "TerminalKillFocus");
    LOAD(blink, "TerminalBlinkCursor"); LOAD(cursor, "TerminalSetCursorVisible");
    LOAD(selected, "TerminalIsSelectionActive"); LOAD(selection, "TerminalGetSelection"); LOAD(clearSelection, "TerminalClearSelection");
#undef LOAD
  } catch (...) { FreeLibrary(library); library = nullptr; throw; }
  return info.Env().Undefined();
}

void SetTheme(Surface& surface, bool light) {
  constexpr unsigned dark[] = {0x1d1f21,0xcc6666,0xb5bd68,0xf0c674,0x81a2be,0xb294bb,0x8abeb7,0xc5c8c6,0x666666,0xd54e53,0xb9ca4a,0xe7c547,0x7aa6da,0xc397d8,0x70c0b1,0xeaeaea};
  constexpr unsigned bright[] = {0x000000,0xde3e35,0x3f953a,0x9a6c16,0x2f5af3,0xa35300,0x197a73,0xbbbbbb,0x5d626b,0xc9342d,0x327b2e,0x7c5812,0x244bd5,0x8a4500,0x14645f,0xffffff};
  auto color = [](unsigned rgb) { return RGB(rgb >> 16, (rgb >> 8) & 255, rgb & 255); };
  Theme theme{};
  theme.background = color(light ? 0xf9f9f9 : 0x282c34);
  theme.foreground = color(light ? 0x2a2c33 : 0xd8dce3);
  theme.selection = color(light ? 0xd9ddf2 : 0x555b66);
  theme.cursor = 0;
  for (int i = 0; i < 16; ++i) theme.colors[i] = color(light ? bright[i] : dark[i]);
  api.theme(surface.terminal, theme, L"Cascadia Mono", 10, surface.dpi);
}

void Frame(Surface& surface, double x, double y, double width, double height, Napi::Env env) {
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height)
      || std::abs(x) > 32768 || std::abs(y) > 32768 || width < 0 || height < 0 || width > 16384 || height > 16384)
    throw Napi::Error::New(env, "invalidWindowsTerminalFrame");
  const int dpi = GetDpiForWindow(surface.parent);
  const bool dpiChanged = dpi != surface.dpi;
  if (dpiChanged) { surface.dpi = dpi; api.dpi(surface.terminal, dpi); }
  const double scale = surface.dpi / 96.0;
  const int w = std::max(1, static_cast<int>(std::round(width * scale)));
  const int h = std::max(1, static_cast<int>(std::round(height * scale)));
  const int left = static_cast<int>(std::round(x * scale)), top = static_cast<int>(std::round(y * scale));
  const bool resized = dpiChanged || w != surface.width || h != surface.height;
  if (resized) {
    // The upstream resize resets the HWND origin to (0,0). Restore our pane
    // position afterwards. Avoid unchanged resizes: they clear selection.
    const auto result = api.resize(surface.terminal, w, h, &surface.grid);
    if (FAILED(result)) throw Napi::Error::New(env, "windowsTerminalResizeFailed");
  }
  if (resized || left != surface.x || top != surface.y) {
    SetWindowPos(surface.window, HWND_TOP, left, top, w, h, SWP_NOACTIVATE);
    surface.x = left; surface.y = top; surface.width = w; surface.height = h;
  }
}

Napi::Value Create(const Napi::CallbackInfo& info) {
  if (!library) throw Napi::Error::New(info.Env(), "windowsTerminalNotInitialized");
  size_t slot = 0;
  while (slot < kCapacity && surfaces[slot]) ++slot;
  if (slot == kCapacity) throw Napi::Error::New(info.Env(), "windowsTerminalSurfaceLimit");
  const auto handle = info[0].As<Napi::Buffer<uint8_t>>();
  if (handle.Length() != sizeof(HWND)) throw Napi::Error::New(info.Env(), "invalidWindowsTerminalWindow");
  auto surface = std::make_unique<Surface>();
  memcpy(&surface->parent, handle.Data(), sizeof(HWND));
  DWORD pid = 0;
  const auto thread = GetWindowThreadProcessId(surface->parent, &pid);
  if (pid != GetCurrentProcessId() || thread != GetCurrentThreadId()) throw Napi::Error::New(info.Env(), "invalidWindowsTerminalOwner");
  const HRESULT result = api.create(surface->parent, &surface->window, &surface->terminal);
  if (FAILED(result)) throw Napi::Error::New(info.Env(), "windowsTerminalCreateFailed: " + std::to_string(result));
  surface->id = nextId++; surface->slot = static_cast<unsigned>(slot);
  surface->dpi = GetDpiForWindow(surface->parent);
  surface->events = std::make_shared<Events>();
  surface->events->callback = Napi::ThreadSafeFunction::New(info.Env(), info[2].As<Napi::Function>(), "windows-terminal-input", 256, 1);
  surface->events->callback.Unref(info.Env());
  surfaces[slot] = std::move(surface);
  auto& created = *surfaces[slot];
  try {
    api.writeCallback(created.terminal, writeCallbacks[slot]); api.scrollCallback(created.terminal, scrollCallbacks[slot]);
    if (!SetWindowSubclass(created.window, WindowProc, 1, reinterpret_cast<DWORD_PTR>(&created))) throw Napi::Error::New(info.Env(), "windowsTerminalSubclassFailed");
    SetTheme(created, false);
    const auto frame = info[1].As<Napi::Object>();
    Frame(created, frame.Get("x").As<Napi::Number>(), frame.Get("y").As<Napi::Number>(), frame.Get("width").As<Napi::Number>(), frame.Get("height").As<Napi::Number>(), info.Env());
    ShowWindow(created.window, SW_HIDE);
  } catch (...) { Destroy(slot); throw; }
  return GridObject(info.Env(), created);
}

Napi::Value Write(const Napi::CallbackInfo& info) {
  auto& surface = Get(info);
  if (surface.events->failed) throw Napi::Error::New(info.Env(), "windowsTerminalInputOverflow");
  auto text = info[1].As<Napi::String>().Utf16Value();
  if (text.size() > 1024 * 1024) throw Napi::Error::New(info.Env(), "windowsTerminalOutputTooLarge");
  surface.pasteMode.Feed(text);
  // TerminalSendOutput is NUL-terminated; NUL is a no-op in VT, so feed each
  // segment without accidentally truncating the rest of the daemon output.
  size_t start = 0;
  while (start < text.size()) {
    const size_t end = text.find(u'\0', start);
    auto segment = text.substr(start, end == std::u16string::npos ? end : end - start);
    api.output(surface.terminal, reinterpret_cast<LPCWSTR>(segment.c_str()));
    if (end == std::u16string::npos) break;
    start = end + 1;
  }
  return info.Env().Undefined();
}

Napi::Object Module(Napi::Env env, Napi::Object exports) {
  exports.Set("initialize", Napi::Function::New(env, Initialize));
  exports.Set("create", Napi::Function::New(env, Create));
  exports.Set("write", Napi::Function::New(env, Write));
  exports.Set("setFrame", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
    auto& surface = Get(info);
    Frame(surface, info[1].As<Napi::Number>(), info[2].As<Napi::Number>(), info[3].As<Napi::Number>(), info[4].As<Napi::Number>(), info.Env());
    return GridObject(info.Env(), surface);
  }));
  exports.Set("setVisible", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    auto& surface = Get(info);
    const bool visible = info[1].As<Napi::Boolean>();
    if (!visible && GetFocus() == surface.window) SetFocus(surface.parent);
    ShowWindow(surface.window, visible ? SW_SHOWNA : SW_HIDE);
  }));
  exports.Set("setColorScheme", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { SetTheme(Get(info), info[1].As<Napi::String>().Utf8Value() == "light"); }));
  exports.Set("focus", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { SetFocus(Get(info).window); }));
  exports.Set("scrollToBottom", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { auto& s = Get(info); api.scroll(s.terminal, std::max(0, s.bufferSize - s.viewHeight)); }));
  exports.Set("readText", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return ReadTerminalText(info.Env(), Get(info).window); }));
  exports.Set("snapshot", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { return CaptureTerminal(info.Env(), Get(info).window); }));
  exports.Set("destroy", Napi::Function::New(env, [](const Napi::CallbackInfo& info) { Destroy(Get(info).slot); }));
  env.AddCleanupHook(Cleanup, static_cast<void*>(nullptr));
  return exports;
}
NODE_API_MODULE(windows_terminal, Module)
