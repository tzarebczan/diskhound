import { useEffect, useState } from "preact/hooks";

import { nativeApi } from "../nativeApi";

// Extension-level cache — shared across component instances.
// Key: "<ext>:<size>", value: data URL or null (negative cache).
const iconCache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

function extKey(path: string, size: "small" | "normal" | "large"): string {
  const idx = path.lastIndexOf(".");
  const ext = idx >= 0 ? path.slice(idx).toLowerCase() : "";
  return `${ext}:${size}`;
}

async function resolveIcon(path: string, size: "small" | "normal" | "large"): Promise<string | null> {
  const key = extKey(path, size);
  if (iconCache.has(key)) return iconCache.get(key) ?? null;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = nativeApi.getFileIcon(path, size).then((url) => {
      iconCache.set(key, url ?? null);
      inFlight.delete(key);
      return url ?? null;
    }).catch(() => {
      iconCache.set(key, null);
      inFlight.delete(key);
      return null;
    });
    inFlight.set(key, pending);
  }
  return pending;
}

interface Props {
  path: string;
  size?: "small" | "normal" | "large";
  fallback?: preact.ComponentChildren;
  className?: string;
}

export function FileIcon({ path, size = "small", fallback, className }: Props) {
  const [url, setUrl] = useState<string | null>(() => {
    const key = extKey(path, size);
    return iconCache.get(key) ?? null;
  });

  useEffect(() => {
    let cancelled = false;
    void resolveIcon(path, size).then((resolved) => {
      if (!cancelled) setUrl(resolved);
    });
    return () => { cancelled = true; };
  }, [path, size]);

  if (!url) {
    return <span className={className}>{fallback ?? null}</span>;
  }
  return <img className={className} src={url} alt="" draggable={false} />;
}
