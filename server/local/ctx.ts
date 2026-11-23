// Local Ctx: localhost implementation of the shared Ctx interface.
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { braveSearch, completeWithModel } from "../shared/providers.ts";
import type { AuthUser } from "../shared/auth";
import type { Ctx } from "../shared/types";
import { recordUsage } from "../shared/usage.ts";
import { APP_ROOT, sqlite } from "./db.ts";
import { localPlatform } from "./platform.ts";

export { APP_ROOT, sqlite };

type ProxyMethod = "run" | "all" | "values" | "get";

async function proxyCallback(
  sql: string,
  params: unknown[],
  method: ProxyMethod,
): Promise<{ rows: unknown[][] | Record<string, unknown>[] }> {
  const stmt = sqlite.prepare(sql);
  const args = params as Parameters<typeof stmt.all>;
  if (method === "run") {
    stmt.run(...args);
    return { rows: [] };
  }
  // sqlite-proxy maps columns itself: rows must be value arrays in
  // SELECT order (object insertion order matches it).
  if (method === "get") {
    const row = stmt.get(...args) as Record<string, unknown> | undefined;
    return { rows: row ? [Object.values(row)] : [] };
  }
  const all = stmt.all(...args) as Record<string, unknown>[];
  return { rows: all.map((r) => Object.values(r)) };
}

function contentTypeFor(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

export async function readBlob(
  key: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!key || key.includes("..")) return null;
  const row = sqlite
    .prepare("SELECT bytes, content_type FROM blobs WHERE key = ?")
    .get(key) as { bytes: Uint8Array; content_type: string } | undefined;
  if (!row) return null;
  return { bytes: Buffer.from(row.bytes), contentType: row.content_type };
}

export function createCtx(
  user: AuthUser | null = null,
  req: Ctx["req"] = { ip: "local", userAgent: "", cookie: "" },
): Ctx {
  const platform = localPlatform();
  return {
    platform,
    user,
    req,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db(): any {
      return drizzle(proxyCallback, {});
    },
    blobs: {
      async put(key, bytes, opts) {
        if (!key || key.includes("..")) {
          throw new Error("Invalid blob key.");
        }
        sqlite
          .prepare("INSERT OR REPLACE INTO blobs (key, bytes, content_type) VALUES (?, ?, ?)")
          .run(key, Buffer.from(bytes), opts?.contentType ?? contentTypeFor(key));
      },
      async getUrl(key) {
        return `/blobs/${key}`;
      },
      async delete(key) {
        sqlite.prepare("DELETE FROM blobs WHERE key = ?").run(key);
      },
    },
    inference: {
      complete: async (prompt, opts) => {
        const provider = platform.env.get("MODEL_PROVIDER") || "anthropic";
        const model = platform.env.get("MODEL_NAME");
        const started = Date.now();
        const out = await completeWithModel({
          provider: (provider === "openai-compatible" ? "openai-compatible" : "anthropic"),
          model,
          apiKey: platform.env.get("MODEL_API_KEY"),
          baseUrl: platform.env.get("MODEL_BASE_URL") || undefined,
          prompt,
          system: opts.system,
          images: opts.images,
          timeoutSecs: opts.timeout_secs,
          schema: opts.schema,
        });
        if (opts.usage) {
          const id = await recordUsage(platform.raw, {
            userId: opts.usage.userId,
            runId: opts.usage.runId,
            action: opts.usage.action,
            provider,
            model,
            inputTokens: out.usage.inputTokens,
            outputTokens: out.usage.outputTokens,
            reasoningTokens: out.usage.reasoningTokens,
            latencyMs: Date.now() - started,
          });
          opts.usage.onEventId?.(id);
        }
        return opts.schema.parse(out.value);
      },
    },
    tool: {
      web_search: async (query, meta) => {
        const key = platform.env.get("SEARCH_API_KEY");
        if (!key) return { content: { results: [], unavailable: true } };
        const started = Date.now();
        const results = await braveSearch(key, query);
        await recordUsage(platform.raw, {
          userId: meta?.userId,
          runId: meta?.runId,
          action: "search",
          provider: "brave",
          latencyMs: Date.now() - started,
        });
        return { content: { results, unavailable: false } };
      },
    },
    invalidateQueries() {},
  };
}
