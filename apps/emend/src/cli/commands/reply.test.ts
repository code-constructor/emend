import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { run } from "../../main.ts";
import { commandFixture } from "../test-support.ts";
import { readReplyBody } from "./reply.ts";

const commentId = randomUUID();
test.each(["file", "stdin"])("the %s byte reader accepts exactly 80000 bytes and refuses 80001", async (source) => {
  const f = await commandFixture();
  const path = join(f.dir, "boundary.txt");
  for (const size of [80000, 80001]) {
    const body = "x".repeat(size);
    await writeFile(path, body);
    f.io.stdin = Readable.from([Buffer.from(body)]);
    const result = readReplyBody(source === "file" ? path : "-", f.io);
    if (size === 80000) await expect(result).resolves.toBe(body);
    else await expect(result).rejects.toThrow("at most 80000 bytes");
  }
});

test.each(["symlink", "fifo"])(
  "reply refuses a %s without following it or waiting for a writer",
  async (kind) => {
    const f = await commandFixture();
    const path = join(f.dir, "body");
    if (kind === "symlink") {
      await writeFile(join(f.dir, "target"), "Synthetic body");
      await symlink(join(f.dir, "target"), path);
    } else await promisify(execFile)("mkfifo", [path]);
    expect(await run(["reply", commentId, "--status", "held", "--body-file", path], f.io)).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  },
  1000,
);
test.each(["body", "file", "stdin"])("reply reads %s, validates and prints only ReplyCreated", async (source) => {
  const f = await commandFixture();
  const body = "Synthetic reply\nwith a second line.";
  const created = { commentId: randomUUID(), threadId: randomUUID(), state: "answered" };
  const file = join(f.dir, "reply.txt");
  await writeFile(file, body);
  f.io.stdin = Readable.from([Buffer.from(body)]);
  f.setResponse(async (url, init) => {
    expect(String(url)).toMatch(new RegExp(`/comments/${commentId}/reply$`));
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: "explained", body });
    return Response.json(created, { status: 201 });
  });
  const args = source === "body" ? ["--body", body] : ["--body-file", source === "stdin" ? "-" : file];
  expect(await run(["reply", commentId, "--status", "explained", ...args], f.io)).toBe(0);
  expect(f.stdout).toEqual([`${JSON.stringify(created)}\n`]);
  expect(f.stderr).toEqual([]);
});

test("reply preserves UTF-8 text including a BOM and accepts the character limit", async () => {
  const f = await commandFixture();
  const body = `\ufeff${"界".repeat(19999)}`;
  const path = join(f.dir, "reply.txt");
  await writeFile(path, body);
  f.setResponse(async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ outcome: "held", body });
    return Response.json({ commentId: randomUUID(), threadId: randomUUID(), state: "answered" });
  });
  expect(await run(["reply", commentId, "--status", "held", "--body-file", path], f.io)).toBe(0);
});

test.each([
  [],
  ["bad", "--status", "fixed", "--body", "ok"],
  [commentId, "--body", "ok"],
  [commentId, "--status", "bogus", "--body", "ok"],
  [commentId, "--status", "fixed"],
  [commentId, "--status", "held", "--body", "x", "--body-file", "-"],
  [commentId, "--status", "held", "--body", "x", "--body", "y"],
  [commentId, "--status", "held", "--body", " "],
  [commentId, "--status", "held", "--body", "x".repeat(20001)],
  [commentId, "--status", "held", "--body", "\ud800"],
])("invalid reply arguments fail before any HTTP request", async (...args) => {
  const f = await commandFixture();
  expect(await run(["reply", ...args], f.io)).toBe(2);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toHaveLength(1);
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(["huge-file", "huge-stdin", "directory", "missing"])(
  "reply refuses %s without logging content or sending a request",
  async (kind) => {
    const f = await commandFixture();
    let path = join(f.dir, "body.txt");
    if (kind === "huge-file") await writeFile(path, "s".repeat(80001));
    if (kind === "directory") path = f.dir;
    let reads = 0;
    f.io.stdin = Readable.from(
      (async function* () {
        for (let i = 0; i < 100; i++) {
          reads++;
          yield Buffer.alloc(80001, "s");
        }
      })(),
      { highWaterMark: 1 },
    );
    const code = await run(
      ["reply", commentId, "--status", "held", "--body-file", kind === "huge-stdin" ? "-" : path],
      f.io,
    );
    expect(code).toBe(1);
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
    expect(f.stderr.join("")).not.toContain("ssss");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(reads).toBeLessThanOrEqual(2);
  },
);
