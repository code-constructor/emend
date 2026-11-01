import { History } from "lucide-react";
import { Icon } from "../ui/Icon.tsx";

export function ChangedMarker({ revision }: { revision: number }) {
  return (
    <span className="inline-flex h-5 items-center gap-[5px] whitespace-nowrap rounded-sm bg-changed-bg pr-[7px] pl-1.5 font-mono text-[10.5px] font-medium leading-none font-stretch-mono text-changed-fg">
      <Icon icon={History} size={11} />
      Changed in revision {revision}
    </span>
  );
}
