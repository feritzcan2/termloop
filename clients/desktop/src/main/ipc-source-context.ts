import { AsyncLocalStorage } from "node:async_hooks";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  isProfiledIpcChannel,
  parseConnectionProfileEnvelope,
} from "../source-operations.js";
import { decorateConnectionEntities } from "../connection-scope.js";

type InvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => any;
const sourceContext = new AsyncLocalStorage<string>();

export function currentConnectionProfileId(): string {
  return sourceContext.getStore() ?? "local";
}

export function sourceAwareIpcHandle(ipc: Pick<IpcMain, "handle">): IpcMain["handle"] {
  return ((channel: string, listener: InvokeListener) => {
    ipc.handle(channel, (event, ...args) => {
      if (!isProfiledIpcChannel(channel)) return listener(event, ...args);
      const profileId = parseConnectionProfileEnvelope(args.at(-1));
      if (!profileId) throw new Error("connectionProfileRequired");
      args.pop();
      return sourceContext.run(profileId, async () => decorateConnectionEntities(
        await listener(event, ...args),
        { connectionProfileId: profileId },
      ));
    });
  }) as IpcMain["handle"];
}
