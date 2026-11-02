import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { claimDraft, useComposerOwner, useReplyComposer } from "./composer-owner.ts";
import { DiffNavigation } from "./diff-navigation.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Editor({ draft, surface, onFocus = true }: { draft: string; surface: string; onFocus?: boolean }) {
  const { input, claim } = useComposerOwner(draft, surface, { kind: "review" });
  return (
    <>
      <textarea aria-label={draft} ref={input} onFocus={onFocus ? claim : undefined} />
      <button type="button" onClick={claim}>
        Claim {draft}
      </button>
    </>
  );
}

test("a newer claim cancels deferred focus even before the newer editor mounts", () => {
  const navigate = vi.fn(() => false);
  const view = render(
    <DiffNavigation value={navigate}>
      <Editor draft="pending" surface="diff" />
    </DiffNavigation>,
  );
  act(() => claimDraft("pending", "diff"));
  expect(navigate).toHaveBeenCalled();
  expect(document.activeElement).not.toBe(screen.getByRole("textbox"));
  act(() => claimDraft("newer", "reading"));
  navigate.mockReturnValue(true).mockClear();
  view.rerender(
    <DiffNavigation value={navigate}>
      <Editor draft="pending" surface="diff" />
      <Editor draft="newer" surface="reading" />
    </DiffNavigation>,
  );
  expect(navigate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "newer" }));
});

test("a local ownership claim supersedes deferred focus without a document focus event", () => {
  const navigate = vi.fn(() => false);
  const scene = () => (
    <DiffNavigation value={navigate}>
      <Editor draft="pending-local" surface="diff" />
      <Editor draft="local" surface="reading" />
    </DiffNavigation>
  );
  const view = render(scene());
  act(() => claimDraft("pending-local", "diff"));
  // Claim without moving focus, so the document listener cannot cancel the request.
  vi.spyOn(screen.getByRole("textbox", { name: "local" }), "focus").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Claim local" }));
  navigate.mockReturnValue(true).mockClear();
  view.rerender(scene());
  expect(navigate).not.toHaveBeenCalled();
});

test.each(["reading", "diff"])("the hidden guard preserves the %s surface's focus behavior", (surface) => {
  render(
    <div hidden>
      <Editor draft={`hidden-${surface}`} surface={surface} />
    </div>,
  );
  const input = screen.getByLabelText(`hidden-${surface}`);
  const focus = vi.spyOn(input, "focus");
  act(() => claimDraft(`hidden-${surface}`, surface));
  expect(focus).toHaveBeenCalledTimes(surface === "diff" ? 0 : 1);
});

test.each(["local claim", "native focusin"])("R8 fix3 %s renews a canceled request on an owned editor", (action) => {
  const navigate = vi.fn(() => false);
  const scene = () => (
    <DiffNavigation value={navigate}>
      <Editor draft="returning" surface="diff" onFocus={false} />
      <input aria-label="Away" />
    </DiffNavigation>
  );
  const view = render(scene());
  const returning = screen.getByRole("textbox", { name: "returning" });
  act(() => claimDraft("returning", "diff"));
  expect(navigate).toHaveBeenCalled();
  act(() => screen.getByRole("textbox", { name: "Away" }).focus());
  navigate.mockClear();
  view.rerender(scene());
  expect(navigate).not.toHaveBeenCalled();

  // The native case has no React onFocus handler; the claim case moves no DOM focus.
  if (action === "local claim") fireEvent.click(screen.getByRole("button", { name: "Claim returning" }));
  else act(() => returning.focus());
  expect(navigate).toHaveBeenCalled();
  navigate.mockReturnValue(true).mockClear();
  view.rerender(scene());
  expect(navigate).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(returning);
});

function ReplacedCard({ instance }: { instance: string }) {
  useReplyComposer("replaced");
  return <Editor key={instance} draft="replaced" surface="diff" onFocus={false} />;
}
test("R8 fix4 a pending request follows its replacement without renewing until native focus returns", () => {
  const navigate = vi.fn(() => false);
  const scene = (instance: string) => (
    <DiffNavigation value={navigate}>
      <ReplacedCard instance={instance} />
      <input aria-label="Elsewhere" />
    </DiffNavigation>
  );
  const view = render(scene("fallback"));
  const original = screen.getByRole("textbox", { name: "replaced" });
  const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
  act(() => claimDraft("replaced", "diff"));
  expect(navigate).toHaveBeenCalled();
  act(() => elsewhere.focus());
  navigate.mockClear();
  view.rerender(scene("inline"));
  const replacement = screen.getByRole("textbox", { name: "replaced" });
  expect(replacement).not.toBe(original);
  expect(original.isConnected).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(elsewhere);

  // No React onFocus handler can renew by key; the native event must recognize the new editor.
  act(() => replacement.focus());
  expect(navigate).toHaveBeenCalled();
  navigate.mockReturnValue(true).mockClear();
  view.rerender(scene("inline"));
  expect(navigate).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(replacement);
});
