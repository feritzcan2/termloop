#include <napi.h>
#include <windows.h>
#include "paste-mode.hpp"

HWND Handle(const Napi::Value& value) {
  auto bytes = value.As<Napi::Buffer<uint8_t>>();
  if (bytes.Length() != sizeof(HWND)) throw Napi::Error::New(value.Env(), "invalid HWND");
  HWND window;
  memcpy(&window, bytes.Data(), sizeof(window));
  return window;
}
Napi::Object Module(Napi::Env env, Napi::Object exports) {
  exports.Set("children", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    auto result = Napi::Array::New(info.Env());
    HWND parent = Handle(info[0]), child = nullptr;
    unsigned index = 0;
    while ((child = FindWindowExW(parent, child, L"HwndTerminalClass", nullptr))) {
      RECT rect{}; GetWindowRect(child, &rect);
      MapWindowPoints(nullptr, parent, reinterpret_cast<POINT*>(&rect), 2);
      auto item = Napi::Object::New(info.Env());
      item.Set("handle", Napi::Buffer<uint8_t>::Copy(info.Env(), reinterpret_cast<uint8_t*>(&child), sizeof(child)));
      item.Set("x", rect.left); item.Set("y", rect.top);
      item.Set("dpi", GetDpiForWindow(child));
      item.Set("focused", GetFocus() == child);
      result.Set(index++, item);
    }
    return result;
  }));
  exports.Set("key", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    HWND window = Handle(info[0]);
    auto key = info[1].As<Napi::Number>().Uint32Value();
    auto modifiers = info[2].As<Napi::Number>().Uint32Value();
    BYTE saved[256]{}, state[256]{}; GetKeyboardState(saved);
    if (modifiers & 1) state[VK_CONTROL] = state[VK_LCONTROL] = 0x80;
    if (modifiers & 2) state[VK_SHIFT] = state[VK_LSHIFT] = 0x80;
    if (modifiers & 4) state[VK_MENU] = state[VK_LMENU] = 0x80;
    state[key] = 0x80; SetKeyboardState(state);
    const auto scan = MapVirtualKeyW(key, MAPVK_VK_TO_VSC);
    SendMessageW(window, WM_KEYDOWN, key, (scan << 16) | 1);
    if (info.Length() > 3) SendMessageW(window, WM_CHAR, info[3].As<Napi::Number>().Uint32Value(), (scan << 16) | 1);
    state[key] = 0; SetKeyboardState(state);
    SendMessageW(window, WM_KEYUP, key, (scan << 16) | (3LL << 30) | 1);
    SetKeyboardState(saved);
  }));
  exports.Set("pasteMode", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
    PasteMode mode;
    auto chunks = info[0].As<Napi::Array>();
    for (unsigned i = 0; i < chunks.Length(); ++i) mode.Feed(chunks.Get(i).As<Napi::String>().Utf16Value());
    return Napi::String::New(info.Env(), mode.Prepare(info[1].As<Napi::String>().Utf16Value()));
  }));
  return exports;
}
NODE_API_MODULE(windows_terminal_test, Module)
