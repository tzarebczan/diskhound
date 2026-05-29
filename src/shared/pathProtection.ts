export type ProtectionPlatform = "win32" | "darwin" | "linux" | NodeJS.Platform;
export interface ExcludedFolderActionBlocker {
  folder: string;
  reason: "inside" | "contains";
}

function runtimePlatform(): ProtectionPlatform {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform;
  }
  return "linux";
}

function platformFamily(platform: ProtectionPlatform = runtimePlatform()): "win32" | "darwin" | "linux" {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

function envValue(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const env = process.env as Record<string, string | undefined>;
  return env[name];
}

export function getDefaultExcludedFolderPaths(platform: ProtectionPlatform = runtimePlatform()): string[] {
  switch (platformFamily(platform)) {
    case "win32": {
      const systemDrive = envValue("SystemDrive") || "C:";
      const windowsDir = envValue("SystemRoot") || envValue("WINDIR") || `${systemDrive}\\Windows`;
      const programFiles = envValue("ProgramFiles") || `${systemDrive}\\Program Files`;
      const programFilesX86 = envValue("ProgramFiles(x86)") || `${systemDrive}\\Program Files (x86)`;
      const programData = envValue("ProgramData") || `${systemDrive}\\ProgramData`;
      return normalizeExcludedFolderPaths([
        windowsDir,
        programFiles,
        programFilesX86,
        programData,
        `${systemDrive}\\System Volume Information`,
        `${systemDrive}\\$Recycle.Bin`,
        `${systemDrive}\\Recovery`,
      ], platform);
    }
    case "darwin":
      return [
        "/System",
        "/Library",
        "/private",
        "/bin",
        "/sbin",
        "/usr",
      ];
    default:
      return [
        "/bin",
        "/boot",
        "/dev",
        "/etc",
        "/lib",
        "/lib64",
        "/proc",
        "/root",
        "/run",
        "/sbin",
        "/sys",
        "/usr",
        "/var/lib",
      ];
  }
}

export function normalizeProtectionPath(
  input: string,
  platform: ProtectionPlatform = runtimePlatform(),
): string {
  const family = platformFamily(platform);
  let value = input.trim();
  if (!value) return "";

  if (family === "win32") {
    value = value.replace(/\//g, "\\");
    if (/^[A-Za-z]:\\?$/.test(value)) {
      return value.slice(0, 2).toLowerCase();
    }
    value = value.replace(/[\\]+$/, "");
    return value.toLowerCase();
  }

  if (value === "/") return "/";
  return value.replace(/\/+$/, "");
}

export function normalizeExcludedFolderPaths(
  paths: readonly string[] | null | undefined,
  platform: ProtectionPlatform = runtimePlatform(),
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of paths ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeProtectionPath(trimmed, platform);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed.replace(/[\\/]+$/, (suffix) => {
      if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) return suffix;
      return "";
    }));
  }

  return result;
}

export function isPathInsideFolder(
  candidatePath: string,
  folderPath: string,
  platform: ProtectionPlatform = runtimePlatform(),
): boolean {
  const family = platformFamily(platform);
  const candidate = normalizeProtectionPath(candidatePath, platform);
  const folder = normalizeProtectionPath(folderPath, platform);
  if (!candidate || !folder) return false;
  if (candidate === folder) return true;
  if (folder === "/") return candidate.startsWith("/");
  const sep = family === "win32" ? "\\" : "/";
  return candidate.startsWith(folder + sep);
}

export function findExcludedFolderForPath(
  candidatePath: string,
  excludedFolderPaths: readonly string[] | null | undefined,
  platform: ProtectionPlatform = runtimePlatform(),
): string | null {
  let best: string | null = null;
  let bestLength = -1;

  for (const folder of excludedFolderPaths ?? []) {
    if (typeof folder !== "string") continue;
    if (!isPathInsideFolder(candidatePath, folder, platform)) continue;
    const normalizedLength = normalizeProtectionPath(folder, platform).length;
    if (normalizedLength > bestLength) {
      best = folder;
      bestLength = normalizedLength;
    }
  }

  return best;
}

export function findNestedExcludedFolderForPath(
  candidatePath: string,
  excludedFolderPaths: readonly string[] | null | undefined,
  platform: ProtectionPlatform = runtimePlatform(),
): string | null {
  const candidate = normalizeProtectionPath(candidatePath, platform);
  if (!candidate) return null;

  let best: string | null = null;
  let bestLength = Number.POSITIVE_INFINITY;

  for (const folder of excludedFolderPaths ?? []) {
    if (typeof folder !== "string") continue;
    const normalizedFolder = normalizeProtectionPath(folder, platform);
    if (!normalizedFolder || normalizedFolder === candidate) continue;
    if (!isPathInsideFolder(folder, candidatePath, platform)) continue;
    if (normalizedFolder.length < bestLength) {
      best = folder;
      bestLength = normalizedFolder.length;
    }
  }

  return best;
}

export function isRecycleBinRootPath(
  candidatePath: string,
  platform: ProtectionPlatform = runtimePlatform(),
): boolean {
  if (platformFamily(platform) !== "win32") return false;
  const candidate = normalizeProtectionPath(candidatePath, platform);
  return candidate === "$recycle.bin" || candidate.endsWith("\\$recycle.bin");
}

export function isRecycleBinPath(
  candidatePath: string,
  platform: ProtectionPlatform = runtimePlatform(),
): boolean {
  if (platformFamily(platform) !== "win32") return false;
  const candidate = normalizeProtectionPath(candidatePath, platform);
  return isRecycleBinRootPath(candidatePath, platform) || candidate.includes("\\$recycle.bin\\");
}

export function isVisibleProtectedFolderByDefault(
  folderPath: string,
  platform: ProtectionPlatform = runtimePlatform(),
): boolean {
  const family = platformFamily(platform);
  if (isRecycleBinPath(folderPath, platform)) return true;
  if (family !== "win32") return false;
  return basenameForPath(folderPath).toLowerCase() === "programdata";
}

export function isPathExcluded(
  candidatePath: string,
  excludedFolderPaths: readonly string[] | null | undefined,
  platform: ProtectionPlatform = runtimePlatform(),
): boolean {
  const matchedFolder = findExcludedFolderForPath(candidatePath, excludedFolderPaths, platform);
  return Boolean(matchedFolder && !isVisibleProtectedFolderByDefault(matchedFolder, platform));
}

export function protectedFolderDisplayName(
  folderPath: string,
  platform: ProtectionPlatform = runtimePlatform(),
): string | null {
  if (isRecycleBinRootPath(folderPath, platform)) return "Recycle Bin";
  return null;
}

export function findExcludedFolderActionBlocker(
  candidatePath: string,
  excludedFolderPaths: readonly string[] | null | undefined,
  platform: ProtectionPlatform = runtimePlatform(),
): ExcludedFolderActionBlocker | null {
  const containingFolder = findExcludedFolderForPath(candidatePath, excludedFolderPaths, platform);
  if (containingFolder) return { folder: containingFolder, reason: "inside" };
  const nestedFolder = findNestedExcludedFolderForPath(candidatePath, excludedFolderPaths, platform);
  if (nestedFolder) return { folder: nestedFolder, reason: "contains" };
  return null;
}

export function parentFolderOfPath(path: string): string | null {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === "/") return null;
  if (/^[A-Za-z]:$/.test(trimmed)) return null;

  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  if (idx === 0) return "/";

  const parent = trimmed.slice(0, idx);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  return parent;
}

export function basenameForPath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed || trimmed === "/") return trimmed || path;
  return trimmed.split(/[\\/]/).pop() ?? trimmed;
}
