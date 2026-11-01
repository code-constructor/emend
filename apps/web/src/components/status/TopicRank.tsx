export function TopicRank({ rank }: { rank: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid h-5 min-w-[22px] shrink-0 place-items-center rounded-sm bg-topic-bg px-1 font-mono text-11 font-semibold leading-none font-stretch-mono text-topic-fg tabular-nums"
    >
      {String(rank).padStart(2, "0")}
    </span>
  );
}
