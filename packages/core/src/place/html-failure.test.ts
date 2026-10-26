import { defaultTreeAdapter, html, parse } from "parse5";
import { expect, test, vi } from "vitest";
import { docText } from "./html.ts";

vi.mock("parse5", async (importOriginal) => ({
  ...(await importOriginal<typeof import("parse5")>()),
  parse: vi.fn(),
}));

test("parser failures become unreadable documents", () => {
  vi.mocked(parse).mockImplementationOnce(() => {
    throw new RangeError("Synthetic parser failure");
  });
  expect(docText("<p>seed</p>")).toBeNull();
});

test("text-walk failures also become unreadable documents", () => {
  const tree = defaultTreeAdapter.createDocument();
  const root = defaultTreeAdapter.createElement("html", html.NS.HTML, []);
  const body = defaultTreeAdapter.createElement("body", html.NS.HTML, []);
  defaultTreeAdapter.appendChild(tree, root);
  defaultTreeAdapter.appendChild(root, body);
  Object.defineProperty(body, "childNodes", {
    get() {
      throw new RangeError("Synthetic tree-walk failure");
    },
  });
  vi.mocked(parse).mockReturnValueOnce(tree);
  expect(docText("<p>seed</p>")).toBeNull();
});
