import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { CliError } from "./http.ts";

/** Ignore empty and relative PATH entries: the working directory may be a hostile repository. */
export async function findExecutable(name: string, searchPath = process.env.PATH ?? "") {
  const entries = searchPath.split(delimiter).filter(isAbsolute);
  for (const entry of entries) {
    const file = join(entry, name);
    try {
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
      return { file, path: entries.join(delimiter) };
    } catch {
      /* Try the next absolute PATH entry. */
    }
  }
  throw new CliError(`${name} was not found on PATH`);
}
