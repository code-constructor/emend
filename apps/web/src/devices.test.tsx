import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App.tsx";

const id = "11111111-1111-4111-8111-111111111111";
const item = {
  id,
  kind: "browser",
  name: "Synthetic browser",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: null,
  current: true,
};
const clients: QueryClient[] = [];
function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  return render(
    <StrictMode>
      <App queryClient={client} history={createMemoryHistory({ initialEntries: [path] })} />
    </StrictMode>,
  );
}
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
test("devices lists, confirms current revocation, cancels safely and revokes", async () => {
  const confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const fetcher = vi.fn(async (_path: string, init?: RequestInit) =>
    init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ items: [item] }),
  );
  vi.stubGlobal("fetch", fetcher);
  mount("/devices");
  expect(await screen.findByText("Synthetic browser")).toBeTruthy();
  expect(screen.getByText("This browser")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Pair a device" }).getAttribute("href")).toBe("/devices/pair");
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([path, init]) => path === `/api/v1/devices/${id}` && init?.method === "DELETE"),
    ).toBe(true),
  );
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/pair"));
});
test("revoking another device refreshes the list without confirmation", async () => {
  const confirm = vi.fn();
  vi.stubGlobal("confirm", confirm);
  let revoked = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        revoked = true;
        return new Response(null, { status: 204 });
      }
      return Response.json({ items: revoked ? [] : [{ ...item, current: false }] });
    }),
  );
  mount("/devices");
  fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(screen.queryByText("Synthetic browser")).toBeNull());
  expect(confirm).not.toHaveBeenCalled();
});
test("pair-device creates once under StrictMode and renders a QR with React elements", async () => {
  const url = `https://hub.example.ts.net/pair#emp_${"a".repeat(43)}`;
  const fetcher = vi.fn(async () => Response.json({ url, code: "ABCD-EFGH", expiresAt: "2026-01-01T00:10:00.000Z" }));
  vi.stubGlobal("fetch", fetcher);
  const { container } = mount("/devices/pair");
  expect(await screen.findByText("ABCD-EFGH")).toBeTruthy();
  expect(screen.getByText("Valid for 10 minutes, once.")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Pairing QR code" }).tagName.toLowerCase()).toBe("svg");
  expect(container.querySelectorAll("svg rect").length).toBeGreaterThan(50);
  expect(container.querySelector("img[src^='data:']")).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/pairings",
    expect.objectContaining({ method: "POST", body: JSON.stringify({ purpose: "device" }) }),
  );
});

test.each([
  ["/devices", "Devices"],
  ["/devices/pair", "Pair a device"],
])("%s keeps the scrolling main outside the centred content column", async (path, title) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      path === "/devices"
        ? Response.json({ items: [] })
        : Response.json({ url: "https://hub.example/pair", code: "ABCD-EFGH", expiresAt: "2026-01-01T00:10:00.000Z" }),
    ),
  );
  mount(path);
  const heading = await screen.findByRole("heading", { name: title, level: 1 });
  const main = screen.getByRole("main");
  const column = heading.parentElement;
  expect(main.className).toContain("overflow-y-auto");
  expect(main.className).not.toMatch(/max-w-|mx-auto/);
  expect(column?.parentElement).toBe(main);
  expect(column?.className).toContain("max-w-[760px]");
  expect(column?.className).toContain("mx-auto");
  expect(column?.className).toContain("w-full");
  expect(column?.className).not.toContain("overflow");
});
