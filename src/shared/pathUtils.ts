/** Normalize a path for comparison: strip trailing separators and only case-fold on Windows. */
export function normPath(p: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}
