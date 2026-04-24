import { spawn, type ChildProcessByStdio } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";
import * as Readline from "node:readline";
import type { Readable } from "node:stream";

import type { ScanStartInput, WorkerToMainMessage } from "./shared/contracts";

const STOP_TIMEOUT_MS = 1_500;
const NATIVE_BINARY_NAME =
  process.platform === "win32" ? "diskhound-native-scanner.exe" : "diskhound-native-scanner";

export interface NativeScannerSession {
  kind: "native";
  stop: () => Promise<void>;
}

export interface NativeScannerCallbacks {
  onMessage: (message: WorkerToMainMessage) => void;
  /** Called for every stderr line the scanner emits. Used to surface
   *  phase-timing diagnostics without parsing them as protocol
   *  messages. Optional — many callers don't care. */
  onStderrLine?: (line: string) => void;
  onError: (error: Error) => void;
}

export function resolveNativeScannerBinary(projectRoot: string): string | null {
  const overridePath = process.env.DISKHOUND_NATIVE_SCANNER_PATH?.trim();
  if (overridePath && FS.existsSync(overridePath)) {
    return overridePath;
  }

  const candidates = [
    // Packaged app: electron-builder extraResources → process.resourcesPath/native/
    ...(process.resourcesPath
      ? [Path.join(process.resourcesPath, "native", NATIVE_BINARY_NAME)]
      : []),
    // Development: cargo build output
    Path.join(
      projectRoot,
      "native",
      "diskhound-native-scanner",
      "target",
      "release",
      NATIVE_BINARY_NAME,
    ),
    Path.join(
      projectRoot,
      "native",
      "diskhound-native-scanner",
      "target",
      "debug",
      NATIVE_BINARY_NAME,
    ),
    Path.join(projectRoot, "resources", "native", NATIVE_BINARY_NAME),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function createNativeScannerSession(
  projectRoot: string,
  input: ScanStartInput,
  callbacks: NativeScannerCallbacks,
): NativeScannerSession | null {
  if (process.platform !== "win32") {
    return null;
  }

  const binaryPath = resolveNativeScannerBinary(projectRoot);
  if (!binaryPath) {
    console.warn("[nativeScanner] No binary found — falling back to JS worker");
    return null;
  }

  const args = ["--root", input.rootPath];
  if (input.limits?.topFileLimit) {
    args.push("--top-file-limit", String(input.limits.topFileLimit));
  }
  if (input.limits?.topDirectoryLimit) {
    args.push("--top-directory-limit", String(input.limits.topDirectoryLimit));
  }
  if (input.indexOutput) {
    args.push("--index-output", input.indexOutput);
  }
  // Phase-1 smart-rescan: pass the previous scan's index so the Rust
  // scanner can skip unchanged subtrees.
  if (input.baselineIndex) {
    args.push("--baseline-index", input.baselineIndex);
  }
  // Folder-tree sidecar — Rust emits a pre-built parent→children map
  // directly, so Node skips the 5-minute streaming build + 4 GB worker
  // heap on drive-scale scans.
  if (input.folderTreeOutput) {
    args.push("--folder-tree-output", input.folderTreeOutput);
  }

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(binaryPath, args, {
      cwd: Path.dirname(binaryPath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    console.warn(`[nativeScanner] spawn failed at ${binaryPath}:`, error);
    return null;
  }

  // Catch spawn errors that fire async (ENOENT, EACCES, etc.)
  child.on("error", (error: NodeJS.ErrnoException) => {
    console.warn(`[nativeScanner] process error at ${binaryPath}:`, error);
    callbacks.onError(error);
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stderrBuffer = "";
  let stopping = false;
  let completed = false;

  const reader = Readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  reader.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    try {
      const message = JSON.parse(line) as WorkerToMainMessage;
      if (message.type === "done") {
        completed = true;
      }
      callbacks.onMessage(message);
    } catch (error) {
      callbacks.onError(
        error instanceof Error ? error : new Error(`Failed to parse native scanner output: ${line}`),
      );
    }
  });

  // We split stderr on newlines so the main process can treat each
  // line individually — the Rust scanner emits human-readable phase
  // timings like
  //   [diskhound-native-scanner] phase: walk took 412315 ms (files=7M, ...)
  // which are the single most useful diagnostic when investigating
  // why a scan took as long as it did. The final trailing buffer
  // covers any line that hasn't been newline-terminated yet on exit.
  let stderrLineBuffer = "";
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 16_384) {
      stderrBuffer = stderrBuffer.slice(-16_384);
    }
    stderrLineBuffer += chunk;
    while (true) {
      const nl = stderrLineBuffer.indexOf("\n");
      if (nl === -1) break;
      const line = stderrLineBuffer.slice(0, nl).replace(/\r$/, "");
      stderrLineBuffer = stderrLineBuffer.slice(nl + 1);
      if (line.length > 0) callbacks.onStderrLine?.(line);
    }
  });

  child.once("error", (error) => {
    if (!stopping) {
      callbacks.onError(error);
    }
  });

  child.once("exit", (code, signal) => {
    reader.close();
    if (stopping || completed) {
      return;
    }

    const message = stderrBuffer.trim() || `Native scanner exited unexpectedly (code=${code}, signal=${signal ?? "none"}).`;
    callbacks.onError(new Error(message));
  });

  return {
    kind: "native",
    stop: () => stopNativeChild(child, () => {
      stopping = true;
      reader.close();
    }),
  };
}

async function stopNativeChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  beforeStop: () => void,
): Promise<void> {
  beforeStop();

  await new Promise<void>((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    child.once("exit", finish);
    child.kill("SIGTERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      child.kill("SIGKILL");
      finish();
    }, STOP_TIMEOUT_MS).unref();
  });
}
