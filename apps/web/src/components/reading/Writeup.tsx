import type { RenderedWriteup } from "@emend/contract";
import { BlockReader, type ReaderProps } from "./BlockReader.tsx";

export function Writeup({ writeup, ...props }: ReaderProps & { writeup: RenderedWriteup }) {
  return (
    <BlockReader
      {...props}
      groups={writeup.sections.map((section) => ({ key: section.key, heading: section.label, blocks: section.blocks }))}
    />
  );
}
