import { spawn } from "node:child_process";
import { watch } from "node:fs";

import waitOn from "wait-on";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const port = Number(process.env.ELECTRON_RENDERER_PORT ?? 4310);
const devServerUrl = `http://127.0.0.1:${port}`;
const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/scan/scanWorker.cjs",
];
const watchedFiles = new Set(["main.cjs", "preload.cjs"]);
const restartDebounceMs = 120;
const forcedShutdownTimeoutMs = 1_500;

await waitOn({
  resources: [`http-get://127.0.0.1:${port}/`, ...requiredFiles.map((filePath) => `file:${filePath}`)],
});

const childEnv = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl };
delete childEnv.ELECTRON_RUN_AS_NODE;

let currentApp = null;
let restartTimer = null;
let shuttingDown = false;

function startApp() {
  if (currentApp || shuttingDown) {
    return;
  }

  const app = spawn(resolveElectronPath(), ["dist-electron/main.cjs"], {
    cwd: desktopDir,
    stdio: "inherit",
    env: childEnv,
  });

  currentApp = app;

  app.once("exit", () => {
    if (currentApp === app) {
      currentApp = null;
    }
    if (!shuttingDown) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    app.once("exit", finish);
    app.kill("SIGTERM");

    setTimeout(() => {
      if (settled) {
        return;
      }
      app.kill("SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(async () => {
    restartTimer = null;
    await stopApp();
    startApp();
  }, restartDebounceMs);
}

const rootWatcher = watch("dist-electron", { persistent: true }, (_eventType, filename) => {
  if (typeof filename === "string" && watchedFiles.has(filename)) {
    scheduleRestart();
  }
});

const workerWatcher = watch("dist-electron/scan", { persistent: true }, (_eventType, filename) => {
  if (filename === "scanWorker.cjs") {
    scheduleRestart();
  }
});

async function shutdown(code) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  rootWatcher.close();
  workerWatcher.close();

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  await stopApp();
  process.exit(code);
}

startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
