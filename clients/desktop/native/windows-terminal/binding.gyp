{
  "targets": [{
    "target_name": "windows_terminal",
    "sources": ["host.cpp", "snapshot.cpp"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_CPP_EXCEPTIONS", "NOMINMAX", "UNICODE", "_UNICODE"],
    "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++20", "/utf-8"]}},
    "libraries": ["user32.lib", "gdi32.lib", "ole32.lib", "oleaut32.lib", "comctl32.lib", "uiautomationcore.lib"]
  }, {
    "target_name": "windows_terminal_test",
    "sources": ["test-driver.cpp"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_CPP_EXCEPTIONS", "NOMINMAX", "UNICODE", "_UNICODE"],
    "msvs_settings": {"VCCLCompilerTool": {"ExceptionHandling": 1, "AdditionalOptions": ["/std:c++20", "/utf-8"]}},
    "libraries": ["user32.lib"]
  }]
}
