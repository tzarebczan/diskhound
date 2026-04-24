import type { DiskhoundNativeApi, DiskhoundPlatform } from "../shared/contracts";

// Lazy proxy: defers window.diskhound access until actual method calls.
// This prevents crashes when the preload bridge hasn't been injected yet
// (e.g. Vite HMR reload, first paint before contextBridge completes).
export const nativeApi: DiskhoundNativeApi = new Proxy(
  {} as DiskhoundNativeApi,
  {
    get(_target, prop: string) {
      const bridge = window.diskhound;

      if (!bridge) {
        // Platform is a static string the preload sets eagerly. Before
        // the bridge lands (Vite HMR, first paint), fall back to UA
        // sniffing so renderer components can still gate platform-
        // specific UI without waiting on an async handshake.
        if (prop === "platform") {
          return guessPlatformFromUserAgent();
        }
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

function guessPlatformFromUserAgent(): DiskhoundPlatform {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "win32";
  if (ua.includes("mac os") || ua.includes("macintosh")) return "darwin";
  return "linux";
}
