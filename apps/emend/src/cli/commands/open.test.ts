import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { testDb } from "../../db/test-support.ts";
import { run } from "../../main.ts";
import { writeSecretFile } from "../../state/files.ts";
import * as credentials from "../../state/token-file.ts";
import { ensureServer } from "../server-client.ts";
import { commandFixture, provenTestServer } from "../test-support.ts";

vi.mock("../server-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-client.ts")>()),
  ensureServer: vi.fn().mockResolvedValue({ url: "http://127.0.0.1:3636" }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
test.each(
  [true, false, undefined].flatMap((isTTY) => [
    { isTTY, openBrowser: undefined, opened: true },
    { isTTY, openBrowser: false, opened: true },
    { isTTY, openBrowser: true, opened: true },
    { isTTY, openBrowser: true, opened: false },
    { isTTY, openBrowser: true, opened: "throws" },
  ]),
)(
  "no arguments with isTTY=$isTTY, openBrowser=$openBrowser and opener result $opened",
  async ({ isTTY, openBrowser, opened }) => {
    const fixture = await testDb();
    try {
      if (openBrowser !== undefined) writeSecretFile(join(fixture.dir, "config.json"), JSON.stringify({ openBrowser }));
      writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
      const url = `http://127.0.0.1:3636/pair#emp_${"b".repeat(43)}`;
      const proof = provenTestServer(fixture.dir);
      const pairings = vi.fn(async () =>
        Response.json({ url, code: "ABCD-2345", expiresAt: "2026-01-01T00:10:00.000Z" }),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async (target: string | URL, init?: RequestInit) => {
          const response = proof(target, init);
          if (response) return response;
          expect(String(target)).toBe("http://127.0.0.1:3636/api/v1/pairings");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({ purpose: "device" });
          return pairings();
        }),
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const openUrl = vi.fn(async () => {
        expect(pairings).toHaveBeenCalledOnce();
        if (opened === "throws") throw new Error("opener failed");
        return opened === true;
      });
      const code = await run([], {
        isTTY,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { EMEND_HOME: fixture.dir },
        openUrl,
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(ensureServer).toHaveBeenCalledWith(fixture.dir);
      expect(pairings).toHaveBeenCalledTimes(openBrowser || isTTY ? 1 : 0);
      if (openBrowser) expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
      else expect(openUrl).not.toHaveBeenCalled();
      expect(stdout).toEqual([
        openBrowser && opened === true
          ? "Opening emend in your browser.\n"
          : isTTY
            ? `Open this link within 10 minutes: ${url}\n`
            : "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
      ]);
    } finally {
      await fixture.cleanup();
    }
  },
);

test("an HTTP failure is one stderr line, no stdout and exit 1", async () => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const proof = provenTestServer(fixture.dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (target: string | URL, init?: RequestInit) => {
        const response = proof(target, init);
        if (response) return response;
        throw new Error("private connection details");
      }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(
      await run([], {
        isTTY: true,
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { EMEND_HOME: fixture.dir },
        openUrl: async () => true,
      }),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["emend: Could not contact the emend server.\n"]);
  } finally {
    await fixture.cleanup();
  }
});

test("bare emend rewrites a public pairing link to the discovered loopback origin", async () => {
  const fixture = await testDb();
  try {
    writeSecretFile(join(fixture.dir, "config.json"), JSON.stringify({ openBrowser: true }));
    writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
    const secret = `emp_${"c".repeat(43)}`;
    const proof = provenTestServer(fixture.dir);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (target: string | URL, init?: RequestInit) =>
          proof(target, init) ??
          Response.json({
            url: `https://hub.example.ts.net/pair#${secret}`,
            code: "ABCD-2345",
            expiresAt: "2026-01-01T00:10:00.000Z",
          }),
      ),
    );
    const openUrl = vi.fn(async () => true);
    expect(await run([], { stdout: () => {}, stderr: () => {}, env: { EMEND_HOME: fixture.dir }, openUrl })).toBe(0);
    expect(openUrl).toHaveBeenCalledWith(`http://127.0.0.1:3636/pair#${secret}`);
  } finally {
    await fixture.cleanup();
  }
});

test.each(
  [true, false].flatMap((isTTY) => [
    { isTTY, openBrowser: undefined, opened: true },
    { isTTY, openBrowser: false, opened: true },
    { isTTY, openBrowser: true, opened: true },
    { isTTY, openBrowser: true, opened: false },
    { isTTY, openBrowser: true, opened: "throws" },
  ]),
)(
  "attached with isTTY=$isTTY, openBrowser=$openBrowser and opener result $opened",
  async ({ isTTY, openBrowser, opened }) => {
    const f = await commandFixture();
    const hubUrl = "https://hub.example.test";
    writeSecretFile(
      join(f.dir, "attach.json"),
      JSON.stringify({
        hubId: "11111111-1111-4111-8111-111111111111",
        hubName: "Synthetic hub",
        hubUrl,
      }),
    );
    if (openBrowser !== undefined) writeSecretFile(join(f.dir, "config.json"), JSON.stringify({ openBrowser }));
    const openUrl = vi.fn(async () => {
      if (opened === "throws") throw new Error("opener failed");
      return opened === true;
    });
    expect(await run([], { ...f.io, isTTY, openUrl })).toBe(0);
    expect(f.stderr).toEqual([]);
    expect(f.stdout).toEqual([openBrowser && opened === true ? "Opening emend in your browser.\n" : `${hubUrl}\n`]);
    if (openBrowser) expect(openUrl).toHaveBeenCalledExactlyOnceWith(hubUrl);
    else expect(openUrl).not.toHaveBeenCalled();
    expect(ensureServer).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);

test("invalid configuration fails before starting a server or opening a browser", async () => {
  const f = await commandFixture();
  writeSecretFile(join(f.dir, "config.json"), JSON.stringify({ openBrowser: "true" }));
  const openUrl = vi.fn(async () => true);
  expect(await run([], { ...f.io, isTTY: true, openUrl })).toBe(1);
  expect(f.stdout).toEqual([]);
  expect(f.stderr).toEqual(["emend: invalid emend configuration\n"]);
  expect(ensureServer).not.toHaveBeenCalled();
  expect(openUrl).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each([false, undefined])(
  "no terminal (%s) needs no admin credential when browser opening is disabled",
  async (isTTY) => {
    const f = await commandFixture();
    writeSecretFile(join(f.dir, "config.json"), JSON.stringify({ openBrowser: false }));
    await expect(access(join(f.dir, "admin.token"))).rejects.toMatchObject({ code: "ENOENT" });
    const readCredential = vi.spyOn(credentials, "readTokenFile");
    const openUrl = vi.fn(async () => true);
    expect(await run([], { ...f.io, isTTY, openUrl })).toBe(0);
    expect(f.stdout).toEqual([
      "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
    ]);
    expect(f.stderr).toEqual([]);
    expect(ensureServer).toHaveBeenCalledWith(f.dir);
    expect(readCredential).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  },
);

test.each(
  [false, undefined].flatMap(
    (isTTY) =>
      [
        { isTTY, platform: "linux", env: {} },
        { isTTY, platform: "linux", env: { DISPLAY: "", WAYLAND_DISPLAY: "" } },
        { isTTY, platform: "linux", env: { DISPLAY: ":0", PATH: "relative" } },
        { isTTY, platform: "darwin", env: { PATH: "relative" } },
        { isTTY, platform: "freebsd", env: { DISPLAY: ":0" } },
      ] as const,
  ),
)(
  "browser opt-in with no terminal ($isTTY) and no available opener on $platform: $env",
  async ({ isTTY, platform, env }) => {
    const f = await commandFixture();
    writeSecretFile(join(f.dir, "config.json"), JSON.stringify({ openBrowser: true }));
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const readCredential = vi.spyOn(credentials, "readTokenFile");
    expect(await run([], { ...f.io, isTTY, env: { ...f.io.env, ...env } })).toBe(0);
    expect(f.stdout).toEqual([
      "emend is running at http://127.0.0.1:3636. Run emend in a terminal to get a sign-in link.\n",
    ]);
    expect(f.stderr).toEqual([]);
    expect(ensureServer).toHaveBeenCalledWith(f.dir);
    expect(readCredential).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
