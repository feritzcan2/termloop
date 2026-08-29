import { requireOptionalNativeModule } from "expo";

export interface StewardLiveActivityState {
  projectId: string;
  projectName: string;
  status: string;
  microphoneEnabled: boolean;
}

interface NativeStewardLiveActivity {
  sync(
    projectId: string,
    projectName: string,
    status: string,
    microphoneEnabled: boolean,
  ): Promise<boolean>;
  end(): Promise<void>;
}

const native = requireOptionalNativeModule<NativeStewardLiveActivity>("StewardLiveActivity");

export const stewardLiveActivity = {
  async sync(state: StewardLiveActivityState): Promise<boolean> {
    if (native === null) return false;
    return native.sync(state.projectId, state.projectName, state.status, state.microphoneEnabled);
  },
  async end(): Promise<void> {
    await native?.end();
  },
};
