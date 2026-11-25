// Cloudflare Worker entry: API routes run here, everything else falls
// through to the static client in client/dist (see wrangler.jsonc assets).
import { Actions } from "../src/actions.ts";
import { authenticate } from "../shared/auth.ts";
import { handleWebhook } from "../shared/billing.ts";
import { createWorkerCtx, readWorkerBlob } from "./ctx.ts";
import { workerPlatform, type WorkerEnv } from "./platform.ts";

const OPEN_ACTIONS = new Set(["requestSignInCode", "verifySignInCode", "currentUser", "logout", "liveMeter"]);

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
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

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const platform = workerPlatform(env);

    if (request.method === "POST" && url.pathname === "/billing/webhook") {
      try {
        const raw = await request.text();
        const out = await handleWebhook(platform, raw, request.headers.get("stripe-signature") ?? "");
        return json(out);
      } catch (err) {
        (() => { const status = errStatus(err); if (status === 500) console.error("action_failed", err instanceof Error ? (err.stack ?? err.message) : String(err)); return json({ error: status === 500 ? "Something went wrong. Please try again." : errMessage(err) }, status); })()
      }
    }

    if (request.method === "POST" && url.pathname === "/actions") {
      try {
        const raw = await request.text();
        if (raw.length > 25 * 1024 * 1024) return json({ error: "Request body too large." }, 413);
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return json({ error: "Invalid JSON body." }, 400);
        }
        const { action, args } = (payload ?? {}) as { action?: string; args?: unknown };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type AnyAction = { request: { parse(v: unknown): any }; response: { parse(v: unknown): unknown }; handler: (ctx: any, args: any) => Promise<unknown> };
        const def = action && (Actions as unknown as Record<string, AnyAction | undefined>)[action];
        if (!def) return json({ error: `Unknown action: ${action ?? "(missing)"}` }, 404);

        const cookie = request.headers.get("cookie") ?? "";
        const user = await authenticate(platform, cookie);
        if (!OPEN_ACTIONS.has(action!) && !user) {
          return json({ error: "Sign in required." }, 401);
        }
        const ctx = createWorkerCtx(env, user, {
          ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
          userAgent: request.headers.get("user-agent") ?? "",
          cookie,
        });
        const parsedArgs = def.request.parse(args);
        const result = (await def.handler(ctx, parsedArgs)) as Record<string, unknown>;
        const headers: Record<string, string> = {};
        if (result && typeof result["__setCookie"] === "string") {
          headers["set-cookie"] = result["__setCookie"];
        }
        return json(def.response.parse(result), 200, headers);
      } catch (err) {
        (() => { const status = errStatus(err); if (status === 500) console.error("action_failed", err instanceof Error ? (err.stack ?? err.message) : String(err)); return json({ error: status === 500 ? "Something went wrong. Please try again." : errMessage(err) }, status); })()
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/blobs/")) {
      const user = await authenticate(platform, request.headers.get("cookie") ?? "");
      if (!user) return new Response("Sign in required.", { status: 401 });
      const blob = await readWorkerBlob(env, decodeURIComponent(url.pathname.slice("/blobs/".length)));
      if (!blob) return new Response("Not found.", { status: 404 });
      return new Response(blob.bytes as unknown as BodyInit, {
        headers: { "content-type": blob.contentType, "cache-control": "no-store" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
