import { parseDiffFromFile } from "@pierre/diffs";
import type { ParsePair } from "./parse-client.ts";

export function parsePair(pair: ParsePair) {
  return parseDiffFromFile(pair.oldFile, pair.newFile);
}
// The exported pure entry point lets tests inject synchronous parsing.
if (typeof document === "undefined") {
  self.onmessage = ({ data }: MessageEvent<ParsePair>) => {
    try {
      self.postMessage({ fileDiff: parsePair(data) });
    } catch {
      self.postMessage({ error: true });
    }
  };
}
