import { expect, test, vi } from "vitest";
import { WorkTimeout, workerExecutor } from "./executor.ts";

const created = vi.hoisted(() => ({ count: 0, limits: [] as unknown[] }));
vi.mock("node:worker_threads", async (original) => {
  const module = await original<typeof import("node:worker_threads")>();
  return {
    ...module,
    Worker: class extends module.Worker {
      constructor(...args: ConstructorParameters<typeof module.Worker>) {
        super(...args);
        created.count++;
        created.limits.push(args[1]?.resourceLimits);
      }
    },
  };
});

test("real worker reuses jobs with bounded memory and is replaced after failure or timeout", async () => {
  const work = () => ({
    kind: "doc" as const,
    source: new TextEncoder().encode("# Safe\n\n<script>evil()</script>").buffer,
    path: "plan.md",
  });
  const execute = workerExecutor();
  try {
    const before = created.count;
    const rendered = await execute(work());
    await execute(work());
    const hash = "a".repeat(64);
    const placed = await execute({
      kind: "place",
      writeup: null,
      docs: new Map(),
      topics: new Set(),
      texts: new Map([[hash, new TextEncoder().encode("needle\n").buffer]]),
      files: new Map([["file.ts", { newHash: hash }]]),
      threads: [
        {
          id: "synthetic",
          target: {
            kind: "lines",
            path: "file.ts",
            side: "new",
            start: 1,
            end: 1,
            lines: ["needle"],
            before: [],
            after: [],
          },
          last: null,
          renames: [],
        },
      ],
    });
    expect(placed).toMatchObject({ kind: "place", placements: [{ placement: { status: "placed" } }] });
    expect(created.count - before).toBe(1);
    expect(created.limits.at(-1)).toEqual({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 });
    if (!("ids" in rendered)) throw new Error("missing bytes");
    expect(new TextDecoder().decode(rendered.bytes)).not.toContain("evil()");
    expect(new TextDecoder().decode(rendered.bytes)).toContain("Safe");
    const bytes = rendered.bytes;
    const ids = rendered.ids;
    const changed = await execute({ kind: "changed", previous: [{ format: "doc", bytes }], next: [ids] });
    expect(bytes.byteLength).toBe(0);
    expect(ids.byteLength).toBe(0);
    expect(changed).toEqual({ kind: "changed", bytes: new ArrayBuffer(0) });
    await expect(execute({ ...work(), source: null as unknown as ArrayBuffer })).rejects.toThrow();
    await execute(work());
    expect(created.count - before).toBe(2);
  } finally {
    await execute.close();
  }
  const timeouts = { render: 1, place: 1 };
  const slow = workerExecutor(timeouts);
  try {
    await expect(slow(work())).rejects.toBeInstanceOf(WorkTimeout);
    timeouts.render = 10000;
    expect((await slow(work())).kind).toBe("doc");
  } finally {
    await slow.close();
  }
});
