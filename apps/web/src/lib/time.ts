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
