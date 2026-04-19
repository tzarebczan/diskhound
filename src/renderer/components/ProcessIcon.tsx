import { useEffect, useState } from "preact/hooks";

import { nativeApi } from "../nativeApi";

/**
 * Per-path icon resolver for executables. Unlike the general-purpose
 * FileIcon which caches by extension (fine for `.png` files — they all
 * look alike — but wrong for `.exe` where every executable has its own
 * icon), this component caches by full path.
 *
 * Falls back to a monochrome "gear" glyph while the icon is being
 * fetched, and when the process has no path (e.g. system processes we
 * couldn't get a path for) it renders the fallback.
 */

type IconSize = "small" | "normal" | "large";

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

function cacheKey(path: string, size: IconSize): string {
  return `${path}::${size}`;
}

async function resolve(path: string, size: IconSize): Promise<string | null> {
  const key = cacheKey(path, size);
  if (cache.has(key)) return cache.get(key) ?? null;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = nativeApi
      .getExecutableIcon(path, size)
      .then((url) => {
        cache.set(key, url ?? null);
        inFlight.delete(key);
        return url ?? null;
      })
      .catch(() => {
        cache.set(key, null);
        inFlight.delete(key);
        return null;
      });
    inFlight.set(key, pending);
  }
  return pending;
}

interface Props {
  /** Full path to the executable. Pass null or empty string to show the fallback immediately. */
  exePath?: string | null;
  size?: IconSize;
  className?: string;
}

const FALLBACK_SVG = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    opacity="0.55"
  >
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M9 7h6M9 11h6M9 15h4" />
  </svg>
);

export function ProcessIcon({ exePath, size = "small", className }: Props) {
  const [url, setUrl] = useState<string | null>(() => {
    if (!exePath) return null;
    return cache.get(cacheKey(exePath, size)) ?? null;
  });

  useEffect(() => {
    if (!exePath) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void resolve(exePath, size).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => { cancelled = true; };
  }, [exePath, size]);

  if (!url) {
    return <span className={className}>{FALLBACK_SVG}</span>;
  }
  return <img className={className} src={url} alt="" draggable={false} />;
}
