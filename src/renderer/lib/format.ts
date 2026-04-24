export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / 1024 ** exp;
  return `${val.toFixed(val >= 100 || exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function formatCount(count: number): string {
  return new Intl.NumberFormat().format(count);
}

export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSeconds = ms / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds - mins * 60);
  // Handle seconds rounding up to 60.
  if (secs === 60) return `${mins + 1}m 0s`;
  return `${mins}m ${secs}s`;
}

export function relativePath(path: string, rootPath: string | null): string {
  if (!rootPath || !path.startsWith(rootPath)) return path;
  return path.slice(rootPath.length).replace(/^[/\\]+/, "") || ".";
}

/** Short relative age: "today", "5d", "2mo", "1y" */
export function humanAge(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  const day = 86_400_000;
  if (elapsed < day) return "today";
  if (elapsed < day * 30) return `${Math.floor(elapsed / day)}d`;
  if (elapsed < day * 365) return `${Math.floor(elapsed / (day * 30))}mo`;
  return `${Math.floor(elapsed / (day * 365))}y`;
}

/** Verbose relative time: "just now", "5m ago", "2h ago", "yesterday", "3d ago", "2w ago", "Apr 1" */
export function relativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "just now";
  const mins = Math.floor(elapsed / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 2) return "1h ago";
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  const d = new Date(timestamp);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/** Extract the last path segment (basename). */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
