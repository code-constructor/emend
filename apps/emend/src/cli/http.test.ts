import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { testDb } from "../db/test-support.ts";
import { writeSecretFile } from "../state/files.ts";
import { apiRequest } from "./http.ts";
import { provenTestServer } from "./test-support.ts";

afterEach(() => vi.unstubAllGlobals());
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
      await apiRequest(fixture.dir, "http://127.0.0.1:3636", "/pairings", {
        token: "admin",
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
      apiRequest(fixture.dir, "http://127.0.0.1:3636", "/pairings", { token: "admin", method: "POST", body: {} }),
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
      await apiRequest(fixture.dir, "http://127.0.0.1:3636", "/pairings", { token: "admin", method: "POST", body: {} }),
    ).toEqual({ ok: true });
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
    await rm(path);
    const target = join(fixture.dir, "outside-token");
    writeSecretFile(target, secret);
    await symlink(target, path);
    fetcher.mockClear();
    await expect(
      apiRequest(fixture.dir, "http://127.0.0.1:3636", "/pairings", { token: "admin", method: "POST" }),
    ).rejects.toThrow("Could not read the emend credential.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});
