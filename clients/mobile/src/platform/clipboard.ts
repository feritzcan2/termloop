import { requireOptionalNativeModule } from "expo";

export interface NativeClipboardModule {
  setStringAsync(text: string): Promise<boolean>;
}

export interface ClipboardBridge {
  copyText(text: string): Promise<void>;
}

export function createClipboardBridge(native: NativeClipboardModule | null): ClipboardBridge {
  return {
    async copyText(text) {
      if (native === null) {
        throw new Error(
          "Copying requires the latest TermLoop app build. Update or reinstall the app, then try again.",
        );
      }
      await native.setStringAsync(text);
    },
  };
}

// Clipboard was added after earlier TermLoop binaries shipped. Resolve it
// optionally so an OTA bundle can still open Project and Session screens on
// those binaries; only the copy action itself requires the newer native build.
const native = requireOptionalNativeModule<NativeClipboardModule>("ExpoClipboard");

export const clipboardBridge = createClipboardBridge(native);
