import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { LIMITS, PublishResponse } from "@emend/contract";
import { blockHash } from "@emend/core";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import type { Db } from "../../db/client.ts";
import { changedBlocks, revisions, threads } from "../../db/schema.ts";
import { testDb } from "../../db/test-support.ts";
import { BlobStore } from "../../store/blobs.ts";
import { createApp } from "../app.ts";
import { createToken } from "../auth/tokens.ts";
import { workerExecutor } from "./executor.ts";

vi.mock("node:worker_threads", async (original) => {
  const module = await original<typeof import("node:worker_threads")>();
  return {
    ...module,
    Worker: class extends module.Worker {
      constructor(...args: ConstructorParameters<typeof module.Worker>) {
        super(args[1]?.eval ? args[0] : new URL("./commit-worker.fixture.ts", import.meta.url), args[1]);
      }
    },
  };
});

test("publishing at the block cap over a cap-sized previous revision keeps bearer GET and HEAD below 200 ms in every phase", async () => {
  const f = await testDb();
  const execute = workerExecutor();
  const loop = monitorEventLoopDelay({ resolution: 1 });
  let monitoring = false;
  let phase = "idle";
  let monitor: Promise<void> | undefined;
  const preparations: Promise<void>[] = [];
  const samples: { phase: string; get: number; head: number }[] = [];
  try {
    const store = new BlobStore(f.db, join(f.dir, "state"));
    const hash = await store.put(f.ownerId, Buffer.from("first"), "text/markdown");
    const nextHash = await store.put(f.ownerId, Buffer.from("second"), "text/markdown");
    const token = (await createToken(f.db, f.ownerId, "agent", { instanceId: f.instanceId })).secret;
    const origin = "http://127.0.0.1:3636";
    const headers = { Host: "127.0.0.1:3636", Authorization: `Bearer ${token}` };
    const probe = async (label: string, start = performance.now()) => {
      const [get, head] = await Promise.all([
        Promise.resolve(app.request(`${origin}/api/v1/capabilities`, { headers })).then((r) => {
          expect(r.status).toBe(200);
          return performance.now() - start;
        }),
        Promise.resolve(app.request(`${origin}/api/v1/blobs/${hash}`, { method: "HEAD", headers })).then((r) => {
          expect(r.status).toBe(204);
          return performance.now() - start;
        }),
      ]);
      samples.push({ phase: label, get, head });
    };
    const during = async <T>(label: string, run: () => Promise<T>) => {
      if (!monitoring) return run();
      phase = label;
      const pending = probe(label);
      try {
        return await run();
      } finally {
        await pending;
        phase = "prepare";
        preparations.push(probe("prepare"));
      }
    };
    const db: Db = {
      ...f.db,
      query: (callback) => during("snapshot", () => f.db.query(callback)),
      transaction: (callback, options) => during("commit", () => f.db.transaction(callback, options)),
    };
    for (const method of ["get", "put"] as const) {
      // Store probes include main-thread byte hashing and persistence between worker phases.
      if (method === "get") {
        const get = store.get.bind(store);
        vi.spyOn(store, "get").mockImplementation((...args) => during("blob-read", () => get(...args)));
      } else {
        const put = store.put.bind(store);
        vi.spyOn(store, "put").mockImplementation((...args) => during("blob-store", () => put(...args)));
      }
    }
    const app = createApp({
      db,
      blobs: store,
      instance: { id: f.instanceId, name: "Synthetic" },
      now: Date.now,
      publishExecutor: (work) => during(work.kind, () => execute(work)),
      config: {
        baseUrl: origin,
        allowedHosts: ["127.0.0.1:3636"],
        appOrigins: [origin],
        secureCookieHost: undefined,
        webRoot: f.dir,
        serverKey: "A".repeat(43),
      },
    });
    const publish = (second: boolean) =>
      app.request(`${origin}/api/v1/publish`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewKey: "a".repeat(64),
          repo: null,
          branch: null,
          title: "Synthetic",
          base: null,
          head: null,
          topics: [],
          files: [
            ...["a.md", "b.md"].map((path) => ({
              path,
              role: "doc",
              oldPath: null,
              oldBlob: null,
              newBlob: second ? nextHash : hash,
              flag: null,
            })),
            ...Array.from({ length: 200 }, (_, i) => ({
              path: `${i}.bin`,
              role: "diff",
              oldPath: null,
              oldBlob: null,
              newBlob: null,
              flag: "binary",
            })),
          ],
          writeup: { overview: second ? "second" : "first", tldr: "", decisions: null, topics: {} },
        }),
      });
    expect((await publish(false)).status).toBe(200);
    const previous = await f.db.query((q) => q.select().from(revisions).where(eq(revisions.ownerId, f.ownerId)).get());
    if (!previous) throw new Error("missing revision");
    const docSection = `doc-${await blockHash("a.md")}`;
    await f.db.query((q) =>
      q.insert(threads).values([
        {
          ownerId: f.ownerId,
          reviewId: previous.reviewId,
          createdRevisionId: previous.id,
          target: { kind: "writeup-span", blockId: "overview-00000000", quote: "needle", prefix: "", suffix: "" },
        },
        {
          ownerId: f.ownerId,
          reviewId: previous.reviewId,
          createdRevisionId: previous.id,
          target: {
            kind: "doc-span",
            path: "a.md",
            blockId: `${docSection}-00000000`,
            quote: "needle",
            prefix: "",
            suffix: "",
          },
        },
      ]),
    );
    monitoring = true;
    loop.enable();
    monitor = (async () => {
      while (monitoring) {
        const start = performance.now();
        const label = phase;
        await setTimeout(5);
        await probe(label, start); // Include timer delay: catches stalls between explicit probes.
      }
    })();
    const response = await publish(true);
    // Sample the final commit turn too, before disabling the delay histogram.
    await setTimeout(2);
    loop.disable();
    monitoring = false;
    await monitor;
    await Promise.all(preparations);
    const worst: Record<string, number> = {};
    for (const sample of samples) worst[sample.phase] = Math.max(worst[sample.phase] ?? 0, sample.get, sample.head);
    const margin = JSON.stringify({ worstMs: worst, eventLoopMaxMs: loop.max / 1e6 });
    process.stdout.write(`publish responsiveness: ${margin}\n`);
    if (process.env.EMEND_TIMING_STRICT === "1") expect(loop.max / 1e6, margin).toBeLessThan(50);
    expect(response.status).toBe(200);
    expect(PublishResponse.parse(await response.json()).unrendered).toEqual([]);
    const changed = await f.db.query((q) =>
      q.select({ revision: changedBlocks.revisionId }).from(changedBlocks).where(eq(changedBlocks.ownerId, f.ownerId)),
    );
    const counts = new Map<string, number>();
    for (const row of changed) counts.set(row.revision, (counts.get(row.revision) ?? 0) + 1);
    expect([...counts.values()]).toEqual([LIMITS.blocksPerRevision, LIMITS.blocksPerRevision]);
    for (const phase of [
      "snapshot",
      "writeup",
      "doc",
      "resection",
      "blob-read",
      "blob-store",
      "place",
      "changed",
      "prepare",
      "commit",
    ])
      expect(
        samples.some((sample) => sample.phase === phase),
        phase,
      ).toBe(true);
    for (const sample of samples) {
      expect(sample.get, `${sample.phase} GET; ${margin}`).toBeLessThan(200);
      expect(sample.head, `${sample.phase} HEAD; ${margin}`).toBeLessThan(200);
    }
  } finally {
    loop.disable();
    monitoring = false;
    await monitor;
    await execute.close();
    await f.cleanup();
  }
}, 20000);
