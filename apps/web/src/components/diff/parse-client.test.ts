import { expect, test, vi } from "vitest";
import { createParser } from "./parse-client.ts";

test("parser posts to a worker and terminates on success, cancellation or failure", async () => {
  const workers: Worker[] = [];
  const factory = () => {
    const worker = {
      postMessage: vi.fn(),
      terminate: vi.fn(),
      onmessage: null,
      onerror: null,
      onmessageerror: null,
    } as unknown as Worker;
    workers.push(worker);
    return worker;
  };
  const parse = createParser(factory);
  const pair = { oldFile: null, newFile: { name: "test.txt", contents: "synthetic" } };
  const abort = new AbortController();
  const pending = parse(pair, abort.signal);
  const worker = workers[0];
  expect(worker?.postMessage).toHaveBeenCalledWith(pair);
  worker?.onmessage?.call(worker, { data: { fileDiff: { name: "test.txt" } } } as MessageEvent);
  await expect(pending).resolves.toEqual({ name: "test.txt" });
  expect(worker?.terminate).toHaveBeenCalledTimes(1);
  const cancel = parse(pair, abort.signal);
  const rejected = expect(cancel).rejects.toMatchObject({ name: "AbortError" });
  abort.abort();
  await rejected;
  expect(workers[1]?.terminate).toHaveBeenCalledTimes(1);
  await expect(parse(pair, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(workers).toHaveLength(2);
  const failed = parse(pair, new AbortController().signal);
  const failure = expect(failed).rejects.toThrow("Could not parse this diff.");
  const broken = workers[2];
  broken?.onerror?.call(broken, { preventDefault: vi.fn() } as unknown as ErrorEvent);
  await failure;
  expect(broken?.terminate).toHaveBeenCalledTimes(1);
});
