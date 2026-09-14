import { app, dialog, type IpcMain, type IpcMainInvokeEvent } from "electron";
import path from "node:path";
import type { ConnectionProfileConnectInput, ConnectionProfileConnectResult } from "../connection-profile-types.js";
import type { SshSetupInput, SshSetupLogin } from "../ssh-setup-types.js";
import { SshSetupManager } from "../platform/ssh-setup.js";

declare const TERMLOOP_SERVER_RELEASE_VERSION: string;

export function registerSshSetupIpc(
  handle: IpcMain["handle"], requireRenderer: (event: IpcMainInvokeEvent) => void,
  assets: string, connect: (input: ConnectionProfileConnectInput) => Promise<ConnectionProfileConnectResult>,
  verify: (profileId: string) => Promise<unknown>,
): void {
  let manager: SshSetupManager | undefined;
  const observed = new Set<number>();
  const get = (event: IpcMainInvokeEvent) => {
    requireRenderer(event);
    manager ??= new SshSetupManager(app.getPath("userData"), path.join(assets, "server-setup"), TERMLOOP_SERVER_RELEASE_VERSION);
    if (!observed.has(event.sender.id)) {
      observed.add(event.sender.id);
      event.sender.once("destroyed", () => { manager?.cancelOwner(event.sender.id); observed.delete(event.sender.id); });
    }
    return manager;
  };
  handle("termloop:ssh-setup-current", (event) => get(event).current(event.sender.id));
  handle("termloop:ssh-setup-start", (event, input: SshSetupInput) => get(event).start(event.sender.id, input));
  handle("termloop:ssh-setup-login", (event, input: SshSetupLogin) => get(event).login(event.sender.id, input));
  handle("termloop:ssh-setup-install", (event, id: string) => get(event).install(event.sender.id, id));
  handle("termloop:ssh-setup-status", (event, id: string) => get(event).status(event.sender.id, id));
  handle("termloop:ssh-setup-cancel", (event, id: string) => {
    get(event).cancel(event.sender.id, id);
  });
  handle("termloop:ssh-setup-package", async (event, id: string) => {
    const service = get(event);
    service.status(event.sender.id, id);
    const choice = await dialog.showOpenDialog({ title: "Choose a TermLoop Linux server package", properties: ["openFile"], filters: [{ name: "TermLoop server package", extensions: ["gz"] }] });
    return !choice.canceled && choice.filePaths[0]
      ? service.selectArchive(event.sender.id, id, choice.filePaths[0])
      : service.status(event.sender.id, id);
  });
  handle("termloop:ssh-setup-connect", (event, id: string) => get(event).connect(event.sender.id, id, connect, verify));
}
