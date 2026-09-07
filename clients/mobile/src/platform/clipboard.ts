import { requireOptionalNativeModule } from "expo";

export interface NativeClipboardModule {
  setStringAsync(text: string): Promise<boolean>;
  getImageAsync?(options: {
    format: "png" | "jpeg";
    jpegQuality?: number;
  }): Promise<{
    data: string;
    size: { width: number; height: number };
  } | null>;
}

export interface ClipboardImage {
  uri: string;
  mediaType: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

export interface ClipboardBridge {
  copyText(text: string): Promise<void>;
  pasteImage(): Promise<ClipboardImage | null>;
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
    async pasteImage() {
      if (native?.getImageAsync === undefined) {
        throw new Error(
          "Pasting images requires the latest TermLoop app build. Update or reinstall the app, then try again.",
        );
      }
      const image = await native.getImageAsync({ format: "jpeg", jpegQuality: 0.88 });
      if (image === null) return null;
      const mediaType = image.data.startsWith("data:image/jpeg;base64,")
        ? "image/jpeg"
        : image.data.startsWith("data:image/png;base64,")
          ? "image/png"
          : undefined;
      if (mediaType === undefined
        || !Number.isFinite(image.size.width) || image.size.width <= 0
        || !Number.isFinite(image.size.height) || image.size.height <= 0) {
        throw new Error("The copied image could not be read.");
      }
      return {
        uri: image.data,
        mediaType,
        width: image.size.width,
        height: image.size.height,
      };
    },
  };
}

// Clipboard was added after earlier TermLoop binaries shipped. Resolve it
// optionally so an OTA bundle can still open Project and Session screens on
// those binaries; only the copy action itself requires the newer native build.
const native = requireOptionalNativeModule<NativeClipboardModule>("ExpoClipboard");

export const clipboardBridge = createClipboardBridge(native);
