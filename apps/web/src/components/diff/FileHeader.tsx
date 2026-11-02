import type { FileView } from "@emend/contract";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import { Fragment } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import type { DiffCounts } from "./presentation.ts";
import { ThreadCount } from "./ThreadCount.tsx";

const statuses = {
  added: { letter: "A", color: "text-success-fg" },
  modified: { letter: "M", color: "text-warning-fg" },
  deleted: { letter: "D", color: "text-danger-fg" },
  renamed: { letter: "R", color: "text-info-fg" },
  "mode-changed": { letter: "T", color: "text-fg-3" },
};

function Path({ path }: { path: string }) {
  const segments = path.split("/");
  return (
    <bdi>
      {segments.map((segment, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static path segments may repeat names.
        <Fragment key={index}>
          <span className={index === segments.length - 1 ? "font-medium text-fg-1" : "text-fg-3"}>
            {segment}
            {index < segments.length - 1 ? "/" : ""}
          </span>
          {index < segments.length - 1 && <wbr />}
        </Fragment>
      ))}
    </bdi>
  );
}

export function FileHeader({
  file,
  collapsed,
  counts,
  threads,
  onToggle,
  onComment,
}: {
  file: FileView;
  collapsed: boolean;
  counts?: DiffCounts;
  threads: number;
  onToggle: () => void;
  onComment: () => void;
}) {
  const status = file.status && statuses[file.status];
  const statusName = file.status?.replaceAll("-", " ");
  return (
    <header id={`diff-file-${file.id}`} data-file-header className="em-file" data-collapsed={collapsed || undefined}>
      <IconButton
        size="sm"
        label={collapsed ? "Expand file" : "Collapse file"}
        icon={collapsed ? ChevronRight : ChevronDown}
        aria-expanded={!collapsed}
        onClick={onToggle}
      />
      {status && (
        <span
          title={statusName}
          className={`shrink-0 font-mono text-11 font-semibold font-stretch-mono ${status.color}`}
        >
          <span aria-hidden="true">{status.letter}</span>
          <span className="sr-only">{statusName}</span>
        </span>
      )}
      <div className="min-w-0 flex-1 font-stretch-mono [font:var(--type-path)]">
        <h4 className="em-file-path" title={file.path} aria-label={file.path}>
          <Path path={file.path} />
        </h4>
        {file.oldPath && (
          <p className="em-file-path text-fg-3" title={`Renamed from ${file.oldPath}`}>
            Renamed from <Path path={file.oldPath} />
          </p>
        )}
      </div>
      {counts && !file.flag && (
        <span className="flex shrink-0 gap-1.5 font-mono text-11 font-stretch-mono tabular-nums">
          <span className="text-diff-add-fg">+{counts.additions}</span>
          <span className="text-diff-del-fg">−{counts.deletions}</span>
        </span>
      )}
      <ThreadCount count={threads} />
      <IconButton label="Comment on file" icon={MessageSquarePlus} size="sm" onClick={onComment} />
    </header>
  );
}
