import { createHmac } from "node:crypto";
import { join } from "node:path";
import { writeSecretFile } from "../state/files.ts";

export function provenTestServer(stateDir: string): (url: string | URL, init?: RequestInit) => Response | undefined {
  const key = Buffer.alloc(32, 3).toString("base64url");
  writeSecretFile(
    join(stateDir, "server.json"),
    JSON.stringify({ url: "http://127.0.0.1:3636", pid: process.pid, key }),
  );
  return (url: string | URL, init?: RequestInit) => {
    if (!String(url).endsWith("/api/v1/capabilities")) return undefined;
    const challenge = new Headers(init?.headers).get("X-Emend-Challenge") ?? "";
    return Response.json(
      { api: 1, version: "0.1.0", features: [] },
      {
        headers: {
          "X-Emend-Proof": createHmac("sha256", Buffer.from(key, "base64url")).update(challenge).digest("base64url"),
        },
      },
    );
  };
}
