export type AppUpdateConfigContext = {
  electronPlatformName: string;
  appOutDir: string;
  packager: {
    getResourcesDir(appOutDir: string): string;
    config: { publish?: unknown };
    appInfo: { updaterCacheDirName: string };
  };
};

export default function writeAppUpdateConfig(context: AppUpdateConfigContext): Promise<void>;
