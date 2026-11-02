import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the CLI prints its version through a symlink without the caller's NODE_OPTIONS preload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "emend-cli-test-"));
  const previous = process.env.NODE_OPTIONS;
  try {
    const marker = join(directory, "preload-ran");
    const preload = join(directory, "preload.cjs");
    await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    const entry = join(directory, "cli.ts");
    await symlink(fileURLToPath(new URL("./cli.ts", import.meta.url)), entry);
    const stdout = execFileSync(process.execPath, [entry, "--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: directory, EMEND_HOME: join(directory, "state"), LC_ALL: "C" },
    });
    expect(stdout).toBe("emend 0.1.0\n");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
