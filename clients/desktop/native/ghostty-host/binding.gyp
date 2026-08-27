{
  "targets": [
    {
      "target_name": "ghostty_host",
      "sources": ["src/ghostty_host.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../../../../vendor/ghostty/include"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "libraries": [
        "-L<(module_root_dir)/../../../../vendor/ghostty/zig-out/lib",
        "-lghostty",
        "-Wl,-rpath,@loader_path",
        "-Wl,-rpath,<(module_root_dir)/../../../../vendor/ghostty/zig-out/lib"
      ],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "OTHER_LDFLAGS": [
          "-Wl,-no_fixup_chains",
          "-framework AppKit",
          "-framework QuartzCore"
        ]
      }
    }
  ]
}
