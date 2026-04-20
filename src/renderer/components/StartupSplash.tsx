import { useEffect, useState } from "preact/hooks";

/**
 * Boot-time splash that covers the Overview's brief "no snapshot yet"
 * gap with something on-brand instead of a blank rectangle.
 *
 * Timing rules:
 * - Don't render anything at all until `delayMs` has elapsed, so a fast
 *   boot (snapshot already in memory, nav click from another tab) stays
 *   flicker-free.
 * - Once visible, render until the parent unmounts us.
 *
 * Visuals:
 * - A radar-style scanning disc — circular amber sweep rotating around
 *   a dim disk backdrop. Matches the "disk analyzer" metaphor and reuses
 *   the app's amber accent.
 * - Wordmark + a cycling micro-tagline that rotates every ~1.4s. The
 *   phrases read like the hound is thinking aloud — "sniffing around",
 *   "checking the cache" — so the wait feels animated, not stuck.
 * - Thin indeterminate progress bar along the bottom edge; gives a
 *   second motion cue in case the radar is subtle on the user's display.
 */

interface Props {
  delayMs?: number;
}

const MESSAGES = [
  "Sniffing around",
  "Catching the scent",
  "Checking the cache",
  "Warming up the snout",
  "Tracking down the bytes",
];

export function StartupSplash({ delayMs = 500 }: Props) {
  const [visible, setVisible] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);

  // Delayed-visibility timer
  useEffect(() => {
    const id = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);

  // Cycle through messages while visible — restart the index so the
  // first message shown is always #0, giving the user a stable opening
  // beat rather than whatever random one we'd land on.
  useEffect(() => {
    if (!visible) return;
    setMessageIndex(0);
    const id = window.setInterval(() => {
      setMessageIndex((i) => (i + 1) % MESSAGES.length);
    }, 1400);
    return () => window.clearInterval(id);
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="startup-splash" role="status" aria-live="polite">
      <div className="startup-splash-center">
        <div className="startup-splash-radar">
          {/* Dimmed disk backdrop — concentric circles for a subtle
              "we're looking at a disk platter" vibe. */}
          <svg
            className="startup-splash-disc"
            width="72"
            height="72"
            viewBox="0 0 72 72"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="36" cy="36" r="34" stroke="currentColor" strokeWidth="1" opacity="0.18" />
            <circle cx="36" cy="36" r="24" stroke="currentColor" strokeWidth="1" opacity="0.12" />
            <circle cx="36" cy="36" r="14" stroke="currentColor" strokeWidth="1" opacity="0.10" />
            <circle cx="36" cy="36" r="3" fill="currentColor" opacity="0.45" />
          </svg>
          {/* Rotating amber sweep — conic gradient masked to a ring so
              it reads as "scanning beam" rather than a solid wedge. */}
          <div className="startup-splash-sweep" aria-hidden="true" />
          {/* Tiny pulse "sample points" scattered around the disc —
              adds life without looking like loading dots. */}
          <div className="startup-splash-pulses" aria-hidden="true">
            <span style={{ top: "14%", left: "22%" }} />
            <span style={{ top: "30%", right: "14%" }} />
            <span style={{ bottom: "22%", left: "18%" }} />
            <span style={{ bottom: "14%", right: "26%" }} />
          </div>
        </div>
        <div className="startup-splash-wordmark">DiskHound</div>
        <div className="startup-splash-message-slot">
          <span key={messageIndex} className="startup-splash-message">
            {MESSAGES[messageIndex]}
            <span className="startup-splash-dots">
              <span /><span /><span />
            </span>
          </span>
        </div>
      </div>
      <div className="startup-splash-progress" aria-hidden="true">
        <div className="startup-splash-progress-fill" />
      </div>
    </div>
  );
}
