import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { useThreadJump } from "./thread-jump.ts";

afterEach(cleanup);

const renders = vi.fn();
const Card = memo(() => {
  const jump = useThreadJump("thread-seed");
  renders(jump);
  return <article aria-label="Synthetic card" data-jump={jump ? "" : undefined} />;
});

test("thread jump subscribers render only when their own boolean jump state changes", async () => {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ history, routeTree: createRootRoute({ component: () => <Card /> }) });
  render(<RouterProvider router={router} />);
  const card = await screen.findByRole("article", { name: "Synthetic card" });
  renders.mockClear();
  await act(async () => history.push("/?tab=docs#thread-other"));
  await act(async () => history.push("/?tab=comments#topic-seed"));
  expect(renders).not.toHaveBeenCalled();
  await act(async () => history.push("/#thread-seed"));
  expect(renders).toHaveBeenCalledWith(true);
  expect(card.hasAttribute("data-jump")).toBe(true);
  renders.mockClear();
  await act(async () => history.push("/?rev=2#thread-seed"));
  expect(renders).not.toHaveBeenCalled();
  await act(async () => history.push("/#thread-other"));
  expect(renders).toHaveBeenCalledWith(false);
  expect(card.hasAttribute("data-jump")).toBe(false);
});
