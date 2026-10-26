import { expect, test } from "vitest";
import { run } from "./main.ts";

test("--version writes the version to stdout and succeeds", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["--version"], {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    env: process.env,
  });
  expect(stdout).toEqual(["emend 0.1.0\n"]);
  expect(stderr).toEqual([]);
  expect(code).toBe(0);
});

test("an unknown command writes to stderr and returns 2", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await run(["nope"], {
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    env: process.env,
  });
  expect(stderr).toEqual(["emend: unknown command nope\n"]);
  expect(stdout).toEqual([]);
  expect(code).toBe(2);
});
