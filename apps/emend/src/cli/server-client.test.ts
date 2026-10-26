import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { testDb } from "../db/test-support.ts";
import { startServer } from "../server/serve.ts";
import { writeSecretFile } from "../state/files.ts";
import { ensureServer } from "./server-client.ts";

test("ensureServer reuses a live server with valid capabilities", async () => {
  const fixture = await testDb();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const stateDir = join(fixture.dir, "state-server");
    server = await startServer({ stateDir, port: 0 });
    expect(await ensureServer(stateDir)).toEqual({ url: server.url });
  } finally {
    await server?.close();
    await fixture.cleanup();
  }
});

test("ensureServer starts a detached server after a dead discovery pid", async () => {
  const fixture = await testDb();
  const stateDir = join(fixture.dir, "spawned");
  let pid: number | undefined;
  try {
    await mkdir(stateDir, { mode: 0o700 });
    writeSecretFile(
      join(stateDir, "server.json"),
      JSON.stringify({ pid: 2147483647, url: "http://127.0.0.1:1", port: 1, startedAt: new Date().toISOString() }),
    );
    // A self-contained synthetic entry avoids source-loader or package resolution differences.
    const entry = join(fixture.dir, "entry.mjs");
    await writeFile(
      entry,
      `import { createServer } from 'node:http';\nimport { randomBytes, createHmac } from 'node:crypto';\nconst key = randomBytes(32).toString('base64url');\nimport { writeFileSync, unlinkSync } from 'node:fs';\nimport { join } from 'node:path';\nif (process.argv[2] !== 'serve') process.exit(2);\nconst path = join(process.env.EMEND_HOME, 'server.json');\nconst server = createServer((req,res) => { const challenge = req.headers['x-emend-challenge']; if (typeof challenge === 'string') res.setHeader('X-Emend-Proof',createHmac('sha256',Buffer.from(key,'base64url')).update(challenge).digest('base64url')); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({api:1,version:'0.1.0',features:[]})); });\nserver.on('error', (error) => { writeFileSync(join(process.env.EMEND_HOME, 'listen-error'), error.code); process.exit(1); });\nserver.listen(0,'127.0.0.1', () => { const port = server.address().port; writeFileSync(path, JSON.stringify({key,pid:process.pid,url:'http://127.0.0.1:'+port,port,startedAt:new Date().toISOString()}), {mode:0o600}); });\nprocess.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => { unlinkSync(path); process.exit(0); }); });\nsetTimeout(() => process.exit(0), 10000).unref();\n`,
    );
    const result = await ensureServer(stateDir, { entry, timeoutMs: 4000 }).catch(async (error) => {
      const code = await readFile(join(stateDir, "listen-error"), "utf8").catch(() => "");
      if (["EPERM", "EACCES"].includes(code)) throw new Error(`Synthetic child listen ${code}`);
      throw error;
    });
    pid = JSON.parse(await readFile(join(stateDir, "server.json"), "utf8")).pid;
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(pid).not.toBe(process.pid);
  } finally {
    if (pid) {
      process.kill(pid, "SIGTERM");
      await vi.waitFor(async () => {
        await expect(readFile(join(stateDir, "server.json"))).rejects.toMatchObject({ code: "ENOENT" });
      });
    }
    await fixture.cleanup();
  }
});

test("a detached child that exits before discovery produces one fixed error", async () => {
  const fixture = await testDb();
  try {
    const entry = join(fixture.dir, "exit.mjs");
    await writeFile(entry, "process.exit(1);");
    await expect(ensureServer(join(fixture.dir, "failed"), { entry, timeoutMs: 150 })).rejects.toThrow(
      "Could not start the emend server.",
    );
  } finally {
    await fixture.cleanup();
  }
});
