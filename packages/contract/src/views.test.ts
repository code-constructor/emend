import { expect, test } from "vitest";
import * as contract from "./index.ts";

test("review views validate their states, limits, rendered blocks and doc variants", () => {
  expect(contract.ReviewState.options).toEqual(["open", "approved", "settled"]);
  expect(contract.LIMITS.inboxItems).toBe(200);
  const id = "11111111-1111-4111-8111-111111111111";
  const item = {
    id,
    title: "Synthetic",
    origin: { id, name: "Workshop" },
    repo: null,
    branch: null,
    state: "open",
    newestRevision: 1,
    unsentCount: 0,
    openThreads: 0,
    agentWaiting: false,
    pendingSend: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    movedTo: null,
  };
  expect(contract.InboxList.safeParse({ items: Array.from({ length: 200 }, () => item) }).success).toBe(true);
  expect(contract.InboxList.safeParse({ items: Array.from({ length: 201 }, () => item) }).success).toBe(false);
  expect(
    contract.RenderedBlock.safeParse({
      id: "overview-12345678",
      section: "overview",
      kind: "paragraph",
      html: "<p>Hi</p>",
      text: "Hi",
    }).success,
  ).toBe(true);
  expect(
    contract.RenderedBlock.safeParse({ id: "bad", section: "overview", kind: "script", html: "", text: "" }).success,
  ).toBe(false);
  const revision = {
    seq: 1,
    base: null,
    head: null,
    topics: [],
    files: [],
    writeup: { sections: [] },
    docs: [],
    threads: [],
    changedBlocks: [],
  };
  expect(contract.RevisionView.safeParse(revision).success).toBe(true);
  expect(
    contract.RevisionView.safeParse({
      ...revision,
      docs: [{ path: "a.html", kind: "html", contentUrl: "https://evil.example/a" }],
    }).success,
  ).toBe(false);
});

test("changed blocks retain validated IDs and positive revision sequences", () => {
  const schema = contract.RevisionView.shape.changedBlocks;
  const change = { blockId: "overview-12345678", revision: 3 };
  expect(schema.parse([change])).toEqual([change]);
  expect(schema.safeParse([{ ...change, blockId: "bad" }]).success).toBe(false);
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
    expect(schema.safeParse([{ ...change, revision }]).success).toBe(false);
  }
});

test("comment sentOn is a required nullable positive revision sequence", () => {
  const schema = contract.ThreadView.shape.comments.element;
  const comment = {
    id: "11111111-1111-4111-8111-111111111111",
    author: "user",
    body: "Please explain.",
    sent: true,
    sentOn: 2,
  };
  expect(schema.parse(comment)).toEqual(comment);
  expect(schema.parse({ ...comment, sent: false, sentOn: null }).sentOn).toBeNull();
  expect(schema.parse({ ...comment, author: "agent", sent: false, sentOn: null }).sentOn).toBeNull();
  for (const sentOn of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    expect(schema.safeParse({ ...comment, sentOn }).success).toBe(false);
  }
});
