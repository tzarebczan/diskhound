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

  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 16_384) {
      stderrBuffer = stderrBuffer.slice(-16_384);
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
