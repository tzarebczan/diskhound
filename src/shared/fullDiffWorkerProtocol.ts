import type { FullDiffResult } from "./contracts";

export interface FullDiffWorkerInput {
  baselineId: string;
  currentId: string;
  baselinePath: string;
  currentPath: string;
  limit?: number;
  /**
   * Override path-case handling. Defaults to platform behavior:
   * case-insensitive on Windows, case-sensitive elsewhere.
   */
  caseSensitive?: boolean;
}

export interface FullDiffWorkerRequest {
  type: "compute";
  requestId: string;
  input: FullDiffWorkerInput;
}

export type FullDiffWorkerResponse =
  | {
      type: "result";
      requestId: string;
      result: FullDiffResult | null;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
    };
