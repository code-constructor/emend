import { type FileView, OTHER_TOPIC, type TopicMeta } from "@emend/contract";
import { ChevronDown, Columns2, FileCode, List } from "lucide-react";
import { plural } from "../../lib/count.ts";
import { Button } from "../ui/Button.tsx";
import { Menu, type MenuItem } from "../ui/Menu.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import type { DiffCounts, DiffStyle } from "./presentation.ts";

export function DiffToolbar({
  groups,
  ranks,
  counts,
  style,
  splitDisabled,
  onStyle,
  wrap,
  onWrap,
  notes,
  onNotes,
  onJump,
}: {
  groups: { topic: TopicMeta; files: FileView[] }[];
  ranks: Map<string, number>;
  counts: Map<string, DiffCounts>;
  style: DiffStyle;
  splitDisabled: boolean;
  onStyle: (style: DiffStyle) => void;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
  notes: boolean;
  onNotes: (notes: boolean) => void;
  onJump: (file: FileView) => void;
}) {
  const topics = groups.filter(({ topic }) => topic.slug !== OTHER_TOPIC.slug).length;
  const files = groups.reduce((count, group) => count + group.files.length, 0);
  const label = `${topics} ${plural(topics, "topic")} · ${files} ${plural(files, "file")}`;
  const items: MenuItem[] = groups.flatMap(({ topic, files }) => [
    {
      heading:
        topic.slug === OTHER_TOPIC.slug
          ? OTHER_TOPIC.title
          : `${String(ranks.get(topic.slug)).padStart(2, "0")} ${topic.title}`,
    },
    ...files.map((file) => ({
      label: file.path.split("/").at(-1) ?? file.path,
      title: file.path,
      icon: FileCode,
      hint: !file.flag && counts.has(file.id) ? `+${counts.get(file.id)?.additions}` : undefined,
      onSelect: () => onJump(file),
    })),
  ]);
  return (
    <div data-diff-toolbar className="em-diff-toolbar">
      <Menu
        label={label}
        align="left"
        trigger={
          <Button variant="ghost" size="sm" iconRight={ChevronDown}>
            {label}
          </Button>
        }
        items={items}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" aria-pressed={notes} onClick={() => onNotes(!notes)}>
          Agent notes
        </Button>
        <SegmentedControl
          label="Diff layout"
          size="sm"
          value={style}
          onChange={(value) => {
            // A no-op key on forced Unified must not overwrite the saved Split choice.
            if (value !== style) onStyle(value === "unified" ? "unified" : "split");
          }}
          options={[
            {
              value: "split",
              label: "Split",
              icon: Columns2,
              disabled: splitDisabled,
              title: splitDisabled ? "Widen the diff pane for Split" : undefined,
            },
            { value: "unified", label: "Unified", icon: List },
          ]}
        />
        <Button
          size="sm"
          variant="ghost"
          className={wrap ? "bg-raised text-fg-1" : undefined}
          aria-pressed={wrap}
          onClick={() => onWrap(!wrap)}
        >
          Wrap
        </Button>
      </div>
    </div>
  );
}
