import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { NewerDatabaseError } from "../db/migrate.ts";
import { testDb } from "../db/test-support.ts";
import { StateDirModeError, writeSecretFile } from "../state/files.ts";
import { apiRequest, errorLine } from "./http.ts";
import { localTarget } from "./target.ts";
import { provenTestServer } from "./test-support.ts";

afterEach(() => vi.unstubAllGlobals());

test.each([
  "config",
  "publish",
  "wait",
  "feedback",
  "reply",
  "mcp",
  "service",
  "skills",
  "pair",
  "devices",
  "attach",
  "detach",
  "serve",
  "open",
])("%s mode errors escape the folder everywhere on one line", (command) => {
  const error = new StateDirModeError("/synthetic/state\n\u001b[31m\u202e");
  expect(errorLine(error, command)).toBe(
    "State directory /synthetic/state\\u{a}\\u{1b}[31m\\u{202e} has group or other permissions; fix it with chmod 700 '/synthetic/state\\u{a}\\u{1b}[31m\\u{202e}'\n",
  );
});

test("mode errors keep a pasteable chmod hint for ordinary paths with spaces and quotes", () => {
  const dir = "/synthetic/reviewer's state";
  expect(errorLine(new StateDirModeError(dir), "config")).toBe(
    "State directory /synthetic/reviewer's state has group or other permissions; fix it with chmod 700 '/synthetic/reviewer'\\''s state'\n",
  );
});

test("newer-database errors contain no path and keep their fixed diagnostic", () => {
  expect(errorLine(new NewerDatabaseError(), "config")).toBe(
    "The emend database is newer than this emend. Update emend, then try again.\n",
  );
});

test("a publish timeout reports that nothing was published", async () => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "agent.token"), `em_${"a".repeat(43)}`);
    const proof = provenTestServer(fixture.dir);
    vi.stubGlobal(
      "fetch",
      (url: string | URL, init?: RequestInit) =>
        proof(url, init) ??
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    await expect(
      apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "agent"), "/publish", {
        method: "POST",
        body: {},
        timeoutMs: 10,
      }),
    ).rejects.toThrow("the server did not answer in time; nothing was published");
  } finally {
    await fixture.cleanup();
  }
});
test("HTTP sends state token, version and JSON, refuses redirects and renders fixed API errors", async () => {
  const fixture = await testDb();
  try {
    const secret = `em_${"a".repeat(43)}`;
    writeSecretFile(join(fixture.dir, "admin.token"), secret);
    const proof = provenTestServer(fixture.dir);
    let calls = 0;
    const fetcher = vi.fn(
      async (url: string | URL, init?: RequestInit) =>
        proof(url, init) ??
        (++calls === 1
          ? Response.json({ ok: true })
          : Response.json({ error: { code: "unauthorized", message: `untrusted\n${secret}` } }, { status: 401 })),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "admin"), "/pairings", {
        method: "POST",
        body: { purpose: "device" },
      }),
    ).toEqual({ ok: true });
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("http://127.0.0.1:3636/api/v1/pairings");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      redirect: "error",
      headers: { Authorization: `Bearer ${secret}`, "X-Emend-Client": "cli/0.1.0", "Content-Type": "application/json" },
      body: '{"purpose":"device"}',
    });
    await expect(
      apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "admin"), "/pairings", {
        method: "POST",
        body: {},
      }),
    ).rejects.toThrow("Authentication is required.");
  } finally {
    await fixture.cleanup();
  }
});

test("CLI tokens trim trailing CR/LF and reject symlinks before any Authorization is sent", async () => {
  const fixture = await testDb();
  try {
    const proof = provenTestServer(fixture.dir);
    const secret = `em_${"a".repeat(43)}`;
    const path = join(fixture.dir, "admin.token");
    writeSecretFile(path, `${secret}\r\n`);
    const fetcher = vi.fn(
      async (url: string | URL, init?: RequestInit) => proof(url, init) ?? Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      await apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "admin"), "/pairings", {
        method: "POST",
        body: {},
      }),
    ).toEqual({ ok: true });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
    await rm(path);
    const target = join(fixture.dir, "outside-token");
    writeSecretFile(target, secret);
    await symlink(target, path);
    fetcher.mockClear();
    await expect(localTarget(fixture.dir, "http://127.0.0.1:3636", "admin")).rejects.toThrow(
      "Could not read the emend credential.",
    );
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
});

test.each([200, 500])(
  "publish response %i body timeout distinguishes a possibly published revision",
  async (status) => {
    const fixture = await testDb();
    try {
      writeSecretFile(join(fixture.dir, "agent.token"), `em_${"a".repeat(43)}`);
      const proof = provenTestServer(fixture.dir);
      vi.stubGlobal(
        "fetch",
        async (url: string | URL, init?: RequestInit) =>
          proof(url, init) ??
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"partial":'));
                init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
              },
            }),
            { status, headers: { "Content-Type": "application/json" } },
          ),
      );
      await expect(
        apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "agent"), "/publish", {
          method: "POST",
          body: {},
          timeoutMs: 10,
        }),
      ).rejects.toThrow(
        status === 200
          ? "the server's answer timed out; the revision may have been published"
          : "The emend server returned an invalid response.",
      );
    } finally {
      await fixture.cleanup();
    }
  },
);

test.each([200, 500])("publish response %i body reset preserves possible publication", async (status) => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "agent.token"), `em_${"a".repeat(43)}`);
    const proof = provenTestServer(fixture.dir);
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const proven = proof(url, init);
      if (proven) return proven;
      signal = init?.signal;
      let partial = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (partial) controller.error(new TypeError("connection reset"));
            else {
              controller.enqueue(new TextEncoder().encode('{"partial":'));
              partial = true;
            }
          },
        }),
        { status, headers: { "Content-Type": "application/json" } },
      );
    });
    await expect(
      apiRequest(fixture.dir, await localTarget(fixture.dir, "http://127.0.0.1:3636", "agent"), "/publish", {
        method: "POST",
        body: {},
      }),
    ).rejects.toThrow(
      status === 200
        ? "the server's answer was cut off; the revision may have been published"
        : "The emend server returned an invalid response.",
    );
    expect(signal?.aborted).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
