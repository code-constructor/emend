import assert from "node:assert/strict";
import { test } from "node:test";
import { branchChoices, cleanupPicker, menu, setupWizard } from "./interactive.ts";
import { type Repo, resolveRepo } from "./repo.ts";
import {
  type Fixture,
  fakeCalls,
  gitIn,
  installFake,
  makeFixture,
  makeTestEnv,
  runWt,
  type TestEnv,
} from "./test-support.ts";
import { setup, terminal } from "./worktree.ts";

async function scenario(
  o: { tty?: boolean; withBin?: boolean },
  fn: (ctx: { env: TestEnv; fx: Fixture; repo: Repo }) => void | Promise<void>,
): Promise<void> {
  const env = makeTestEnv();
  const savedTty = terminal.isTTY;
  terminal.isTTY = () => o.tty !== false;
  try {
    const fx = makeFixture(env, { withBin: o.withBin });
    await fn({ env, fx, repo: resolveRepo(fx.main) });
  } finally {
    terminal.isTTY = savedTty;
    env.cleanup();
  }
}

test("wizard: typed name that matches nothing creates", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [
      { stdout: "feat-x\n", code: 1, times: 1 },
      { stdout: "origin/main\n", code: 0, times: 1 },
    ]);
    assert.deepEqual(setupWizard(repo), { branch: "feat-x", from: "origin/main" });
    const calls = fakeCalls(env, "fzf");
    assert.equal(calls.length, 2);
    assert.ok(calls[0]?.includes("--print-query"));
    assert.ok(!calls[1]?.includes("--print-query"));
  }));

test("wizard: pick wins over query", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [{ stdout: "fe\norigin/feat-y\n", code: 0 }]);
    assert.deepEqual(setupWizard(repo), { branch: "feat-y" });
    assert.equal(fakeCalls(env, "fzf").length, 1, "no source prompt");
  }));

test("wizard: cancel, empty query and a cancelled source return null", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [{ code: 130 }]);
    assert.equal(setupWizard(repo), null);
    installFake(env, "fzf", [{ stdout: "\n", code: 1 }]);
    assert.equal(setupWizard(repo), null);
    installFake(env, "fzf", [{ stdout: "feat-x\n", code: 1, times: 1 }, { code: 130 }]);
    assert.equal(setupWizard(repo), null);
  }));

test("wizard offers branches but not main or the caller's branch", () =>
  scenario({}, ({ repo, fx }) => {
    gitIn(fx.main, "branch", "local-one");
    gitIn(fx.main, "push", "--quiet", "origin", "main:refs/heads/remote-only", "main:refs/heads/local-one");
    gitIn(fx.main, "fetch", "--quiet", "origin");
    setup(repo, { branch: "other-w", busy: new Set() });
    assert.deepEqual(branchChoices(repo, false).sort(), ["local-one", "origin/remote-only", "other-w"]);
    const withMain = branchChoices(repo, true);
    assert.ok(withMain.includes("main"));
    assert.ok(!withMain.includes("origin/main"), "an origin branch with a local twin is listed once");
  }));

test("no TTY or no fzf: wizard, picker and menu return null without calling fzf", () =>
  scenario({ tty: false }, ({ env, repo }) => {
    installFake(env, "fzf", [{ stdout: "x\n", code: 0 }]);
    assert.equal(setupWizard(repo), null);
    assert.equal(cleanupPicker(repo), null);
    assert.equal(menu(repo), null);
    assert.equal(fakeCalls(env, "fzf").length, 0);
  }));

test("fzf missing: nothing runs", () =>
  scenario({}, ({ repo }) => {
    assert.equal(setupWizard(repo), null);
    assert.equal(menu(repo), null);
  }));

test("cleanup picker returns the picked registered branch", () =>
  scenario({}, ({ env, repo }) => {
    const w = setup(repo, { branch: "feat-a", busy: new Set() });
    installFake(env, "fzf", [{ stdout: `feat-a\t${w.path}\n`, code: 0 }]);
    assert.equal(cleanupPicker(repo), "feat-a");
    installFake(env, "fzf", [{ stdout: "not-registered\t/x\n", code: 0 }]);
    assert.equal(cleanupPicker(repo), null);
  }));

test("menu returns the picked action", () =>
  scenario({}, ({ env, repo }) => {
    installFake(env, "fzf", [{ stdout: "tasks\tshow the task queue\n", code: 0 }]);
    assert.equal(menu(repo), "tasks");
    installFake(env, "fzf", [{ stdout: "rm -rf\n", code: 0 }]);
    assert.equal(menu(repo), null);
    installFake(env, "fzf", [{ code: 130 }]);
    assert.equal(menu(repo), null);
  }));

test("no TTY: bin/wt without arguments lists and never calls fzf", () =>
  scenario({ withBin: true }, async ({ env, fx }) => {
    installFake(env, "fzf", [{ stdout: "setup\n", code: 0 }]);
    const r = await runWt(`${fx.main}/bin/wt`, [], { cwd: fx.main });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /No worktrees\./);
    assert.equal(fakeCalls(env, "fzf").length, 0);
  }));
