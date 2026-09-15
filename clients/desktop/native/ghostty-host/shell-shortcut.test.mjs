import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("native Cmd+R routes rename while other R chords stay with the terminal", {
  skip: process.platform !== "darwin",
}, () => {
  const source = readFileSync(new URL("src/ghostty_host.mm", import.meta.url), "utf8");
  // Compile the actual AppKit matcher without loading Electron or libghostty.
  const matcher = source.match(/static const char \*termLoopShortcutForEvent\(NSEvent \*event\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(matcher, "native shortcut matcher is present");
  const directory = mkdtempSync(path.join(tmpdir(), "termloop-native-shortcut-"));
  try {
    const harness = path.join(directory, "shortcut.mm");
    const binary = path.join(directory, "shortcut");
    writeFileSync(harness, `
#import <AppKit/AppKit.h>
#include <cassert>
#include <cstring>
${matcher}

int main() {
  @autoreleasepool {
    const NSEventModifierFlags command = NSEventModifierFlagCommand;
    const NSEventModifierFlags cases[] = {
      command,
      command | NSEventModifierFlagCapsLock,
      0,
      NSEventModifierFlagControl,
      command | NSEventModifierFlagControl,
      command | NSEventModifierFlagOption,
      command | NSEventModifierFlagShift,
    };
    for (unsigned int index = 0; index < sizeof(cases) / sizeof(cases[0]); ++index) {
      NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown
          location:NSZeroPoint modifierFlags:cases[index] timestamp:0
          windowNumber:0 context:nil characters:@"r"
          charactersIgnoringModifiers:@"r" isARepeat:NO keyCode:0x0F];
      const char *shortcut = termLoopShortcutForEvent(event);
      if (index < 2) assert(shortcut && strcmp(shortcut, "renameSession") == 0);
      else assert(shortcut == nullptr);
    }
  }
}
`);
    execFileSync("xcrun", ["clang++", "-framework", "AppKit", harness, "-o", binary], { stdio: "pipe" });
    execFileSync(binary, [], { stdio: "pipe" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
