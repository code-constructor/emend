import { expect, test } from "vitest";
import { docLinkCases } from "./links.cases.ts";
import { resolveDocLink } from "./links.ts";

for (const entry of docLinkCases)
  test(entry.name, () => {
    expect(resolveDocLink(entry.base, entry.href, new Set(entry.docs))).toEqual(entry.expected);
  });
