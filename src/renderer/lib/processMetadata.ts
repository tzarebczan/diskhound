export interface ProcessMetadataSource {
  pid: number;
  name: string;
  commandLine?: string | null;
  commandPreview?: string | null;
  parentPid?: number | null;
  parentName?: string | null;
  workingDirectory?: string | null;
  exePath?: string | null;
}

export interface ProcessMetadataParts {
  command: string | null;
  origin: string | null;
  parent: string | null;
}

export function prettyProcessName(name: string): string {
  if (/\.exe$/i.test(name)) return name.slice(0, -4);
  return name;
}

export function processSearchText(proc: ProcessMetadataSource): string {
  return [
    proc.name,
    proc.pid,
    proc.commandPreview,
    proc.commandLine,
    proc.exePath,
    proc.workingDirectory,
    proc.parentName,
    proc.parentPid,
  ].filter((value) => value !== null && value !== undefined)
    .join(" ")
    .toLowerCase();
}

export function processMetadataParts(proc: ProcessMetadataSource): ProcessMetadataParts | null {
  const command = proc.commandPreview || proc.commandLine || null;
  const origin = proc.workingDirectory
    ? `from ${proc.workingDirectory}`
    : proc.exePath
      ? `exe ${proc.exePath}`
      : null;
  const parent = proc.parentName
    ? `parent ${prettyProcessName(proc.parentName)} (${proc.parentPid ?? "?"})`
    : proc.parentPid
      ? `parent PID ${proc.parentPid}`
      : null;
  if (!command && !origin && !parent) return null;
  return { command, origin, parent };
}
