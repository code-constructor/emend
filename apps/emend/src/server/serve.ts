import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ERROR_STATUS, type ErrorCode } from "@emend/contract";
import { getRequestListener } from "@hono/node-server";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { instances, owners, tokens } from "../db/schema.ts";
import { ensureStateDir, writeSecretFile } from "../state/files.ts";
import { loadOrCreateInstance } from "../state/instance.ts";
import { readTokenFile } from "../state/token-file.ts";
import { BlobStore } from "../store/blobs.ts";
import { type AppDeps, createApp } from "./app.ts";
import { BEARER_SHAPE, liveToken, rotateLocalToken } from "./auth/tokens.ts";
import { errorBody } from "./http/errors.ts";
import { headersForPath } from "./http/headers.ts";

export async function initializeServerState(stateDir: string) {
  ensureStateDir(stateDir);
  const db = openDb(join(stateDir, "emend.db"));
  try {
    await migrate(db);
    const instance = await loadOrCreateInstance(stateDir);
    const replacements = await db.transaction(async (q) => {
      await q
        .insert(instances)
        .values({ ...instance, isSelf: true })
        .onConflictDoUpdate({ target: instances.id, set: { name: instance.name, isSelf: true } });
      // Bootstrap has no principal yet; the local server has one owner.
      const owner = (await q.select().from(owners).get()) ?? (await q.insert(owners).values({}).returning().get());
      if (!owner) throw new Error("Could not initialize server state.");
      const ownerId = owner.id;
      const now = Date.now();
      const earlierSelf = and(eq(instances.isSelf, true), ne(instances.id, instance.id));
      // Retire all earlier local identities; attached instances retain their credentials.
      await q
        .update(tokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(tokens.ownerId, ownerId),
            inArray(tokens.kind, ["admin", "agent"]),
            inArray(tokens.instanceId, q.select({ id: instances.id }).from(instances).where(earlierSelf)),
            isNull(tokens.revokedAt),
          ),
        );
      await q.update(instances).set({ isSelf: false }).where(earlierSelf);
      // Adopt local admin credentials created before admin tokens carried an instance id.
      await q
        .update(tokens)
        .set({ instanceId: instance.id })
        .where(and(eq(tokens.ownerId, ownerId), eq(tokens.kind, "admin"), isNull(tokens.instanceId)));
      const files: { path: string; secret: string }[] = [];
      for (const kind of ["admin", "agent"] as const) {
        const path = join(stateDir, `${kind}.token`);
        const secret = await readTokenFile(path, true);
        const token = secret && BEARER_SHAPE.test(secret) ? await liveToken(q, secret, now) : null;
        if (!token || token.ownerId !== ownerId || token.kind !== kind || token.instanceId !== instance.id) {
          const replacement = await rotateLocalToken(q, ownerId, kind, instance.id, now);
          files.push({ path, secret: replacement.secret });
        }
      }
      return files;
    });
    for (const { path, secret } of replacements) writeSecretFile(path, secret, stateDir);
    return { db, instance, blobs: new BlobStore(db, stateDir) };
  } catch (error) {
    await db.close();
    throw error;
  }
}
const urlHost = (host: string) => (host.includes(":") ? `[${host}]` : host);
function localUrl(address: string, port: number) {
  if (!isIP(address)) throw new Error("Invalid bound address.");
  const host = address === "0.0.0.0" ? "127.0.0.1" : address === "::" ? "::1" : address;
  return `http://${urlHost(host)}:${port}`;
}
function publicBaseUrl(publicOrigin?: string) {
  if (!publicOrigin) return undefined;
  const parsed = new URL(publicOrigin);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw new Error("Invalid public origin.");
  return parsed.origin;
}
export function serverConfig(
  address: string,
  port: number,
  webRoot: string,
  publicOrigin?: string,
  serverKey = randomBytes(32).toString("base64url"),
): AppDeps["config"] {
  const url = localUrl(address, port);
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${port}`);
  allowedHosts.push(new URL(url).host);
  const uniqueHosts = [...new Set(allowedHosts)];
  const publicUrl = publicBaseUrl(publicOrigin);
  const baseUrl = publicUrl ?? url;
  return {
    allowedHosts: uniqueHosts,
    appOrigins: [...new Set([...uniqueHosts.map((name) => `http://${name}`), ...(publicUrl ? [publicUrl] : [])])],
    baseUrl,
    secureCookies: baseUrl.startsWith("https:"),
    webRoot,
    serverKey,
  };
}
export interface ServerOptions {
  stateDir: string;
  host?: string;
  port?: number;
  publicOrigin?: string;
  webRoot?: string;
}
interface DiscoveryIdentity {
  pid: number;
  startedAt: string;
  key: string;
}
export async function startServer(opts: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3636;
  const webRoot = opts.webRoot ?? fileURLToPath(new URL("./web/", import.meta.url));
  publicBaseUrl(opts.publicOrigin);
  const state = await initializeServerState(opts.stateDir);
  const key = randomBytes(32).toString("base64url");
  const server = createServer({ requireHostHeader: false });
  try {
    const bound = await new Promise<{ url: string; port: number }>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port }, () => {
        try {
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Invalid bound address.");
          const config = serverConfig(address.address, address.port, webRoot, opts.publicOrigin, key);
          const app = createApp({ ...state, now: Date.now, config });
          server.on("request", nodeRequestHandler(app, config));
          resolve({ url: localUrl(address.address, address.port), port: address.port });
        } catch (error) {
          reject(error);
        }
      });
    });
    const discovery = join(opts.stateDir, "server.json");
    const record = { ...bound, pid: process.pid, startedAt: new Date().toISOString(), key };
    writeSecretFile(discovery, JSON.stringify(record), opts.stateDir);
    let closing: Promise<void> | undefined;
    return {
      url: bound.url,
      close() {
        closing ??= (async () => {
          try {
            await stopServer(server);
          } finally {
            await state.db.close();
            await removeDiscovery(discovery, record);
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await stopServer(server);
    await state.db.close();
    throw error;
  }
}
async function stopServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
export async function removeDiscovery(path: string, identity: DiscoveryIdentity) {
  try {
    const record: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      record &&
      typeof record === "object" &&
      "pid" in record &&
      record.pid === identity.pid &&
      "startedAt" in record &&
      record.startedAt === identity.startedAt &&
      "key" in record &&
      record.key === identity.key
    )
      await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}
function adapterError(path: string, code: ErrorCode) {
  return new Response(JSON.stringify(errorBody(code)), {
    status: ERROR_STATUS[code],
    headers: {
      ...headersForPath(path),
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}
export function nodeRequestHandler(
  app: Pick<ReturnType<typeof createApp>, "fetch">,
  config: Pick<AppDeps["config"], "allowedHosts">,
) {
  return async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const path = incoming.url?.split(/[?#]/, 1)[0] ?? "/";
    const refuse = async (code: ErrorCode) => {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      const response = adapterError(path, code);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(incoming.method === "HEAD" ? undefined : await response.text());
    };
    if (!incoming.headers.host || !config.allowedHosts.includes(incoming.headers.host.toLowerCase())) {
      await refuse("bad_host");
      return;
    }
    const adapter = getRequestListener((request) => app.fetch(request), {
      overrideGlobalObjects: false,
      errorHandler: () => adapterError(path, "invalid_request"),
    });
    try {
      await adapter(incoming, outgoing);
    } catch {
      await refuse("invalid_request");
    }
  };
}
