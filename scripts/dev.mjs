import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(__dirname, "..");
const bunExecutable = process.versions.bun ? process.execPath : "bun";

const tasks = [
  { name: "dev:renderer", color: 36, args: ["run", "dev:renderer"] },
  { name: "dev:electron:bundle", color: 33, args: ["run", "dev:electron:bundle"] },
  { name: "dev:electron", color: 35, args: ["run", "dev:electron"] },
];

const children = new Map();
let shuttingDown = false;
let exitCode = 0;

function prefix(taskName, colorCode, line) {
  const label = `\x1b[${colorCode}m${taskName.padEnd(19)}\x1b[0m`;
  process.stdout.write(`${label} | ${line}\n`);
}

function pipeOutput(task, child) {
  const attach = (stream, fallbackColor) => {
    if (!stream) return;
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
      if (line.trim().length === 0) return;
      prefix(task.name, fallbackColor, line);
    });
  };

  attach(child.stdout, task.color);
  attach(child.stderr, 31);
}

function spawnTask(task) {
  const child = spawn(bunExecutable, task.args, {
    cwd: desktopDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  children.set(task.name, child);
  pipeOutput(task, child);

  child.once("exit", (code, signal) => {
    children.delete(task.name);

    if (shuttingDown) {
      return;
    }

    const detail = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    prefix(task.name, 31, `exited with ${detail}`);
    exitCode = code ?? 1;
    void shutdown(exitCode);
  });
}

async function terminateChild(child) {
  if (!child?.pid) return;

  if (process.platform === "win32") {
    await new Promise((resolvePromise) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolvePromise());
      killer.once("error", () => resolvePromise());
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Process already exited.
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const runningChildren = [...children.values()];
  await Promise.all(runningChildren.map((child) => terminateChild(child)));
  process.exit(code);
}

for (const task of tasks) {
  spawnTask(task);
}

process.once("SIGINT", () => {
  exitCode = 130;
  void shutdown(exitCode);
});

process.once("SIGTERM", () => {
  exitCode = 143;
  void shutdown(exitCode);
});
