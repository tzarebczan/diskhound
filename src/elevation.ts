import { spawn, type SpawnOptions } from "node:child_process";
import * as Path from "node:path";

/**
 * Elevation + admin-relaunch helpers. Windows-only by content; the
 * Unix-stub branches return safe defaults so renderer code can read
 * `isElevated` etc. unconditionally.
 *
 * ## Why elevation matters
 *
 * The MFT fast-scan path opens `\\.\C:` for raw reads, which Windows
 * allows only with admin rights. Without elevation the scanner falls
 * through to the parallel walker — correct but 10-20× slower. Getting
 * users elevated (or showing them the tradeoff) is purely UX, but it's
 * the single biggest performance lever available.
 *
 * ## Detection strategy
 *
 * `net session` is the traditional reliable probe: exit code 0 when
 * the current process is elevated, non-zero otherwise. It's ~50-100 ms,
 * works on every Windows SKU since XP, and doesn't need any extra
 * permissions. We cache the result after first call since the answer
 * can't change without a process restart.
 *
 * ## Relaunch strategy
 *
 * `ShellExecute` with the `runas` verb triggers UAC and starts a new
 * elevated instance of the same exe. We use PowerShell's
 * `Start-Process -Verb RunAs` as the portable way to invoke it from
 * Node without needing native bindings.
 *
 * ## Scheduled-task trick
 *
 * Once a user opts in ("always run elevated, no UAC next time"), we
 * register a Task Scheduler job with `RunLevel=Highest`. The app's
 * normal shortcut then triggers `schtasks /run` instead of the exe
 * directly — Windows honors the task's saved elevation credential
 * without re-prompting.
 */

let cachedIsElevated: boolean | null = null;

export async function isElevated(): Promise<boolean> {
  if (process.platform !== "win32") {
    // Non-Windows: treat everything as "elevated enough" since MFT
    // doesn't apply anyway. The UI won't show the banner on these
    // platforms, and startScan's MFT gate is already `cfg(windows)`.
    cachedIsElevated = true;
    return true;
  }
  if (cachedIsElevated !== null) return cachedIsElevated;

  // Ask PowerShell whether the current token is in the local
  // Administrators group with elevation active. This works regardless
  // of whether the Server service is running (which `net session`
  // depends on and was unreliable — e.g. it returns non-zero on
  // machines where the Server service has been disabled by admin or
  // group policy, giving a false "not elevated" reading even for
  // genuinely elevated processes).
  //
  // The check is a single boolean PowerShell expression and typically
  // returns in 100-300 ms. We print "True"/"False" and parse stdout.
  const result = await new Promise<boolean>((resolve) => {
    const psScript =
      "[bool]([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))";
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += String(chunk);
    });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve(false);
    }, 5000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve(false);
        return;
      }
      const out = stdoutBuf.trim().toLowerCase();
      resolve(out === "true");
    });
  });

  cachedIsElevated = result;
  // Log to crashlog so we can diagnose false negatives in user reports.
  // Uses process.stderr so it lands in DiskHound's crash.log via
  // nativeScanner's stderr pump. Intentional — we want to see this in
  // the same log stream as scanner output for correlation.
  process.stderr.write(
    `[elevation] isElevated=${result} (PID ${process.pid})\n`,
  );
  return result;
}

/**
 * Launch a new elevated instance of DiskHound. Returns `true` if the
 * new elevated process was successfully started (caller should quit
 * the current process), `false` if the UAC prompt was dismissed or
 * something else went wrong (caller should KEEP the current process
 * running so the user isn't left with nothing).
 *
 * We do this by running `Start-Process -Verb RunAs ...` via PowerShell
 * with `-PassThru` so we get back the launched process, and we
 * enumerate child processes briefly to confirm. Previously we used
 * `Start-Process` without checking the result and unconditionally
 * `app.quit()`ed the current app 500 ms later — users who hit Cancel
 * on UAC were left with a closed app and no way back except
 * re-launching manually.
 */
export async function relaunchAsAdmin(exePath: string): Promise<boolean> {
  if (process.platform !== "win32") {
    throw new Error("relaunchAsAdmin is Windows-only");
  }

  // Use `try/catch` inside the PS command. On UAC cancel, Start-Process
  // throws; we catch it and exit 1 so the Node side can tell the
  // difference between "UAC accepted, new process running" (exit 0)
  // and "UAC cancelled, no new process" (exit 1).
  //
  // `--relaunched-as-admin` argv flag lets the new child recognise
  // that it's the elevated sibling of a still-alive parent and wait
  // up to 5 s for the single-instance lock. Without this flag the
  // child hit the normal 1.5 s retry path, failed, and quit —
  // "nothing reopens" was the user-visible symptom.
  const psCommand = [
    "try {",
    "  $p = Start-Process",
    ` -FilePath "${exePath.replace(/"/g, '`"')}"`,
    " -ArgumentList '--relaunched-as-admin'",
    " -Verb RunAs",
    " -PassThru",
    " -ErrorAction Stop;",
    "  if ($p) { exit 0 } else { exit 1 }",
    "} catch {",
    "  exit 1",
    "}",
  ].join("");

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCommand],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true } as SpawnOptions,
    );
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve(null);
    }, 60_000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  return exitCode === 0;
}

// ── Scheduled Task registration ────────────────────────────────────
//
// After the one-time UAC prompt to create a scheduled task, the user
// can launch the app elevated on every boot with zero further UAC
// prompts. The task stores the elevation intent; Windows trusts the
// saved credential.
//
// Task naming: `DiskHound-FastScan` — specific enough to avoid
// collision, friendly enough to be recognizable in Task Scheduler UI
// if the user ever goes looking.

const SCHEDULED_TASK_NAME = "DiskHound-FastScan";

export async function hasScheduledTask(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  return await new Promise<boolean>((resolve) => {
    const child = spawn("schtasks", ["/query", "/tn", SCHEDULED_TASK_NAME], {
      // Capture stderr so we can distinguish "ERROR: The system cannot
      // find the file specified." (task genuinely doesn't exist, exit 1)
      // from "ERROR: Access is denied." (task exists but non-elevated
      // user can't see it — must return true so the auto-relaunch path
      // still kicks in). Before this fix, an admin-group-owned task was
      // invisible to the user's normal shell and hasScheduledTask kept
      // returning false.
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderrBuf = "";
    child.stderr?.on("data", (chunk) => { stderrBuf += String(chunk); });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve(false);
    }, 2000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(true);
        return;
      }
      // Exit code != 0. Interpret stderr:
      //   - "cannot find the file" / "does not exist" → task really gone
      //   - "access is denied" / "access denied" → task exists but we
      //     can't read its metadata from this shell. Still treat as
      //     registered so the auto-relaunch flow runs (it'll `schtasks
      //     /run` which has its own permission story).
      const lower = stderrBuf.toLowerCase();
      if (lower.includes("access is denied") || lower.includes("access denied")) {
        resolve(true);
        return;
      }
      resolve(false);
    });
  });
}

/**
 * Create or update a scheduled task that launches the app elevated.
 * The create step itself triggers UAC (we pipe through a PowerShell
 * Start-Process -Verb RunAs wrapper around schtasks). Subsequent
 * `schtasks /run /tn DiskHound-FastScan` invocations honor the saved
 * elevation with zero prompts.
 *
 * XML task definition gives us the most control — we can pin:
 *   - RunLevel: HighestAvailable (== elevated)
 *   - LogonType: InteractiveToken (runs in user's session, GUI visible)
 *   - No time trigger (on-demand only)
 *
 * Returns true on success, false if anything fails (cancelled UAC,
 * invalid exe path, schtasks errors). Caller surfaces the result as
 * a toast in settings.
 */
export async function registerScheduledTask(exePath: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  // Look up the current user's SID so the task's Principal is tied to
  // THIS user (not the Administrators group). Without this the task
  // is only runnable/queryable by elevated admin shells — a regular
  // non-elevated invocation of schtasks /run against an
  // Administrators-principal task returns "Access is denied" even
  // though the invoking user IS in that group. See crash.log 0.4.3:
  //   [run-scheduled-task] schtasks /run failed: exit=1 stderr=ERROR: Access is denied.
  // UserId + LogonType=InteractiveToken + RunLevel=HighestAvailable
  // is the right combo: "run as this user, in their interactive
  // desktop session, elevated if they can elevate." It matches what
  // Task Scheduler MMC creates when you check "Run with highest
  // privileges" on a normal user task.
  const userSid = await getCurrentUserSid();
  const taskXml = buildTaskSchedulerXml(exePath, userSid);
  // Write to a temp file; schtasks needs a file path.
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const tempPath = Path.join(
    os.tmpdir(),
    `diskhound-task-${process.pid}-${Date.now()}.xml`,
  );
  try {
    // schtasks parses XML as UTF-16 LE with a BOM. Writing as plain
    // UTF-8 yields "The task XML is malformed" despite the content
    // being syntactically valid — confirmed in our testing on Win11.
    const bom = Buffer.from([0xFF, 0xFE]);
    const body = Buffer.from(taskXml, "utf16le");
    await fs.writeFile(tempPath, Buffer.concat([bom, body]));

    const success = await new Promise<boolean>((resolve) => {
      // Wrap `schtasks /create` in a PowerShell elevation so the user
      // sees exactly one UAC prompt for the whole opt-in gesture.
      const cmd = `Start-Process -FilePath schtasks -ArgumentList '/create', '/tn', '${SCHEDULED_TASK_NAME}', '/xml', '"${tempPath.replace(/"/g, '`"')}"', '/f' -Verb RunAs -Wait -WindowStyle Hidden`;
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-Command", cmd],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let stderrBuf = "";
      child.stderr?.on("data", (chunk) => { stderrBuf += String(chunk); });
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* noop */ }
        resolve(false);
      }, 30_000);
      child.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== 0 && stderrBuf) {
          console.error(`[elevation] registerScheduledTask stderr: ${stderrBuf}`);
        }
        resolve(code === 0);
      });
    });
    return success;
  } finally {
    try { await fs.unlink(tempPath); } catch { /* best-effort cleanup */ }
  }
}

export async function unregisterScheduledTask(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  return await new Promise<boolean>((resolve) => {
    const cmd = `Start-Process -FilePath schtasks -ArgumentList '/delete', '/tn', '${SCHEDULED_TASK_NAME}', '/f' -Verb RunAs -Wait -WindowStyle Hidden`;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", cmd],
      { stdio: ["ignore", "ignore", "ignore"], windowsHide: true },
    );
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve(false);
    }, 15_000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

/**
 * Trigger the already-registered scheduled task. This is the magic
 * path: launches DiskHound elevated with NO UAC prompt because the
 * task's stored credential covers it.
 *
 * Returns a rich result: `{ok, message}` where `message` carries the
 * schtasks stderr when something failed so the UI can surface a real
 * diagnostic in the toast ("The task image is corrupt" / "Access is
 * denied" / "The specified account name is invalid" are all real
 * failure modes we've seen in the wild). Previously we just returned
 * `false` and the user saw a generic "Couldn't launch via scheduled
 * task" with no clue why.
 */
export interface RunTaskResult {
  ok: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

export async function runScheduledTaskNow(): Promise<RunTaskResult> {
  if (process.platform !== "win32") {
    return { ok: false, message: "Scheduled-task elevation is Windows-only." };
  }
  return await new Promise<RunTaskResult>((resolve) => {
    const child = spawn(
      "schtasks",
      ["/run", "/tn", SCHEDULED_TASK_NAME],
      // Capture stdout + stderr so we can surface schtasks's own error
      // text in the UI. windowsHide so no console window flashes.
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout?.on("data", (chunk) => { stdoutBuf += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderrBuf += String(chunk); });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve({ ok: false, message: "schtasks /run timed out after 10s" });
    }, 10_000);
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, message: err.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      const stdout = stdoutBuf.trim();
      const stderr = stderrBuf.trim();
      if (code === 0) {
        resolve({ ok: true, exitCode: 0, stdout, stderr });
        return;
      }
      // schtasks sometimes prints its error to stdout (English locale)
      // and sometimes to stderr. Grab whichever is non-empty as the
      // user-facing message. Fall back to the exit code if both are
      // blank (rare — usually means schtasks itself crashed).
      const rawMessage = stderr || stdout || `schtasks exited with code ${code}`;
      resolve({
        ok: false,
        exitCode: code,
        stdout,
        stderr,
        message: rawMessage.replace(/^ERROR:\s*/i, "").slice(0, 400),
      });
    });
  });
}

/**
 * Count DiskHound.exe processes currently running. Used by the
 * startup auto-relaunch path to verify the elevated sibling actually
 * came up before we quit this non-elevated instance. Returns 0 on
 * any error (caller treats that as "don't quit, stay safe").
 */
export async function countDiskHoundProcesses(): Promise<number> {
  if (process.platform !== "win32") return 0;
  return await new Promise<number>((resolve) => {
    const child = spawn(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq DiskHound.exe", "/FO", "CSV", "/NH"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let buf = "";
    child.stdout?.on("data", (chunk) => { buf += String(chunk); });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve(0);
    }, 5000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(0);
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      // tasklist /NH prints one CSV row per matching process.
      // "INFO: No tasks are running which match..." when zero matches;
      // in that case no quoted rows, count is 0.
      const lines = buf
        .split(/\r?\n/)
        .filter((l) => l.startsWith(`"DiskHound.exe"`));
      resolve(lines.length);
    });
  });
}

// ── UAC-elevated EasyMove ──────────────────────────────────────────
//
// Runs Move-Item + New-Item <Symlink|Junction> in a single
// UAC-elevated PowerShell. Exactly one UAC prompt per invocation.
// Caller (main process) still writes the EasyMoveRecord to disk; this
// function only performs the filesystem ops that need elevation.
//
// Returns { ok: true } on success. On failure, `message` is whatever
// PowerShell wrote to stderr (usually actionable: "Access is denied",
// "Cannot create a file when that file already exists", etc.) or
// "UAC cancelled" if the user declined the prompt.

export interface RunElevatedEasyMoveResult {
  ok: boolean;
  message?: string;
  cancelled?: boolean;
}

function psEscapeSingleQuoted(s: string): string {
  // PowerShell single-quoted strings escape the single quote by
  // doubling it. Double quotes don't need escaping in single-quoted
  // strings. Everything else is literal. Safe for arbitrary paths.
  return s.replace(/'/g, "''");
}

export async function runElevatedEasyMove(
  sourcePath: string,
  destinationPath: string,
  isDirectory: boolean,
): Promise<RunElevatedEasyMoveResult> {
  if (process.platform !== "win32") {
    return { ok: false, message: "Elevated easy-move is Windows-only." };
  }

  // The inner PS command. Runs in the elevated context.
  //   - Move-Item -Force so a partially-copied dest from a prior attempt doesn't block us.
  //   - -LiteralPath so paths with brackets, dollar signs, etc. aren't wildcard-expanded.
  //   - New-Item ItemType is Junction for directories (cheap, no admin
  //     was needed but we're already elevated) and SymbolicLink for
  //     files (only needs admin / Dev Mode — we've got admin).
  //   - Output is piped to Out-Null so stderr stays clean for error reporting.
  const linkType = isDirectory ? "Junction" : "SymbolicLink";
  const innerScript =
    `Move-Item -LiteralPath '${psEscapeSingleQuoted(sourcePath)}' ` +
    `-Destination '${psEscapeSingleQuoted(destinationPath)}' -Force; ` +
    `New-Item -ItemType ${linkType} -Path '${psEscapeSingleQuoted(sourcePath)}' ` +
    `-Target '${psEscapeSingleQuoted(destinationPath)}' -Force | Out-Null`;

  // We wrap the inner script in a Start-Process -Verb RunAs so Windows
  // raises the UAC prompt and re-launches PowerShell as admin. -Wait
  // blocks until the elevated PS exits, so we can read its exit code.
  // We capture the elevated PS's stdout/stderr via redirection to
  // temp files — Start-Process -Verb RunAs doesn't let the parent
  // inherit stdio handles, so redirect-to-file is the only way to
  // see error text.
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const stdoutFile = Path.join(os.tmpdir(), `diskhound-emv-out-${process.pid}-${Date.now()}.txt`);
  const stderrFile = Path.join(os.tmpdir(), `diskhound-emv-err-${process.pid}-${Date.now()}.txt`);

  const wrapperScript =
    `try { ` +
      `$p = Start-Process powershell ` +
        `-ArgumentList '-NoProfile','-NonInteractive','-Command',` +
        `"${innerScript.replace(/"/g, '`"')}" ` +
        `-Verb RunAs -PassThru -Wait ` +
        `-RedirectStandardOutput '${psEscapeSingleQuoted(stdoutFile)}' ` +
        `-RedirectStandardError  '${psEscapeSingleQuoted(stderrFile)}' ` +
        `-ErrorAction Stop; ` +
      `if ($p.ExitCode -eq 0) { exit 0 } else { exit $p.ExitCode } ` +
    `} catch { ` +
      `Write-Error $_.Exception.Message; ` +
      `exit 1223 ` + // 1223 = ERROR_CANCELLED on Windows (UAC decline)
    `}`;

  try {
    return await new Promise<RunElevatedEasyMoveResult>((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", wrapperScript],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let wrapperStderr = "";
      child.stderr?.on("data", (chunk) => { wrapperStderr += String(chunk); });
      const timeout = setTimeout(() => {
        try { child.kill(); } catch { /* noop */ }
        resolve({ ok: false, message: "Elevated move timed out after 60 s" });
      }, 60_000);
      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ ok: false, message: err.message });
      });
      child.on("exit", async (code) => {
        clearTimeout(timeout);
        // Read the elevated PS's captured stderr (best-effort — the
        // files may not exist if Start-Process never got that far).
        let innerStderr = "";
        try {
          innerStderr = await fs.readFile(stderrFile, "utf8").catch(() => "");
        } catch {
          /* noop */
        }
        // Cleanup temp files
        void fs.unlink(stdoutFile).catch(() => {});
        void fs.unlink(stderrFile).catch(() => {});

        if (code === 0) {
          resolve({ ok: true });
          return;
        }
        if (code === 1223) {
          // User declined UAC. Don't treat as generic error — surface
          // it as a friendly "cancelled" so the UI can differentiate.
          resolve({ ok: false, cancelled: true, message: "UAC was cancelled." });
          return;
        }
        const combined = [innerStderr, wrapperStderr]
          .map((s) => s.trim())
          .filter(Boolean)
          .join(" · ");
        resolve({
          ok: false,
          message: combined || `Elevated move failed (exit ${code})`,
        });
      });
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Query the current user's SID via PowerShell's WindowsIdentity API.
 * Used when registering the scheduled task so the Principal is bound
 * to this specific user (not the Administrators group). Returns null
 * on failure; caller falls back to the group-based Principal which
 * at least works on admin-only machines.
 */
async function getCurrentUserSid(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  return await new Promise<string | null>((resolve) => {
    const script =
      "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let buf = "";
    child.stdout?.on("data", (chunk) => { buf += String(chunk); });
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      resolve(null);
    }, 5000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { resolve(null); return; }
      const trimmed = buf.replace(/^\uFEFF/, "").trim();
      // Windows SIDs always start with "S-". Anything else is garbage.
      if (/^S-\d+-\d+(?:-\d+)*$/i.test(trimmed)) {
        resolve(trimmed);
      } else {
        resolve(null);
      }
    });
  });
}

function buildTaskSchedulerXml(exePath: string, userSid: string | null): string {
  const escaped = exePath
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  // Principal: UserId + InteractiveToken when we have a SID; fall
  // back to the Administrators group otherwise (admin-only machine).
  // HighestAvailable gives the invoking user elevated rights if they
  // have them, which is what we want — same effect as the old
  // GroupId=S-1-5-32-544 for admin users, but also runnable +
  // queryable from the user's non-elevated shell.
  const principalBody = userSid
    ? `<UserId>${userSid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>`
    : `<GroupId>S-1-5-32-544</GroupId>
      <RunLevel>HighestAvailable</RunLevel>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>DiskHound</Author>
    <Description>Launches DiskHound with the MFT fast-scan path enabled. Requires admin; on-demand only.</Description>
    <URI>\\${SCHEDULED_TASK_NAME}</URI>
    <Date>${now}</Date>
  </RegistrationInfo>
  <Triggers />
  <Principals>
    <Principal id="Author">
      ${principalBody}
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escaped}</Command>
      <Arguments>--launched-by-task</Arguments>
    </Exec>
  </Actions>
</Task>`;
}
