import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { testDb } from "../../db/test-support.ts";
import { run } from "../../main.ts";
import { writeSecretFile } from "../../state/files.ts";
import { provenTestServer } from "../test-support.ts";

vi.mock("../server-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server-client.ts")>()),
  ensureServer: vi.fn().mockResolvedValue({ url: "http://127.0.0.1:3636" }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
test.each([true, false, "throws"])(
  "no arguments creates a device pairing and reports opener result %s",
  async (opened) => {
    const fixture = await testDb();
    try {
      writeSecretFile(join(fixture.dir, "admin.token"), `em_${"a".repeat(43)}`);
      const url = `http://127.0.0.1:3636/pair#emp_${"b".repeat(43)}`;
      const proof = provenTestServer(fixture.dir);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (target: string | URL, init?: RequestInit) =>
            proof(target, init) ?? Response.json({ url, code: "ABCD-2345", expiresAt: "2026-01-01T00:10:00.000Z" }),
        ),
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const openUrl = vi.fn(async () => {
        if (opened === "throws") throw new Error("opener failed");
        return opened === true;
      });
      const code = await run([], {
        stdout: (s) => stdout.push(s),
        stderr: (s) => stderr.push(s),
        env: { EMEND_HOME: fixture.dir },
        openUrl,
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(openUrl).toHaveBeenCalledWith(url);
      expect(stdout).toEqual([
        opened === true ? "Opening emend in your browser.\n" : `Open this link within 10 minutes: ${url}\n`,
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
