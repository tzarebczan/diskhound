/** Normalize a path for case-insensitive comparison: lowercase, strip trailing separators. */
export function normPath(p: string): string {
  return p.replace(/[\\/]+$/, "").toLowerCase();
}
