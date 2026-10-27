import type { RevisionView } from "@emend/contract";
import { BlockReader, type ReaderProps } from "./BlockReader.tsx";

export function DocView({ docs, ...props }: ReaderProps & { docs: RevisionView["docs"] }) {
  return (
    <BlockReader
      {...props}
      groups={docs.map((doc) => ({
        key: doc.path,
        heading: doc.path,
        path: doc.path,
        blocks: doc.kind === "markdown" ? doc.blocks : [],
      }))}
    />
  );
}
