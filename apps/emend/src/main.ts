export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
}

export async function run(argv: string[], io: Io): Promise<number> {
  if (argv[0] === "--version") {
    io.stdout("emend 0.1.0\n");
    return 0;
  }
  io.stderr(`emend: unknown command ${argv[0] ?? "(none)"}\n`);
  return 2;
}
