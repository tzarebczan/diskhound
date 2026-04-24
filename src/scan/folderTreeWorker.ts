import { parentPort } from "node:worker_threads";

import { buildFolderTreeFromIndex } from "../shared/folderTreeWorkerRuntime";
import type {
  FolderTreeWorkerRequest,
  FolderTreeWorkerResponse,
} from "../shared/folderTreeWorkerProtocol";

if (parentPort) {
  parentPort.on("message", (message: FolderTreeWorkerRequest) => {
    if (!message || message.type !== "build") {
      return;
    }

    void buildFolderTreeFromIndex(message.input.indexPath)
      .then((tree) => {
        const response: FolderTreeWorkerResponse = {
          type: "result",
          requestId: message.requestId,
          tree,
        };
        parentPort?.postMessage(response);
      })
      .catch((error) => {
        const response: FolderTreeWorkerResponse = {
          type: "error",
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        };
        parentPort?.postMessage(response);
      });
  });
}
