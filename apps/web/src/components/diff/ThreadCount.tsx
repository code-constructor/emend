import { MessageSquare } from "lucide-react";
import { plural } from "../../lib/count.ts";
import { Icon } from "../ui/Icon.tsx";

export function ThreadCount({ count }: { count: number }) {
  return count > 0 ? (
    <span className="inline-flex shrink-0 items-center gap-1" title={`${count} ${plural(count, "thread")}`}>
      <Icon icon={MessageSquare} size={12} />
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">
        {count} {plural(count, "thread")}
      </span>
    </span>
  ) : null;
}
