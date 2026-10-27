import { run } from "./main.ts";

// The callback reports failed writes; consume the stream's matching error event too.
if (["wait", "feedback", "reply", "mcp"].includes(process.argv[2] ?? "")) process.stdout.on("error", () => {});
process.exitCode = await run(process.argv.slice(2), {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stdoutAsync: (s) =>
    new Promise<void>((resolve, reject) => {
      // Publish also awaits its write. Its guard exists only for this write; a
      // failed callback is followed by the stream's matching error event.
      const consumeError = () => {};
      process.stdout.once("error", consumeError);
      process.stdout.write(s, (error) => {
        if (error) reject(error);
        else {
          process.stdout.off("error", consumeError);
          resolve();
        }
      });
    }),
  stdin: process.stdin,
  stderr: (s) => {
    process.stderr.write(s);
  },
  env: process.env,
});
