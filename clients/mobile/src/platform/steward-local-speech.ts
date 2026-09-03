import { requireOptionalNativeModule } from "expo";

interface NativeStewardLocalSpeech {
  speak(text: string): Promise<boolean>;
  stop(): void;
}

const native = requireOptionalNativeModule<NativeStewardLocalSpeech>("StewardLocalSpeech");

export const stewardLocalSpeech = {
  async speak(text: string): Promise<boolean> {
    if (native === null) return false;
    return native.speak(text);
  },
  stop(): void {
    native?.stop();
  },
};
