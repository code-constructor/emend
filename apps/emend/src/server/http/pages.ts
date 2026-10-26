import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "hono";
import { ApiError } from "./errors.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};
async function regularFile(root: string, path: string) {
  try {
    const real = await realpath(path);
    const suffix = relative(root, real);
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return null;
    const file = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) return null;
      return {
        bytes: new Uint8Array(await file.readFile()),
        type: TYPES[extname(real).toLowerCase()] ?? "application/octet-stream",
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
export async function appPage(c: Context, webRoot: string) {
  let path: string;
  try {
    path = decodeURIComponent(c.req.path);
  } catch {
    throw new ApiError("not_found");
  }
  if (
    path.includes("\\") ||
    Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    path.split("/").includes("..")
  )
    throw new ApiError("not_found");
  let root: string;
  try {
    root = await realpath(webRoot);
  } catch {
    throw new ApiError("not_found");
  }
  const index = await regularFile(root, resolve(root, "index.html"));
  if (!index) throw new ApiError("not_found");
  let file = path === "/" ? index : await regularFile(root, resolve(root, `.${path}`));
  if (!file && !extname(path.split("/").at(-1) ?? "")) file = index;
  if (!file) throw new ApiError("not_found");
  c.header("Content-Type", file.type);
  return c.body(file.bytes);
}
