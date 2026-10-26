import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the CLI prints its version when invoked through a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emend-cli-test-"));
  try {
    const entry = join(directory, "cli.ts");
    await symlink(fileURLToPath(new URL("./cli.ts", import.meta.url)), entry);
    const stdout = execFileSync(process.execPath, [entry, "--version"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(stdout).toBe("emend 0.1.0\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
