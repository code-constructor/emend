import type { RevisionView } from "@emend/contract";
import { useState } from "react";
import type { DocNavigation } from "../../lib/frame-messages.ts";
import { BlockReader, type ReaderProps } from "./BlockReader.tsx";
import { HtmlDocFrame, type HtmlNavigation } from "./HtmlDocFrame.tsx";

export function DocView({
  docs,
  navigation,
  composingPath,
  ...props
}: ReaderProps & { docs: RevisionView["docs"]; navigation?: HtmlNavigation; composingPath?: string }) {
  const [destination, setDestination] = useState<DocNavigation>();
  const follow = (from: string, next: DocNavigation) => {
    const doc = docs.find((doc) => doc.path === next.path);
    if (!doc || doc.path === from) return;
    if (doc.kind === "html" && next.fragment) setDestination(next);
    document.getElementById(`doc-${doc.path}`)?.scrollIntoView?.({ block: "start" });
  };
  return (
    <BlockReader
      {...props}
      groups={docs.map((doc) => ({
        key: doc.path,
        id: `doc-${doc.path}`,
        heading: doc.path,
        path: doc.path,
        blocks: doc.kind === "markdown" ? doc.blocks : [],
        content:
          doc.kind === "html" ? (
            <HtmlDocFrame
              key={doc.contentUrl}
              {...props}
              path={doc.path}
              contentUrl={doc.contentUrl}
              navigation={navigation}
              docNavigation={destination?.path === doc.path ? destination : undefined}
              onNavigate={(next) => follow(doc.path, next)}
              composerOpen={composingPath === doc.path}
            />
          ) : undefined,
      }))}
    />
  );
}
