import type { AffinityRule, ProcessInfo } from "../../shared/contracts";

/**
 * Find the first enabled affinity rule that matches a given process.
 * Single source of truth for the UI's "is this process pinned?" check —
 * MemoryView (list + treemap tile marker + context menu) and
 * ProcessHeatmap (row label badge) both use this so a rule's existence
 * is reported consistently everywhere. The main-process rule engine
 * (`affinityRuleEngine.ts`) does the same check on its side.
 *
 * - `exe_name` rules match on the lowercased basename of `exePath`
 *   (falling back to `proc.name` when exePath is unknown).
 * - `exe_path` rules match as a lowercased substring of the full exePath.
 *
 * Disabled rules are skipped so a paused rule doesn't badge rows — the
 * rule still appears in the Rules tab so it can be re-enabled. Returns
 * null when nothing matches; callers just skip rendering the badge.
 */
export function findMatchingRule(
  rules: AffinityRule[],
  proc: Pick<ProcessInfo, "name" | "exePath">,
): AffinityRule | null {
  if (!rules.length) return null;
  const basename = proc.exePath
    ? (proc.exePath.split(/[\\/]/).pop() || "").toLowerCase()
    : proc.name.toLowerCase();
  const pathLower = proc.exePath ? proc.exePath.toLowerCase() : "";
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.matchType === "exe_name") {
      if (basename === rule.matchPattern) return rule;
    } else if (rule.matchType === "exe_path") {
      if (pathLower && pathLower.includes(rule.matchPattern)) return rule;
    }
  }
  return null;
}
