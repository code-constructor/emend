import { run } from "./main.ts";

// The callback reports failed writes; consume the stream's matching error event too.
if (["wait", "feedback", "reply", "mcp", "serve"].includes(process.argv[2] ?? "")) process.stdout.on("error", () => {});
const serving = process.argv[2] === "serve";
if (serving) process.stderr.on("error", () => {});
process.exitCode = await run(process.argv.slice(2), {
  stdout: (s) => {
    try {
      process.stdout.write(s);
    } catch (error) {
      if (!serving) throw error;
    }
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
    try {
      process.stderr.write(s);
    } catch (error) {
      if (!serving) throw error;
    }
  },
  env: process.env,
});
// A pending stdout write can keep the event loop alive after an interrupted flush.
// Serve has already finished its startup and process-group cleanup before returning.
if (process.exitCode === 129 || process.exitCode === 130 || process.exitCode === 143) process.exit(process.exitCode);
