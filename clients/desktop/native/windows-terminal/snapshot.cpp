#include "snapshot.hpp"
#include <UIAutomation.h>
#include <wrl/client.h>
#include <vector>

using Microsoft::WRL::ComPtr;

// UI Automation clients must run off the window thread: the provider marshals
// requests back to that thread. Never block Electron waiting for its own HWND.
class ReadTextWorker final : public Napi::AsyncWorker {
  HWND window_;
  Napi::Promise::Deferred deferred_;
  std::u16string text_;
public:
  ReadTextWorker(Napi::Env env, HWND window) : AsyncWorker(env), window_(window), deferred_(Napi::Promise::Deferred::New(env)) {}
  Napi::Promise Promise() { return deferred_.Promise(); }
  void Execute() override {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(initialized)) { SetError("windowsTerminalAutomationInitFailed"); return; }
    ComPtr<IUIAutomation> automation;
    ComPtr<IUIAutomationElement> element;
    ComPtr<IUIAutomationTextPattern> pattern;
    ComPtr<IUIAutomationTextRange> range;
    BSTR value = nullptr;
    HRESULT result = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
    if (SUCCEEDED(result)) result = automation->ElementFromHandle(window_, &element);
    if (SUCCEEDED(result)) result = element->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&pattern));
    if (SUCCEEDED(result)) result = pattern->get_DocumentRange(&range);
    if (SUCCEEDED(result)) result = range->GetText(262144, &value);
    if (SUCCEEDED(result) && value) text_.assign(reinterpret_cast<char16_t*>(value), SysStringLen(value));
    else SetError("windowsTerminalTextUnavailable");
    SysFreeString(value);
    range.Reset(); pattern.Reset(); element.Reset(); automation.Reset();
    CoUninitialize();
  }
  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), text_)); }
  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
};

Napi::Value ReadTerminalText(Napi::Env env, HWND window) {
  auto worker = new ReadTextWorker(env, window);
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

Napi::Value CaptureTerminal(Napi::Env env, HWND window) {
  RECT rect{};
  if (!IsWindowVisible(window) || !GetClientRect(window, &rect)) return env.Undefined();
  const int width = rect.right, height = rect.bottom;
  if (width <= 0 || height <= 0 || static_cast<uint64_t>(width) * height > 8 * 1024 * 1024) return env.Undefined();
  HDC source = GetDC(window);
  HDC memory = CreateCompatibleDC(source);
  BITMAPINFO bitmap{};
  bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bitmap.bmiHeader.biWidth = width;
  bitmap.bmiHeader.biHeight = -height;
  bitmap.bmiHeader.biPlanes = 1;
  bitmap.bmiHeader.biBitCount = 32;
  void* pixels = nullptr;
  HBITMAP image = CreateDIBSection(source, &bitmap, DIB_RGB_COLORS, &pixels, nullptr, 0);
  if (!source || !memory || !image) {
    if (image) DeleteObject(image);
    if (memory) DeleteDC(memory);
    if (source) ReleaseDC(window, source);
    return env.Undefined();
  }
  auto previous = SelectObject(memory, image);
  const bool captured = PrintWindow(window, memory, 3 /* client + render full content */);
  Napi::Value result = env.Undefined();
  if (captured) {
    auto bytes = static_cast<uint8_t*>(pixels);
    const size_t size = static_cast<size_t>(width) * height * 4;
    for (size_t i = 3; i < size; i += 4) bytes[i] = 255;
    auto object = Napi::Object::New(env);
    object.Set("width", width); object.Set("height", height);
    object.Set("data", Napi::Buffer<uint8_t>::Copy(env, bytes, size));
    result = object;
  }
  SelectObject(memory, previous); DeleteObject(image); DeleteDC(memory); ReleaseDC(window, source);
  return result;
}
