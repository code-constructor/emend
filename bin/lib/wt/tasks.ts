import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandTable } from "./command.ts";
import { type Registry, withRegistry } from "./registry.ts";
import { gitTry, listGitWorktrees, type Repo } from "./repo.ts";
import { branchName, slug as checkSlug, parseFlags, taskNumber, WtError } from "./validate.ts";

const MAX_TASK_BYTES = 65_536;
const TASK_FILE_RE = /^(\d{3})-[A-Za-z0-9._-]+\.md$/;
const TREE_LINE_RE = /^100(?:644|755) blob ([0-9a-f]{40})\ttasks\/((\d{3})-[A-Za-z0-9._-]+\.md)$/;

export interface TaskRow {
  number: string;
  title: string;
  owner: string;
  status: string;
  dependsOn: string[];
  /** The source that is furthest along: a branch name, "main" or "origin/main". */
  where: string;
  /** The file name inside tasks/. */
  file: string;
  /** True for a second or later file whose number an earlier file in the same source already has. */
  duplicate: boolean;
  /** Sources that still show an older version origin/main has since replaced. Set only when there are some. */
  stale?: string[];
}

interface Candidate {
  number: string;
  /** 1 origin/main, 2 a local branch, 3 the working tree of a checkout. */
  rank: 1 | 2 | 3;
  where: string;
  file: string;
  text: string;
  /** The git blob id of the file: known for a ref, computed from `raw` for a working-tree file. */
  oid?: string;
  /** The file's exact bytes as text (working-tree files only), for hashing. */
  raw?: string;
}

function tidyName(s: string | null): string {
  return (s ?? "detached").replace(/[^\x21-\x7e]/g, "?").slice(0, 60);
}

/** Task text comes from reviewed branches. Strip control characters and cap the length before it is shown. */
function clean(s: string, max: number): string {
  return s
    .replace(/\p{Cc}/gu, " ")
    .trim()
    .slice(0, max);
}

function frontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  const out: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "---") break;
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out[m[1] as string] = (m[2] as string).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function rowFrom(c: Candidate): TaskRow {
  const fm = frontmatter(c.text);
  return {
    number: c.number,
    title: clean(fm.title ?? "", 120),
    owner: clean(fm.owner ?? "", 40),
    status: clean(fm.status ?? "", 20),
    dependsOn: [...clean(fm.depends_on ?? "", 80).matchAll(/\d{3}/g)].map((m) => m[0]),
    where: clean(c.where, 80),
    file: c.file,
    duplicate: false,
  };
}

/** Reads a regular file (not a symlink) up to the size cap. Null when it is anything else or unreadable. */
function readTaskFile(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_TASK_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Every task file the repository knows about, one row per number. Sources: origin/main, every local branch,
 * and the working tree of every checkout (the main checkout and untracked files included). The furthest
 * source wins: a working tree over a local branch over origin/main. A source whose text equals origin/main's
 * is no further along and does not win. Reads local state only; it never fetches.
 */
export function scanTasks(repo: Repo): TaskRow[] {
  const cands: Candidate[] = [];
  const blobs = new Map<string, string | null>();

  const fromRef = (ref: string, where: string, rank: 1 | 2): void => {
    const ls = gitTry(repo, ["ls-tree", ref, "tasks/"]);
    if (ls.code !== 0) return;
    for (const line of ls.stdout.split("\n")) {
      const m = TREE_LINE_RE.exec(line);
      if (!m) continue;
      const oid = m[1] as string;
      if (!blobs.has(oid)) {
        const blob = gitTry(repo, ["cat-file", "blob", oid]);
        blobs.set(oid, blob.code === 0 ? blob.stdout.slice(0, MAX_TASK_BYTES) : null);
      }
      const text = blobs.get(oid);
      if (text != null) cands.push({ number: m[3] as string, rank, where, file: m[2] as string, text, oid });
    }
  };

  fromRef("refs/remotes/origin/main", "origin/main", 1);

  const heads = gitTry(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  if (heads.code === 0) {
    for (const ref of heads.stdout.split("\n")) {
      if (ref.startsWith("refs/heads/")) fromRef(ref, ref.slice("refs/heads/".length), 2);
    }
  }

  let checkouts: ReturnType<typeof listGitWorktrees> = [];
  try {
    checkouts = listGitWorktrees(repo);
  } catch {
    // no worktree list: the other sources still count
  }
  for (const w of checkouts) {
    if (w.bare) continue;
    // The tasks directory of a working tree is agent-written: a symlink there would read files elsewhere.
    let dir: string;
    let names: string[];
    try {
      dir = join(realpathSync(w.path), "tasks");
      if (realpathSync(join(w.path, "tasks")) !== dir) {
        process.stderr.write(`Skipped a tasks directory that is, or lies behind, a symlink (${tidyName(w.branch)}).\n`);
        continue;
      }
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const m = TASK_FILE_RE.exec(name);
      if (!m) continue;
      const text = readTaskFile(join(dir, name));
      // git output has its final newline stripped; strip it here too so equal files compare equal
      if (text !== null) {
        cands.push({
          number: m[1] as string,
          rank: 3,
          where: w.branch ?? "(detached)",
          file: name,
          text: text.replace(/\n$/, ""),
          raw: text,
        });
      }
    }
  }

  const byNumber = new Map<string, Candidate[]>();
  for (const c of cands) {
    const list = byNumber.get(c.number);
    if (list) list.push(c);
    else byNumber.set(c.number, [c]);
  }
  // Blob ids that origin/main has ever held for a path (read-only `git log --raw`), by file name.
  const history = new Map<string, Set<string>>();
  const historyOf = (file: string): Set<string> => {
    let set = history.get(file);
    if (!set) {
      set = new Set();
      const log = gitTry(repo, [
        "log",
        "--format=",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "refs/remotes/origin/main",
        "--",
        `tasks/${file}`,
      ]);
      if (log.code === 0) {
        for (const line of log.stdout.split("\n")) {
          const m = /^:\d+ \d+ ([0-9a-f]{40}) ([0-9a-f]{40}) /.exec(line);
          if (m) set.add(m[2] as string);
        }
      }
      history.set(file, set);
    }
    return set;
  };
  const blobId = (c: Candidate): string | null => {
    if (c.oid) return c.oid;
    if (c.raw === undefined) return null;
    const h = gitTry(repo, ["hash-object", "--stdin"], { input: c.raw });
    return h.code === 0 && /^[0-9a-f]{40}$/.test(h.stdout) ? h.stdout : null;
  };

  const rows: TaskRow[] = [];
  for (const [, pool] of byNumber) {
    const origin = pool.find((c) => c.rank === 1);
    // A version that origin/main once held for the same path, and no longer holds, is stale: it never wins.
    const stale = new Set<Candidate>();
    if (origin) {
      for (const c of pool) {
        if (c.rank === 1 || c.text === origin.text) continue;
        const id = blobId(c);
        if (id !== null && historyOf(c.file).has(id)) stale.add(c);
      }
    }
    const ahead = pool
      .filter((c) => c.rank > 1 && (!origin || c.text !== origin.text) && !stale.has(c))
      .sort((a, b) => b.rank - a.rank || a.where.localeCompare(b.where));
    const winner = ahead[0] ?? origin ?? (pool[0] as Candidate);
    // Two files with one number in the winning source: one row each, the later ones marked.
    const same = pool.filter((c) => c.rank === winner.rank && c.where === winner.where);
    same.sort((a, b) => a.file.localeCompare(b.file));
    const staleWhere = [...new Set([...stale].map((c) => clean(c.where, 80)))].sort();
    for (const [i, c] of same.entries()) {
      const row = rowFrom(c);
      row.duplicate = i > 0;
      if (i === 0 && staleWhere.length > 0) {
        row.stale = staleWhere;
        row.where = `${row.where}, ${staleWhere.map((w) => `${w} (stale)`).join(", ")}`;
      }
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.number.localeCompare(b.number) || Number(a.duplicate) - Number(b.duplicate));
}

/** 1 + the highest number among the scanned rows and the reservations, zero-padded. Exit 69 at the end of the range. */
export function nextTaskNumber(repo: Repo, r: Registry): string {
  let max = 0;
  for (const row of scanTasks(repo)) max = Math.max(max, Number(row.number));
  for (const key of Object.keys(r.reservations)) {
    if (/^\d{3}$/.test(key)) max = Math.max(max, Number(key));
  }
  const next = max + 1;
  if (next >= 99) {
    throw new WtError(69, "The task range is used up; the owner decides how to continue. Nothing was created.");
  }
  return String(next).padStart(3, "0");
}

/**
 * Takes the next free task number under the registry lock and records the reservation. `branch` is the
 * branch to record, or a function of the reserved number (called inside the lock) for a branch named after it.
 */
export function reserveTask(repo: Repo, slugValue: string, branch: string | ((number: string) => string)): string {
  const s = checkSlug(slugValue);
  const fixed = typeof branch === "string" ? branchName(branch) : null;
  return withRegistry(repo, (r) => {
    const number = nextTaskNumber(repo, r);
    const b = fixed ?? branchName(branch instanceof Function ? branch(number) : "");
    r.reservations[number] = { branch: b, slug: s, reservedAt: new Date().toISOString() };
    return number;
  });
}

/** Drops a reservation. A number that is not reserved is not an error. */
export function releaseReservation(repo: Repo, number: string): void {
  const n = taskNumber(number);
  withRegistry(repo, (r) => {
    delete r.reservations[n];
  });
}

export function formatTasks(rows: TaskRow[]): string {
  if (rows.length === 0) return "No tasks.";
  const head = ["#", "STATUS", "OWNER", "TITLE", "WHERE"];
  const body = rows.map((r) => [
    r.number,
    r.status || "-",
    r.owner || "-",
    r.title || "-",
    r.duplicate ? `${r.where} (duplicate)` : r.where,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [fmt(head), ...body.map(fmt)].join("\n");
}

const tasksCommand: Command = ({ repo, args }) => {
  const { flags } = parseFlags(args, { json: "boolean" });
  const rows = scanTasks(repo);
  process.stdout.write(`${flags.json ? JSON.stringify(rows, null, 2) : formatTasks(rows)}\n`);
  return 0;
};

export const commands: CommandTable = { tasks: tasksCommand };
