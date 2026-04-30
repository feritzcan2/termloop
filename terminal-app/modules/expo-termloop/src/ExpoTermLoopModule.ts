import { requireNativeModule } from 'expo-modules-core';

let nativeModule: any;
try {
  nativeModule = requireNativeModule('ExpoTermLoop');
} catch (err) {
  const loadError = err instanceof Error ? err : new Error(String(err));
  nativeModule = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return () => {
          throw new Error(
            `ExpoTermLoop.${prop} is unavailable: native module not linked. ` +
              `Rebuild the app (pod install + expo run:ios). Original: ${loadError.message}`
          );
        };
      },
    }
  );
}

export default nativeModule;
