import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  allocatePort,
  busyPorts,
  lockPath,
  PORT_MAX,
  PORT_MIN,
  portRange,
  registryPath,
  setPortRangeForTests,
  withRegistry,
} from "./registry.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  deadPid,
  type Fixture,
  listenOn,
  makeFixture,
  makeTestEnv,
  runWt,
  type TestEnv,
  testPortRange,
} from "./test-support.ts";
import { WtError } from "./validate.ts";

let env: TestEnv;
let fx: Fixture;
let repo: Repo;

before(() => {
  env = makeTestEnv();
  fx = makeFixture(env);
  repo = resolveRepo(fx.main);
});
after(() => env.cleanup());

const entry = (port: number) => ({
  path: `/nowhere/${port}`,
  port,
  task: null,
  mode: "github" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
});

test("registry survives concurrent writers", async () => {
  const here = pathToFileURL(import.meta.dirname).href;
  const code = `
    import { allocatePort, withRegistry } from "${here}/registry.ts";
    import { resolveRepo } from "${here}/repo.ts";
    const repo = resolveRepo(process.argv[1]);
    const tag = process.argv[2];
    for (let i = 0; i < 5; i++) {
      withRegistry(repo, (r) => {
        const port = allocatePort(r, new Set());
        r.worktrees[tag + "-" + i] = { path: "/nowhere", port, task: null, mode: "github", createdAt: "t" };
      });
    }`;
  const args = (tag: string) => ["--input-type=module", "-e", code, fx.main, tag];
  const [a, b] = await Promise.all([
    runWt(process.execPath, args("a"), { cwd: fx.main }),
    runWt(process.execPath, args("b"), { cwd: fx.main }),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const data = JSON.parse(readFileSync(registryPath(repo), "utf8"));
  const ports = Object.values(data.worktrees).map((w) => (w as { port: number }).port);
  assert.equal(ports.length, 10);
  assert.equal(new Set(ports).size, 10);
  assert.equal(data.version, 1);
  withRegistry(repo, (r) => {
    r.worktrees = {};
  });
});

test("stale lock is replaced", () => {
  mkdirSync(dirname(lockPath(repo)), { recursive: true });
  writeFileSync(lockPath(repo), `${deadPid()}\n`);
  const result = withRegistry(repo, (r) => Object.keys(r.worktrees).length);
  assert.equal(result, 0);
});

test("a failing callback writes nothing and releases the lock", () => {
  assert.throws(
    () =>
      withRegistry(repo, (r) => {
        r.worktrees.x = entry(portRange().min);
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(
    withRegistry(repo, (r) => Object.keys(r.worktrees).length),
    0,
  );
});

test("withRegistry is not re-entrant", () => {
  assert.throws(() => withRegistry(repo, () => withRegistry(repo, () => 1)), /re-entrant/);
  assert.equal(
    withRegistry(repo, () => 1),
    1,
  );
});

test("a corrupt registry is refused and left alone", () => {
  writeFileSync(registryPath(repo), "{not json");
  assert.throws(
    () => withRegistry(repo, () => 1),
    (e) => e instanceof WtError && e.code === 1,
  );
  assert.equal(readFileSync(registryPath(repo), "utf8"), "{not json");
  writeFileSync(registryPath(repo), JSON.stringify({ version: 1, worktrees: {}, reservations: {} }));
});

test("allocatePort takes the lowest port neither registered nor busy", () => {
  const { min, max } = portRange();
  const r = { version: 1 as const, worktrees: { a: entry(min), b: entry(min + 2) }, reservations: {} };
  assert.equal(allocatePort(r, new Set()), min + 1);
  assert.equal(allocatePort(r, new Set([min + 1, min + 3])), min + 4);
  const full = { version: 1 as const, worktrees: {} as Record<string, ReturnType<typeof entry>>, reservations: {} };
  for (let p = min; p <= max; p++) full.worktrees[`b${p}`] = entry(p);
  assert.throws(
    () => allocatePort(full, new Set()),
    (e) => e instanceof WtError && e.code === 69,
  );
});

test("the real range is 3637 to 3656 once the test seam is cleared", () => {
  setPortRangeForTests(null);
  try {
    assert.deepEqual(portRange(), { min: PORT_MIN, max: PORT_MAX });
    assert.equal(allocatePort({ version: 1, worktrees: {}, reservations: {} }, new Set([3637])), 3638);
  } finally {
    setPortRangeForTests(testPortRange());
  }
});

test("busyPorts finds a listener in the test range", async () => {
  const { min } = portRange();
  const server = await listenOn(min + 5); // the range is this process's own, so a bind failure is a real failure
  try {
    const busy = await busyPorts();
    assert.ok(busy.has(min + 5));
    assert.equal(busy.has(min + 6), false);
  } finally {
    await server.close();
  }
});
