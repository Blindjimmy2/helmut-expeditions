// Worker Ctx: Cloudflare implementation of the shared Ctx interface.
import { drizzle } from "drizzle-orm/d1";
import { braveSearch, completeWithModel } from "../shared/providers.ts";
import type { AuthUser } from "../shared/auth";
import type { Ctx } from "../shared/types";
import { recordUsage } from "../shared/usage.ts";
import { workerPlatform, type WorkerEnv } from "./platform.ts";

export async function readWorkerBlob(
  env: WorkerEnv,
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!key || key.includes("..")) return null;
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  return { bytes: new Uint8Array(await obj.arrayBuffer()), contentType: obj.httpMetadata?.contentType ?? "application/octet-stream" };
}

export function createWorkerCtx(
  env: WorkerEnv,
  user: AuthUser | null = null,
  req: Ctx["req"] = { ip: "unknown", userAgent: "", cookie: "" },
): Ctx {
  const platform = workerPlatform(env);
  return {
    platform,
    user,
    req,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db(): any {
      return drizzle(env.DB as never);
    },
    blobs: {
      async put(key, bytes, opts) {
        if (!key || key.includes("..")) {
          throw new Error("Invalid blob key.");
        }
        await env.FILES.put(key, bytes, { httpMetadata: { contentType: opts?.contentType ?? "application/octet-stream" } });
      },
      async getUrl(key) {
        return `/blobs/${key}`;
      },
      async delete(key) {
        await env.FILES.delete(key);
      },
    },
    inference: {
      complete: async (prompt, opts) => {
        const provider = platform.env.get("MODEL_PROVIDER") || "anthropic";
        const model = platform.env.get("MODEL_NAME");
        const started = Date.now();
        const out = await completeWithModel({
          provider: provider === "openai-compatible" ? "openai-compatible" : "anthropic",
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
