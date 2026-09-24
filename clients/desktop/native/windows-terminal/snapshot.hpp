#pragma once
#include <napi.h>
#include <windows.h>

Napi::Value ReadTerminalText(Napi::Env env, HWND window);
Napi::Value CaptureTerminal(Napi::Env env, HWND window);
