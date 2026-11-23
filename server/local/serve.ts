// Local server: serves client/dist + /blobs/* and dispatches POST /actions
// to server/src/actions.ts with the local Ctx. Run: `node server/local/serve.ts`
//
// Auth: every action except the four auth actions requires a session
// cookie (see server/shared/auth.ts); /blobs/* likewise.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Actions } from "../src/actions.ts";
import { authenticate } from "../shared/auth.ts";
import { handleWebhook } from "../shared/billing.ts";
import { APP_ROOT, createCtx, readBlob } from "./ctx.ts";
import { localPlatform } from "./platform.ts";

const platform = localPlatform();

try {
  process.loadEnvFile(path.join(APP_ROOT, ".env"));
} catch {
  // No .env yet — actions fail with a clear message when keys are needed.
}

const DIST = path.join(APP_ROOT, "client", "dist");
const OPEN_ACTIONS = new Set([
  "requestSignInCode",
  "verifySignInCode",
  "currentUser",
  "logout",
]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 25 * 1024 * 1024) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function errMessage(err: unknown): string {
  const z = err as { name?: unknown; issues?: { message?: unknown }[] };
  if (z?.name === "ZodError") {
    const m = z.issues?.[0]?.message;
    return typeof m === "string" && m ? m : "Invalid request.";
  }
  return err instanceof Error ? err.message : String(err);
}

function errStatus(err: unknown): number {
  if ((err as { name?: unknown })?.name === "ZodError") return 400;
  const s = (err as { status?: unknown })?.status;
  if (typeof s === "number" && s >= 400 && s < 600) return s;
  const message = err instanceof Error ? err.message : String(err);
  if (/not set|can't be scanned|no longer exists|Unknown action|valid email|six-digit/i.test(message)) return 400;
  if (/Sign in required|invalid or expired|already been used/i.test(message)) return 401;
  return 500;
}

async function handleActions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, JSON.stringify({ error: "Invalid JSON body." }), MIME[".json"]!);
    return;
  }
  const { action, args } = (payload ?? {}) as { action?: string; args?: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyAction = { request: { parse(v: unknown): any }; response: { parse(v: unknown): unknown }; handler: (ctx: any, args: any) => Promise<unknown> };
  const def = action && (Actions as unknown as Record<string, AnyAction | undefined>)[action];
  if (!def) {
    send(res, 404, JSON.stringify({ error: `Unknown action: ${action ?? "(missing)"}` }), MIME[".json"]!);
    return;
  }
  try {
    const cookie = req.headers.cookie ?? "";
    const user = await authenticate(platform, cookie);
    if (!OPEN_ACTIONS.has(action!) && !user) {
      send(res, 401, JSON.stringify({ error: "Sign in required." }), MIME[".json"]!);
      return;
    }
    const ctx = createCtx(user, {
      ip: req.socket.remoteAddress ?? "local",
      userAgent: String(req.headers["user-agent"] ?? ""),
      cookie,
    });
    const parsedArgs = def.request.parse(args);
    const result = (await def.handler(ctx, parsedArgs)) as Record<string, unknown>;
    const headers: Record<string, string> = {};
    if (result && typeof result["__setCookie"] === "string") {
      headers["set-cookie"] = result["__setCookie"];
    }
    send(res, 200, JSON.stringify(def.response.parse(result)), MIME[".json"]!, headers);
  } catch (err) {
    const status = errStatus(err);
    if (status === 500) console.error("action_failed", err instanceof Error ? (err.stack ?? err.message) : String(err));
    const message = status === 500 ? "Something went wrong. Please try again." : errMessage(err);
    send(res, status, JSON.stringify({ error: message }), MIME[".json"]!);
  }
}

async function serveFile(res: ServerResponse, file: string): Promise<boolean> {
  try {
    const bytes = await fs.readFile(file);
    send(res, 200, bytes, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/billing/webhook") {
      try {
        const raw = await readBody(req);
        const sig = req.headers["stripe-signature"];
        const out = await handleWebhook(platform, raw, Array.isArray(sig) ? (sig[0] ?? "") : (sig ?? ""));
        send(res, 200, JSON.stringify(out), MIME[".json"]!);
      } catch (err) {
        const status = errStatus(err);
    if (status === 500) console.error("action_failed", err instanceof Error ? (err.stack ?? err.message) : String(err));
    const message = status === 500 ? "Something went wrong. Please try again." : errMessage(err);
        send(res, status, JSON.stringify({ error: message }), MIME[".json"]!);
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/actions") {
      await handleActions(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/blobs/")) {
      const platform0 = (await import("./platform.ts")).localPlatform();
    const user = await authenticate(platform0, req.headers.cookie ?? "");
      if (!user) {
        send(res, 401, "Sign in required.", "text/plain");
        return;
      }
      const blob = await readBlob(decodeURIComponent(url.pathname.slice("/blobs/".length)));
      if (!blob) {
        send(res, 404, "Not found.", "text/plain");
        return;
      }
      res.writeHead(200, { "content-type": blob.contentType, "cache-control": "no-store" });
      res.end(blob.bytes);
      return;
    }
    if (req.method === "GET") {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!rel.includes("..")) {
        const file = path.join(DIST, rel || "index.html");
        if (await serveFile(res, file)) return;
      }
      // SPA fallback.
      if (await serveFile(res, path.join(DIST, "index.html"))) return;
      send(res, 404, "Not built yet — run `npm run build:client` first.", "text/plain");
      return;
    }
    send(res, 405, "Method not allowed.", "text/plain");
  } catch (err) {
    send(res, 500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), MIME[".json"]!);
  }
});

const port = Number(process.env["PORT"] ?? 3105);
server.listen(port, "127.0.0.1", () => {
  console.log(`Helmut (local) at http://localhost:${port}`);
});
