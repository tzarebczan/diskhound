import { parentPort } from "node:worker_threads";

import { computeFullDiffFromIndexFiles } from "../shared/fullDiffWorkerRuntime";
import type {
  FullDiffWorkerRequest,
  FullDiffWorkerResponse,
} from "../shared/fullDiffWorkerProtocol";

if (parentPort) {
  parentPort.on("message", (message: FullDiffWorkerRequest) => {
    if (!message || message.type !== "compute") {
      return;
    }

    void computeFullDiffFromIndexFiles(message.input)
      .then((result) => {
        const response: FullDiffWorkerResponse = {
          type: "result",
          requestId: message.requestId,
          result,
        };
        parentPort?.postMessage(response);
      })
      .catch((error) => {
        const response: FullDiffWorkerResponse = {
          type: "error",
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        };
        parentPort?.postMessage(response);
      });
  });
}
