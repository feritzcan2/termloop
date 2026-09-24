const { app, BrowserWindow, clipboard } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

app.setPath("userData", process.env.TERMLOOP_NATIVE_TEST_PROFILE);
const timeout = setTimeout(() => { console.error("Windows Terminal native smoke timed out"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const addon = require("./build/Release/windows_terminal.node");
  const driver = require("./build/Release/windows_terminal_test.node");
  addon.initialize(path.join(__dirname, "build/Release/Microsoft.Terminal.Control.dll"));
  const window = new BrowserWindow({ show: false, width: 900, height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL("data:text/html,<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\">native terminal test");
  const ids = [];
  const inputs = [];
  const savedClipboard = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() };
  try {
    const first = addon.create(window.getNativeWindowHandle(), { x: 0, y: 0, width: 400, height: 300 }, (...event) => inputs.push(event));
    const second = addon.create(window.getNativeWindowHandle(), { x: 420, y: 0, width: 400, height: 300 }, (...event) => inputs.push(event));
    ids.push(first.surfaceId, second.surfaceId);
    const children = driver.children(window.getNativeWindowHandle()).sort((a, b) => a.x - b.x);
    assert.equal(children.length, 2);
    assert.equal(children[0].x, 0);
    assert.equal(children[1].x, Math.round(420 * children[1].dpi / 96));
    assert(first.rows > 0 && first.cols > 0);
    addon.write(first.surfaceId, "\x1b[2J\x1b[HNATIVE-WINDOWS-TERMINAL Türkçe 😀\r\n\x1b[31mRED\x1b[0m");
    addon.write(second.surfaceId, "ISOLATED-PANE");
    addon.setVisible(first.surfaceId, true);
    addon.setVisible(second.surfaceId, true);
    window.showInactive();
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const child of children) {
      assert.deepEqual(driver.cursor(child.handle, true), { handled: true, cursor: "text", parentRequests: 0 },
        "Terminal inherited the sidebar resize cursor from Chromium");
      assert.equal(driver.cursor(child.handle, false).cursor, "resize",
        "Terminal intercepted a non-client resize cursor");
      assert.deepEqual(driver.cursor(child.handle, true), { handled: true, cursor: "text", parentRequests: 0 },
        "Terminal did not restore its cursor on re-entry");
    }
    const bitmap = addon.snapshot(first.surfaceId);
    assert(bitmap && bitmap.width > 0 && bitmap.height > 0);
    const colors = new Set();
    for (let i = 0; i < bitmap.data.length; i += 4) colors.add(bitmap.data.readUInt32LE(i));
    assert(colors.size > 10, `Native snapshot is blank (${colors.size} colors)`);
    let redPixels = 0;
    for (let i = 0; i < bitmap.data.length; i += 4) if (bitmap.data[i + 2] > bitmap.data[i] * 1.5 && bitmap.data[i + 2] > bitmap.data[i + 1] * 1.5) ++redPixels;
    assert(redPixels > 5, "Snapshot captured the wrong pane or lost ANSI color");
    fs.writeFileSync(path.join(__dirname, "build/smoke.png"), require("electron").nativeImage.createFromBitmap(bitmap.data, { width: bitmap.width, height: bitmap.height }).toPNG());
    const firstText = await addon.readText(first.surfaceId);
    assert(firstText.includes("NATIVE-WINDOWS-TERMINAL Türkçe 😀"), JSON.stringify(firstText));
    assert(firstText.includes("RED"));
    const secondText = await addon.readText(second.surfaceId);
    assert(secondText.includes("ISOLATED-PANE"));
    assert(!secondText.includes("NATIVE-WINDOWS"));
    // An owned transparent menu window must allow both native panes to keep
    // painting without reclaiming keyboard focus from the menu.
    const overlay = new BrowserWindow({ parent: window, show: false, frame: false,
      transparent: true, resizable: false, skipTaskbar: true, hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      overlay.setBounds(window.getContentBounds());
      await overlay.loadURL("data:text/html," + encodeURIComponent(
        "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\">" +
        "<style>html,body{margin:0;background:transparent}button{width:150px;height:60px;background:white}</style>" +
        "<button autofocus>Project menu</button>"));
      overlay.show();
      overlay.focus();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert(overlay.isFocused(), "Menu did not acquire focus before live output");
      for (const [rgb, channel] of [["255;0;0", 2], ["0;255;0", 1], ["0;0;255", 0]]) {
        for (const id of ids) addon.write(id, `\x1b[48;2;${rgb}m\x1b[2J\x1b[HOVERLAY-LIVE-${channel}`);
        for (const id of ids) {
          let painted = false;
          for (let attempt = 0; attempt < 40 && !painted; ++attempt) {
            await new Promise(resolve => setTimeout(resolve, 25));
            const frame = addon.snapshot(id);
            assert(frame, "Menu hid the live native terminal");
            let pixels = 0;
            for (let i = 0; i < frame.data.length; i += 4) {
              if (frame.data[i + channel] > frame.data[i + (channel + 1) % 3] * 1.5 &&
                  frame.data[i + channel] > frame.data[i + (channel + 2) % 3] * 1.5) ++pixels;
            }
            painted = pixels > frame.width * frame.height / 2;
          }
          assert(painted, `Pane ${id} stopped painting under the menu (${rgb})`);
          assert((await addon.readText(id)).includes(`OVERLAY-LIVE-${channel}`));
        }
        assert(overlay.isVisible(), "Live output closed the menu");
        assert(overlay.isFocused(), "Live output stole menu focus");
      }
    } finally {
      overlay.destroy();
      for (const id of ids) addon.write(id, "\x1b[0m\x1b[2J\x1b[H");
    }
    addon.focus(second.surfaceId);
    addon.setFrame(first.surfaceId, 0, 0, 400, 300);
    assert(driver.children(window.getNativeWindowHandle()).find(child => child.x > 0).focused, "layout stole another pane's focus");
    driver.key(children[0].handle, 0x52, 1, 0x12); // Ctrl+R stays terminal history search.
    driver.key(children[0].handle, 0x52, 3, 0x12); // Ctrl+Shift+R renames the Session.
    driver.key(children[0].handle, 0x50, 3, 0x10); // Ctrl+Shift+P opens the palette.
    driver.key(children[0].handle, 0x41, 0, 0x61);
    addon.write(first.surfaceId, "\x1b[?2004h");
    require("electron").clipboard.writeText("line one\r\nline two");
    driver.key(children[0].handle, 0x56, 1, 0x16);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(inputs.some(([kind, id, value]) => kind === "input" && id === first.surfaceId && value === "\x12"));
    assert(inputs.some(([kind, id, value]) => kind === "input" && id === first.surfaceId && value === "a"));
    assert(inputs.some(([kind, , value]) => kind === "shortcut" && value === "renameSession"));
    assert(inputs.some(([kind, , value]) => kind === "shortcut" && value === "commandPalette"));
    assert(inputs.some(([kind, id, value]) => kind === "input" && id === first.surfaceId && value === "\x1b[200~line one\rline two\x1b[201~"));
    assert(!inputs.some(([kind, , value]) => kind === "input" && value === "\x10"));
    assert.equal(driver.pasteMode(["\x1b[?20", "04h"], "a\r\nb"), "\x1b[200~a\rb\x1b[201~");
    assert.equal(driver.pasteMode(["\x1b]title\x1b[?2004h\x07"], "text"), "text");
    assert.equal(driver.pasteMode(["\x1bP\x1b[?2004h\x1b\\"], "text"), "text");
    assert.equal(driver.pasteMode(["\x1b[?2004h", "\x1bc"], "text"), "text");
    assert.equal(driver.pasteMode(["\x1b[?2004h", "\x1b[?2004l"], "text"), "text");
    const resized = addon.setFrame(first.surfaceId, 0, 0, 600, 400);
    assert(resized.cols > first.cols && resized.rows > first.rows);
    addon.setColorScheme(first.surfaceId, "light");
    addon.setColorScheme(first.surfaceId, "dark");
    addon.write(first.surfaceId, "\r\nNUL\0AFTER-NUL\x1b[6n");
    assert((await addon.readText(first.surfaceId)).includes("NULAFTER-NUL"));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(inputs.some(([kind, id, value]) => kind === "input" && id === first.surfaceId && /\x1b\[\d+;\d+R/.test(value)), JSON.stringify(inputs));
    addon.setVisible(first.surfaceId, false);
    addon.setVisible(first.surfaceId, true);
    addon.scrollToBottom(first.surfaceId);
    assert((await addon.readText(first.surfaceId)).includes("NULAFTER-NUL"));
    console.log("PASS Windows Terminal native: pane geometry/isolation, cursor reset after sidebar resize, Unicode, ANSI pixels, live output under a focused menu, resize, focus, keyboard/shortcuts, bracketed paste, theme, NUL, VT replies, visibility, readback");
  } finally {
    clipboard.write(savedClipboard);
    for (const id of ids) addon.destroy(id);
    window.destroy();
  }
  clearTimeout(timeout);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
