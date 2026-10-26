import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { openBrowser } from "./open.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
test.each(["spawn", "error"])("browser opener settles on %s without waiting for exit", async (event) => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() }) as unknown as ReturnType<typeof spawn>;
  vi.mocked(spawn).mockReturnValueOnce(child);
  const url = `http://127.0.0.1:3636/pair#emp_${"a".repeat(43)}`;
  const opened = openBrowser(url);
  expect(spawn).toHaveBeenLastCalledWith(process.platform === "darwin" ? "open" : "xdg-open", [url], {
    detached: true,
    stdio: "ignore",
  });
  if (event === "error") child.emit("error", Object.assign(new Error("missing opener"), { code: "ENOENT" }));
  else child.emit("spawn");
  expect(await Promise.race([opened, new Promise((resolve) => setImmediate(() => resolve("pending")))])).toBe(
    event === "spawn",
  );
  expect(child.unref).toHaveBeenCalledTimes(event === "spawn" ? 1 : 0);
});
