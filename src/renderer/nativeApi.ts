import type { DiskhoundNativeApi } from "../shared/contracts";

// Lazy proxy: defers window.diskhound access until actual method calls.
// This prevents crashes when the preload bridge hasn't been injected yet
// (e.g. Vite HMR reload, first paint before contextBridge completes).
export const nativeApi: DiskhoundNativeApi = new Proxy(
  {} as DiskhoundNativeApi,
  {
    get(_target, prop: string) {
      const bridge = window.diskhound;

      if (!bridge) {
        // Event listeners: return no-op unsubscriber
        if (prop.startsWith("on")) {
          return (_listener: unknown) => () => {};
        }
        // Sync fire-and-forget methods
        if (prop === "minimizeToTray") {
          return () => {};
        }
        // Async methods: resolve with safe defaults
        return (..._args: unknown[]) => Promise.resolve(null);
      }

      const value = (bridge as unknown as Record<string, unknown>)[prop];
      // Bind functions so `this` stays correct inside the bridge
      return typeof value === "function" ? (value as Function).bind(bridge) : value;
    },
  },
);
