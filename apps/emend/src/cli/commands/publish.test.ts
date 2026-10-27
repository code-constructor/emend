import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import { type PublishManifest, PublishRequest } from "@emend/contract";
import { afterEach, expect, test, vi } from "vitest";
import { run } from "../../main.ts";
import { commandFixture, provenTestServer } from "../test-support.ts";
import { publishCommand, publishTimeoutMs } from "./publish.ts";

afterEach(() => vi.unstubAllGlobals());
test("publish with closed stdout exits 1 with one diagnostic", async () => {
  const f = await commandFixture();
  const manifest = join(f.dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [],
      writeup: { overview: "", tldr: "", decisions: null, topics: {} },
    }),
  );
  await writeFile(join(f.dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
  const reviewId = randomUUID();
  f.setResponse(async () =>
    Response.json({
      reviewId,
      revision: 1,
      placed: 0,
      unplaced: 0,
      unrendered: ["synthetic.md"],
      url: `http://127.0.0.1:3636/r/${reviewId}`,
    }),
  );
  const closed = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  closed.on("error", () => {});
  closed.destroy();
  f.io.stdoutAsync = (line) =>
    new Promise<void>((resolve, reject) => {
      closed.write(line, (error) => (error ? reject(error) : resolve()));
    });
  expect(await run(["publish", "--manifest", manifest, "--key", "synthetic"], f.io)).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: Could not write to stdout.\n"]);
});
test("publish deadlines include the slot, one render pass and three placement attempts", () => {
  expect(publishTimeoutMs([])).toBe(145000);
  expect(
    publishTimeoutMs([
      { role: "doc", path: "one.md" },
      { role: "doc", path: "two.markdown" },
      { role: "doc", path: "page.html" },
      { role: "diff", path: "source.md" },
    ]),
  ).toBe(165000);
});
test("publish stdout is exactly one JSON line and unchanged docs upload nothing twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-command-"));
  try {
    await promisify(execFile)("git", ["init", dir]);
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`);
    await writeFile(join(dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    await writeFile(join(dir, "config.json"), JSON.stringify({ docRoots: [dir] }));
    const input: PublishManifest = {
      version: 1,
      title: "Synthetic",
      topics: [],
      files: [{ path: "plan.md", role: "doc" }],
      writeup: { overview: "hi", tldr: "short", decisions: null, topics: {} },
    };
    const path = join(dir, "manifest.json");
    await writeFile(path, JSON.stringify(input));
    await writeFile(join(dir, "plan.md"), "# Plan");
    const proof = provenTestServer(dir);
    const blobs = new Set<string>();
    const reviewId = randomUUID();
    let revision = 0;
    let puts = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const proven = proof(url, init);
      if (proven) return proven;
      if (init?.method === "HEAD") return new Response(null, { status: blobs.has(String(url)) ? 204 : 404 });
      if (init?.method === "PUT") {
        puts++;
        blobs.add(String(url));
        return new Response(null, { status: 204 });
      }
      PublishRequest.parse(JSON.parse(String(init?.body)));
      return Response.json({
        reviewId,
        revision: ++revision,
        placed: 0,
        unplaced: 0,
        unrendered: revision === 2 ? ["plan.md"] : [],
        url: `http://127.0.0.1:3636/r/${reviewId}`,
      });
    });
    for (let i = 1; i <= 2; i++) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      await publishCommand(
        dir,
        ["--manifest", path, "--key", "plan"],
        { stdout: (s) => stdout.push(s), stderr: (s) => stderr.push(s), env: { EMEND_HOME: dir } },
        dir,
      );
      expect(stdout).toHaveLength(1);
      expect(stdout[0]?.split("\n")).toHaveLength(2);
      expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ reviewId, revision: i });
      expect(stderr).toEqual([
        ...(i === 2 ? ["emend: could not render plan.md\n"] : []),
        `emend: published revision ${i}: http://127.0.0.1:3636/r/${reviewId}\n`,
      ]);
    }
    expect(puts).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("docs-only without a key, malformed manifests and unknown reviews fail with one stderr line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-command-errors-"));
  try {
    const path = join(dir, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    const proof = provenTestServer(dir);
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`);
    await writeFile(join(dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ??
        Response.json({ error: { code: "unknown_review", message: "untrusted\nmessage" } }, { status: 404 }),
    );
    for (const [args, expected] of [
      [["--manifest", path], "emend: pass --review or --key\n"],
      [["--manifest", path, "--review", randomUUID()], "emend: unknown_review\n"],
      [["--manifest", join(dir, "missing")], "emend: invalid publish manifest\n"],
    ] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(
        await run(["publish", ...args], {
          stdout: (s) => stdout.push(s),
          stderr: (s) => stderr.push(s),
          env: { EMEND_HOME: dir },
        }),
      ).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([expected]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 200 with an invalid publish response reports possible publication on one stderr line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "emend-command-answer-"));
  try {
    const path = join(dir, "manifest.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        title: "Synthetic",
        topics: [],
        files: [],
        writeup: { overview: "", tldr: "", decisions: null, topics: {} },
      }),
    );
    await writeFile(join(dir, "agent.token"), `em_${"a".repeat(43)}`);
    await writeFile(join(dir, "instance.json"), JSON.stringify({ id: randomUUID() }));
    const proof = provenTestServer(dir);
    vi.stubGlobal(
      "fetch",
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ?? Response.json({ revision: "invalid", message: "untrusted\nmessage" }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await run(["publish", "--manifest", path, "--key", "docs"], {
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { EMEND_HOME: dir },
      }),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["emend: the server's answer was cut off; the revision may have been published\n"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
