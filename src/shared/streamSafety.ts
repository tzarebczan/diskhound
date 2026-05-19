/**
 * Stream-safety helpers.
 *
 * Why this module exists: Node's `Readable#pipe()` doesn't propagate
 * errors. If you do `source.pipe(transform).pipe(destination)` and
 * `source` errors with no listener attached to source itself, Node
 * throws an uncaught exception — surfaced in our app as the
 * "DiskHound — Unexpected error" dialog with messages like
 *
 *     EPERM: operation not permitted, open '...'
 *     ENOENT: no such file or directory, open '...'
 *
 * Three users have hit variants of this (v0.5.18, v0.5.19, v0.5.20)
 * because the codebase has ~15 places that pipe gzip streams from
 * filesystem reads. Each one needs its own error listeners and they
 * kept getting missed.
 *
 * This module gives us one pattern: `attachPipeErrorHandlers(streams)`.
 * Attach BEFORE you pipe(); the helper swallows errors so the caller's
 * outer try/catch (around the for-await loop) is the single place
 * that surfaces them. If the caller wants to know about the error,
 * wrap the consumer in try/catch — the error will hit the rejection
 * path of the async iterator.
 */

import type { Readable, Writable } from "node:stream";

type Streamish = Readable | Writable;

/**
 * Attach a noop "error" listener to every stream in the array. Call
 * this immediately after constructing the streams and BEFORE any
 * `pipe()` call. Subsequent error events become observed (no crash),
 * and propagate through the consumer's for-await loop as a normal
 * iterator rejection that the caller's try/catch handles.
 *
 * Idiom:
 *
 *   const src = createReadStream(p);
 *   const gunzip = createGunzip();
 *   attachPipeErrorHandlers([src, gunzip]);  // <-- before pipe
 *   src.pipe(gunzip);
 *   const rl = createInterface({ input: gunzip, crlfDelay: Infinity });
 *   try {
 *     for await (const line of rl) { ... }
 *   } catch { ... }
 *   finally {
 *     try { gunzip.destroy(); } catch {}
 *     try { src.destroy(); } catch {}
 *   }
 *
 * If you need to capture errors (e.g. log them), pass an `onError`
 * callback. We still swallow inside the listener so the process
 * doesn't crash; the callback just gets a heads-up.
 */
export function attachPipeErrorHandlers(
  streams: Streamish[],
  onError?: (err: Error) => void,
): void {
  for (const s of streams) {
    s.on("error", (err: Error) => {
      try { onError?.(err); } catch { /* never let an error handler throw */ }
    });
  }
}
