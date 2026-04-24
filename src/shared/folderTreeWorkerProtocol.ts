/**
 * Message shapes for the folder-tree build worker.
 *
 * The worker streams a completed scan index (NDJSON.gz) off disk and
 * produces the parent → children map that powers the Folders tab.
 * It lives in its own thread so the ~5-minute build on a drive-scale
 * scan (7M+ files) doesn't block the main thread's event loop —
 * specifically so setInterval heartbeats ([memory] logs) and IPC
 * handlers keep running while the tree builds.
 */

export type CompactFolderFileRecord = {
  name: string;
  size: number;
  modifiedAt: number;
};

export type FolderNodeRecord = {
  dirs: { path: string; size: number; fileCount: number }[];
  files: CompactFolderFileRecord[];
};

/** Serialized folder tree — a plain array of [key, node] pairs so it
 *  survives postMessage without needing a Map transfer. Main thread
 *  reconstructs the Map on receipt. */
export type SerializedFolderTree = [string, FolderNodeRecord][];

export interface FolderTreeWorkerInput {
  indexPath: string;
}

export interface FolderTreeWorkerRequest {
  type: "build";
  requestId: string;
  input: FolderTreeWorkerInput;
}

export type FolderTreeWorkerResponse =
  | {
      type: "result";
      requestId: string;
      tree: SerializedFolderTree;
    }
  | {
      type: "error";
      requestId: string;
      message: string;
      stack?: string;
    };
