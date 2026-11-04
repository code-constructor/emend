export function relativeTime(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = (now - date.getTime()) / 1000;
  if (seconds < 60) return "now";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 24 * 60 * 60) return `${Math.floor(seconds / (60 * 60))}h`;
  if (seconds < 7 * 24 * 60 * 60) return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

/** A calendar date as the reader's clock shows it ("Nov 4"), or "" for a bad date. */
export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a wake time has passed: the server still lists the review as snoozed until the next refetch. */
export function wakeHasPassed(iso: string, now: number): boolean {
  const time = new Date(iso).getTime();
  return !Number.isNaN(time) && time <= now;
}

/**
 * A wake time as the reader's clock shows it: "Thu 09:00" while the weekday alone is unambiguous,
 * "Nov 12, 09:00" from six days out or on today's weekday of another day.
 */
export function wakeTime(when: Date | string, now: number): string {
  const date = typeof when === "string" ? new Date(when) : when;
  if (Number.isNaN(date.getTime())) return "";
  const time = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const today = new Date(now);
  // A bare weekday names the wake time only when it cannot also mean today's weekday or next week's.
  const ambiguous =
    date.getTime() - now >= 6 * DAY_MS ||
    (date.toDateString() !== today.toDateString() && date.getDay() === today.getDay());
  return ambiguous
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...time }).format(date)
    : new Intl.DateTimeFormat(undefined, { weekday: "short", ...time }).format(date);
}

export type SnoozeChoice =
  | { id: "revision"; label: "Until it changes" }
  | { id: "later" | "tomorrow" | "week"; label: string; until: Date };

/**
 * The snooze choices at `now`, in the reader's time zone: three hours on, tomorrow at 09:00, and the
 * next Monday at 09:00 (strictly after today, so a Monday gives the Monday a week out). Between
 * 00:00 and 05:00 the reader is still up late, so "tomorrow morning" is 09:00 on the same calendar day.
 */
export function snoozeChoices(now: Date): SnoozeChoice[] {
  const at = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0, 0, 0);
  return [
    { id: "revision", label: "Until it changes" },
    { id: "later", label: "Later today", until: new Date(now.getTime() + 3 * 60 * 60 * 1000) },
    { id: "tomorrow", label: "Tomorrow morning", until: at(now.getHours() < 5 ? 0 : 1) },
    { id: "week", label: "Next week", until: at((8 - now.getDay()) % 7 || 7) },
  ];
}

/** "Checked just now.", "Checked 5m ago.", "Checked 3h ago." or "Checked on Mon.", or "" for a bad date. */
export function checkedText(iso: string, now: number): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = (now - time) / 1000;
  if (seconds < 60) return "Checked just now.";
  if (seconds < 60 * 60) return `Checked ${Math.floor(seconds / 60)}m ago.`;
  if (seconds < 24 * 60 * 60) return `Checked ${Math.floor(seconds / (60 * 60))}h ago.`;
  return `Checked on ${relativeTime(iso, now)}.`;
}
