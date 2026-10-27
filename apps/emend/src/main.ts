import type { SkillsOptions } from "./cli/commands/skills.ts";
import type { ServiceOptions } from "./cli/service/common.ts";
import { defaultStateDir } from "./state/paths.ts";
import { VERSION } from "./version.ts";

export interface Io {
  stdout: (s: string) => void;
  stdoutAsync?: (s: string) => Promise<void>;
  stdin?: AsyncIterable<Uint8Array | string>;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  openUrl?: (url: string) => Promise<boolean>;
  service?: ServiceOptions;
  skills?: SkillsOptions;
}
export async function run(argv: string[], io: Io): Promise<number> {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0] ?? "")) {
    io.stdout(`Usage:
  emend                         Open the review inbox
  emend serve                   Run the local server
  emend publish --manifest <file> [--review <id>] [--key <name>]
  emend wait <review> [--timeout <seconds>]
  emend feedback <review>
  emend reply <comment> --status <outcome> (--body <text> | --body-file <path | ->)
  emend mcp
  emend service install [serve options] | uninstall | status
  emend skills install [--dir <path>] [--dry-run]
  emend --version
`);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    io.stdout(`emend ${VERSION}\n`);
    return 0;
  }
  if (["wait", "feedback", "reply", "mcp", "service", "skills"].includes(argv[0] ?? "")) {
    const { CliUsageError, errorLine } = await import("./cli/http.ts");
    try {
      const commands = {
        wait: () => import("./cli/commands/wait.ts").then((m) => m.waitCommand),
        feedback: () => import("./cli/commands/feedback.ts").then((m) => m.feedbackCommand),
        reply: () => import("./cli/commands/reply.ts").then((m) => m.replyCommand),
        mcp: () => import("./cli/commands/mcp.ts").then((m) => m.mcpCommand),
        service: () => import("./cli/commands/service.ts").then((m) => m.serviceCommand),
        skills: () => import("./cli/commands/skills.ts").then((m) => m.skillsCommand),
      };
      const command = await commands[argv[0] as keyof typeof commands]();
      await command(defaultStateDir(io.env), argv.slice(1), io);
      return 0;
    } catch (error) {
      io.stderr(errorLine(error));
      return error instanceof CliUsageError ? 2 : 1;
    }
  }
  if (argv[0] === "publish") {
    const { publishCommand } = await import("./cli/commands/publish.ts");
    const { CliError, CliApiError } = await import("./cli/http.ts");
    try {
      await publishCommand(defaultStateDir(io.env), argv.slice(1), io);
      return 0;
    } catch (error) {
      io.stderr(
        `emend: ${error instanceof CliApiError ? error.code : error instanceof CliError ? error.message : "Could not publish the review."}\n`,
      );
      return 1;
    }
  }
  if (argv.length && argv[0] !== "serve") {
    const command = /^[a-z][a-z0-9-]{0,40}$/i.test(argv[0] ?? "") ? argv[0] : "(invalid)";
    io.stderr(`emend: unknown command ${command}\n`);
    return 2;
  }
  // Keep the version path independent of database and server startup.
  const { parseServeArgs, serveCommand, UsageError } = await import("./cli/commands/serve.ts");
  const { CliError } = await import("./cli/http.ts");
  try {
    if (argv[0] === "serve") {
      const options = parseServeArgs(argv.slice(1));
      await serveCommand(defaultStateDir(io.env), options, io);
    } else {
      const { openCommand } = await import("./cli/commands/open.ts");
      await openCommand(defaultStateDir(io.env), io);
    }
    return 0;
  } catch (error) {
    io.stderr(
      `emend: ${error instanceof UsageError || error instanceof CliError ? error.message : "Could not start the emend server."}\n`,
    );
    return error instanceof UsageError ? 2 : 1;
  }
}
