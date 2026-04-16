import type { DiskhoundNativeApi } from "./shared/contracts";

declare global {
  interface Window {
    diskhound: DiskhoundNativeApi;
  }
}

export {};

