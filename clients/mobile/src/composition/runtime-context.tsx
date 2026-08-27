import { createContext, useContext, type PropsWithChildren } from "react";

import type { MobileRuntime } from "@/application/ports";

const RuntimeContext = createContext<MobileRuntime | undefined>(undefined);

export interface RuntimeProviderProps extends PropsWithChildren {
  runtime: MobileRuntime;
}

export function RuntimeProvider({ children, runtime }: RuntimeProviderProps) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useMobileRuntime(): MobileRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("Mobile runtime provider is missing");
  return runtime;
}
