import { useEffect, useRef, useState } from "react";

/** The longest delay setTimeout takes; a later wake time is reached in several steps. */
const MAX_DELAY_MS = 2 ** 31 - 1;
/** Past the wake time, so a server that compares with its own clock no longer lists the review as snoozed. */
const SLACK_MS = 500;

/**
 * Calls `onWake` with the wake times that have passed, once the earliest future one arrives. The
 * server ends a timed snooze on read and sends no event, so a page left open must ask again itself.
 * Times that are null or already past schedule nothing.
 */
export function useWakeTimer(times: readonly (string | null | undefined)[], onWake: (passed: string[]) => void) {
  const latest = useRef(onWake);
  latest.current = onWake;
  const [round, setRound] = useState(0);
  const key = times.join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `times`, `round` re-arms after a step.
  useEffect(() => {
    const now = Date.now();
    const future = times
      .map((time) => (time ? new Date(time).getTime() : Number.NaN))
      .filter((time) => time > now - SLACK_MS);
    if (future.length === 0) return;
    const next = Math.min(...future);
    const timer = setTimeout(
      () => {
        const arrived = Date.now();
        const passed = times.filter((time): time is string => !!time && new Date(time).getTime() <= arrived);
        if (passed.length > 0) latest.current(passed);
        setRound((value) => value + 1);
      },
      Math.min(Math.max(next - now, 0) + SLACK_MS, MAX_DELAY_MS),
    );
    return () => clearTimeout(timer);
  }, [key, round]);
}
