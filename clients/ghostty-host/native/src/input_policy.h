#pragma once
#include <string>
#include <vector>

struct NativeShortcutBinding {
  unsigned short keyCode;
  unsigned int modifiers;
  std::string action;
};
struct NativeInputPolicy {
  std::vector<NativeShortcutBinding> bindings;
  std::string imagePasteAction;
  std::string doubleShiftAction;
  double doubleShiftWindow = 0.5;
};
static NativeInputPolicy *g_inputPolicy = nullptr;

static const char *embedderShortcutForEvent(NSEvent *event) {
  unsigned int modifiers = 0;
  if (event.modifierFlags & NSEventModifierFlagShift) modifiers |= 1;
  if (event.modifierFlags & NSEventModifierFlagControl) modifiers |= 2;
  if (event.modifierFlags & NSEventModifierFlagOption) modifiers |= 4;
  if (event.modifierFlags & NSEventModifierFlagCommand) modifiers |= 8;
  for (const auto &binding : g_inputPolicy->bindings) {
    if (binding.keyCode == event.keyCode && binding.modifiers == modifiers) {
      return binding.action.c_str();
    }
  }
  return nullptr;
}

static bool configureInputPolicy(Napi::Object opts) {
  if (!opts.Has("inputPolicy")) return true;
  const auto policy = opts.Get("inputPolicy").As<Napi::Object>();
  if (policy.Has("bindings")) {
    const auto bindings = policy.Get("bindings").As<Napi::Array>();
    if (bindings.Length() > 128) { Napi::Error::New(opts.Env(), "too many native shortcuts").ThrowAsJavaScriptException(); return false; }
    for (uint32_t i = 0; i < bindings.Length(); ++i) {
      const auto binding = bindings.Get(i).As<Napi::Object>();
      const auto keyCode = binding.Get("keyCode").As<Napi::Number>().Uint32Value();
      const auto modifiers = binding.Get("modifiers").As<Napi::Number>().Uint32Value();
      const auto action = binding.Get("action").As<Napi::String>().Utf8Value();
      if (keyCode > 65535 || modifiers > 15 || action.empty() || action.size() > 128) {
        { Napi::Error::New(opts.Env(), "invalid native shortcut").ThrowAsJavaScriptException(); return false; }
      }
      g_inputPolicy->bindings.push_back({(unsigned short)keyCode, modifiers, action});
    }
  }
  if (policy.Has("imagePasteAction")) g_inputPolicy->imagePasteAction = policy.Get("imagePasteAction").As<Napi::String>().Utf8Value();
  if (policy.Has("doubleShiftAction")) g_inputPolicy->doubleShiftAction = policy.Get("doubleShiftAction").As<Napi::String>().Utf8Value();
  if (policy.Has("doubleShiftWindowMs")) {
    const auto milliseconds = policy.Get("doubleShiftWindowMs").As<Napi::Number>().DoubleValue();
    if (!(milliseconds > 0 && milliseconds <= 2000)) { Napi::Error::New(opts.Env(), "invalid double-shift interval").ThrowAsJavaScriptException(); return false; }
    g_inputPolicy->doubleShiftWindow = milliseconds / 1000.0;
  }
  return true;
}
