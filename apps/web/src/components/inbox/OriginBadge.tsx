import type { InboxItem } from "@emend/contract";

const colors = [
  "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
  "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200",
] as const;
export function OriginBadge({ origin }: { origin: InboxItem["origin"] }) {
  let hash = 0;
  for (const char of origin.id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return (
    <span className={`inline-flex max-w-full rounded px-2 py-0.5 text-xs font-medium ${colors[hash % colors.length]}`}>
      {origin.name}
    </span>
  );
}
