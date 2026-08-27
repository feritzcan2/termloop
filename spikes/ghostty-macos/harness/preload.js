const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", {
  toggleOverlay: (shown) => ipcRenderer.send("toggle-overlay", shown),
  focusSurface: (index) => ipcRenderer.send("focus-surface", index),
  onOverlay: (cb) => ipcRenderer.on("overlay", (_e, shown) => cb(shown)),
});
