import { afterEach, expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import { startServer } from "../../server/serve.ts";
import { parseServeArgs } from "./serve.ts";

vi.mock("../../server/serve.ts", () => ({ startServer: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
test("serve defaults to loopback, allows explicit host and port zero, and rejects bad flags", async () => {
  expect(parseServeArgs([])).toEqual({ host: "127.0.0.1", port: 3636 });
  expect(parseServeArgs(["--host", "192.0.2.1", "--port", "0"])).toEqual({ host: "192.0.2.1", port: 0 });
  for (const args of [
    ["--bad"],
    ["--port"],
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", "1.5"],
    ["--host"],
    ["--host", "--port"],
    ["--host", "http://evil.example"],
    ["--port", "1", "--port", "2"],
  ]) {
    const stderr: string[] = [];
    const stdout: string[] = [];
    expect(
      await run(["serve", ...args], { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s), env: process.env }),
    ).toBe(2);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]?.split("\n")).toHaveLength(2);
    expect(stdout).toEqual([]);
  }
});

test.each(["SIGINT", "SIGTERM"] as const)("serve prints once and closes cleanly on %s", async (signal) => {
  const close = vi.fn().mockResolvedValue(undefined);
  vi.mocked(startServer).mockResolvedValue({ url: "http://127.0.0.1:3636", close });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = run(["serve"], { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s), env: process.env });
  await vi.waitFor(() => expect(stdout).toEqual(["emend is serving http://127.0.0.1:3636\n"]));
  process.emit(signal);
  expect(await result).toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
  expect(stderr).toEqual([]);
});
