import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("r0", {
  config: () => ipcRenderer.invoke("r0:config"),
  result: (value: unknown) => ipcRenderer.send("r0:result", value)
});
