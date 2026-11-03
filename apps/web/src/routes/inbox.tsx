import { useQuery } from "@tanstack/react-query";
import { PanelLeftClose, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { inboxQuery } from "../api/queries.ts";
import { needsAttention, ReviewRow } from "../components/inbox/ReviewRow.tsx";
import { AppFrame } from "../components/layout/AppFrame.tsx";
import { Button } from "../components/ui/Button.tsx";
import { IconButton } from "../components/ui/IconButton.tsx";
import { Select } from "../components/ui/Select.tsx";
import { TextField } from "../components/ui/TextField.tsx";
import { plural } from "../lib/count.ts";

export function Inbox({
  compact = false,
  hideHead = false,
  onCollapse,
  onOpen,
}: {
  compact?: boolean;
  hideHead?: boolean;
  onCollapse?: () => void;
  onOpen?: () => void;
}) {
  const query = useQuery(inboxQuery());
  const [filter, setFilter] = useState("");
  const [machine, setMachine] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const items = query.data?.items ?? [];
  const origins = [...new Map(items.map(({ origin }) => [origin.id, origin])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const machineFilter =
    !compact && origins.length > 1 && origins.some((origin) => origin.id === machine) ? machine : "";
  const needle = filter.toLocaleLowerCase();
  const filtered = items.filter(
    (review) =>
      (!machineFilter || review.origin.id === machineFilter) &&
      [review.title, review.branch, review.origin.name].some((value) => value?.toLocaleLowerCase().includes(needle)),
  );
  const attention = items.filter(needsAttention).length;
  return (
    <div className={compact ? "flex min-h-0 flex-1 flex-col" : "mx-auto w-full max-w-[760px] px-5 pt-8 pb-20"}>
      {!hideHead &&
        (compact ? (
          <div className="flex items-center justify-between pt-2.5 pr-2 pb-1.5 pl-4">
            <h2 className="text-13 font-medium leading-[1.2] text-fg-2">Inbox</h2>
            <IconButton label="Collapse inbox" icon={PanelLeftClose} size="sm" onClick={onCollapse} />
          </div>
        ) : (
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3">
            <h1 className="text-24 font-semibold leading-(--lh-tight) tracking-(--tracking-tight)">Inbox</h1>
            {query.data && (
              <p className="mt-1 text-14 text-fg-3">
                {attention ? `${attention} ${plural(attention, "needs", "need")} you` : "Nothing needs you"} ·{" "}
                {origins.length} {plural(origins.length, "machine")}
              </p>
            )}
          </div>
        ))}
      <div className={compact ? "px-2.5 pb-2" : "mb-3 flex flex-wrap items-center gap-2.5"}>
        <TextField
          aria-label="Filter reviews"
          placeholder="Filter by title, branch, machine"
          icon={Search}
          size="sm"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="min-w-0 flex-1"
        />
        {!compact && origins.length > 1 && (
          <Select
            aria-label="Machine"
            size="sm"
            className="min-w-0 max-w-full"
            value={machineFilter}
            onChange={(event) => setMachine(event.target.value)}
            options={[
              { value: "", label: "All machines" },
              ...origins.map((origin) => ({ value: origin.id, label: origin.name })),
            ]}
          />
        )}
      </div>
      <div className={compact ? "relative min-h-0 flex-1 overflow-y-auto px-1.5 pt-1 pb-3" : "py-1"}>
        {query.isPending && (
          <p role="status" className="p-4">
            Loading reviews…
          </p>
        )}
        {query.isError && (
          <div className="p-4">
            <p role="alert">Could not load reviews.</p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        )}
        {query.data && items.length === 0 && <p className="p-4 text-fg-3">No reviews yet.</p>}
        {items.length > 0 && filtered.length === 0 && (
          <div className="p-4">
            <p className="text-fg-3">No reviews match this filter.</p>
            <Button
              variant="ghost"
              onClick={() => {
                setFilter("");
                setMachine("");
              }}
            >
              Clear filter
            </Button>
          </div>
        )}
        {query.data && (
          <ul>
            {filtered.map((review) => (
              <ReviewRow key={review.id} review={review} now={now} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
export function InboxPage() {
  return (
    <AppFrame>
      <main className="relative min-h-0 flex-1 overflow-y-auto">
        <Inbox />
      </main>
    </AppFrame>
  );
}
