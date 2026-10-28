import { randomUUID } from "node:crypto";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS } from "@emend/contract";
import { expect, test, vi } from "vitest";
import { run } from "../main.ts";
import { apiRequest } from "./http.ts";
import * as discovery from "./server-client.ts";
import { resolveTarget } from "./target.ts";
import { commandFixture } from "./test-support.ts";

const hub = { hubUrl: "https://hub.example", hubId: randomUUID(), hubName: "Synthetic hub" };

test("a thrown discovery error never selects direct mode", async () => {
  const f = await commandFixture();
  vi.spyOn(discovery, "discover").mockRejectedValueOnce(new Error("synthetic discovery failure"));
  await expect(resolveTarget(f.dir)).rejects.toThrow("synthetic discovery failure");
  expect(await readdir(f.dir)).not.toContain("emend.db");
});
async function attached() {
  const f = await commandFixture();
  await writeFile(join(f.dir, "attach.json"), JSON.stringify(hub));
  await writeFile(join(f.dir, "hub.token"), `em_${"b".repeat(43)}`);
  return f;
}

test("hub probing stops a streamed oversized capabilities body before sending a credential", async () => {
  const f = await attached();
  let chunks = 0;
  const cancelled = vi.fn();
  const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            chunks++;
            if (chunks === 1) controller.enqueue(Buffer.from('{"api":1,"version":"0.1.0","features":[]}'));
            else if (chunks < 2048) controller.enqueue(Buffer.alloc(LIMITS.publicJsonBytes, " "));
            else controller.close();
          },
          cancel: cancelled,
        },
        { highWaterMark: 0 },
      ),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(resolveTarget(f.dir)).rejects.toThrow(`cannot reach the hub at ${hub.hubUrl}: not an emend hub`);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(chunks).toBe(2);
  expect(cancelled).toHaveBeenCalledOnce();
});

test.each([
  { ...hub, extra: true },
  { ...hub, hubId: "invalid" },
  { ...hub, hubName: "" },
  { ...hub, hubName: "x".repeat(201) },
  ...[
    "http://hub.example",
    "https://user:pass@hub.example",
    "https://hub.example/path",
    "https://hub.example?x",
    "https://hub.example#x",
    "//hub.example",
    "file:///tmp/hub",
    "https://hub.example/../",
    "https://hub.example\n",
  ].map((hubUrl) => ({ ...hub, hubUrl })),
])("invalid attach configuration never falls back to local", async (value) => {
  const f = await attached();
  await writeFile(join(f.dir, "attach.json"), JSON.stringify(value));
  await expect(resolveTarget(f.dir)).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});

test.each(["malformed", "directory", "dangling", "missing-token", "bad-token", "token-directory"])(
  "unreadable or invalid attachment %s never falls back",
  async (kind) => {
    const f = await commandFixture();
    const path = join(f.dir, "attach.json");
    if (kind === "directory") await mkdir(path);
    else if (kind === "dangling") await symlink(join(f.dir, "absent"), path);
    else await writeFile(path, kind === "malformed" ? "{" : JSON.stringify(hub));
    if (kind === "bad-token") await writeFile(join(f.dir, "hub.token"), "invalid");
    if (kind === "token-directory") await mkdir(join(f.dir, "hub.token"));
    expect(await run(["feedback", randomUUID()], f.io)).toBe(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.stdout).toEqual([]);
    expect(f.stderr).toHaveLength(1);
  },
);

test.each(["connection", "timeout", "status", "invalid", "redirect"])(
  "hub probe %s failure prints a fixed line and sends no token",
  async (failure) => {
    const f = await attached();
    const before = await readdir(f.dir);
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("X-Emend-Client")).toBe("cli/0.1.0");
      if (failure === "connection") throw Object.assign(new Error("untrusted"), { cause: { code: "ECONNREFUSED" } });
      if (failure === "timeout") throw new DOMException("untrusted", "TimeoutError");
      if (failure === "redirect")
        return new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } });
      return Response.json(failure === "invalid" ? {} : { error: "untrusted" }, {
        status: failure === "status" ? 500 : 200,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await run(["feedback", randomUUID()], f.io)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.stdout).toEqual([]);
    const reason =
      failure === "connection" ? "connection refused" : failure === "timeout" ? "timed out" : "not an emend hub";
    expect(f.stderr).toEqual([`emend: cannot reach the hub at ${hub.hubUrl}: ${reason}. Nothing was changed.\n`]);
    expect(await readdir(f.dir)).toEqual(before);
  },
);

test.each([hub.hubUrl, "http://127.0.0.1:3637", "http://localhost:3637", "http://[::1]:3637"])(
  "hub %s is probed before using only its token",
  async (hubUrl) => {
    const f = await attached();
    await writeFile(join(f.dir, "attach.json"), JSON.stringify({ ...hub, hubUrl }));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      expect(String(url).startsWith(`${hubUrl}/api/v1/`)).toBe(true);
      expect(init?.redirect).toBe("error");
      const auth = new Headers(init?.headers).get("Authorization");
      if (calls.length === 1) {
        expect(auth).toBeNull();
        return Response.json({ api: 1, version: "0.1.0", features: [] });
      }
      expect(auth).toBe(`Bearer em_${"b".repeat(43)}`);
      return new Response(null, { status: 204 });
    });
    const target = await resolveTarget(f.dir);
    expect(target).toMatchObject({ url: hubUrl, via: "hub" });
    await apiRequest(f.dir, target, `/deliveries/${randomUUID()}/confirm`, { method: "POST" });
    expect(calls).toHaveLength(2);
  },
);

test("local target re-proves before each token-bearing request", async () => {
  const f = await commandFixture();
  const target = await resolveTarget(f.dir);
  expect(target.via).toBe("local");
  await apiRequest(f.dir, target, "/synthetic", { method: "POST" });
  await apiRequest(f.dir, target, "/synthetic", { method: "POST" });
  expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/capabilities"))).toHaveLength(3);
  for (const [, init] of f.fetcher.mock.calls) {
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("X-Emend-Client")).toBe("cli/0.1.0");
  }
});
