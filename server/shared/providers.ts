// Model + search providers (shared): pure fetch calls, either host.
// Callers pass credentials in and get back {value, usage}; recording the
// usage event is the caller's job (see shared/usage.ts).
import { z } from "zod";
import type { InferenceImage, WebResult } from "./types";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface ProviderCallArgs {
  provider: "anthropic" | "openai-compatible";
  model: string;
  apiKey: string;
  baseUrl?: string;
  prompt: string;
  system?: string;
  images?: InferenceImage[];
  timeoutSecs?: number;
  schema: z.ZodTypeAny;
}

export async function completeWithModel(
  args: ProviderCallArgs,
): Promise<{ value: unknown; usage: ModelUsage }> {
  if (!args.apiKey) {
    throw new Error("MODEL_API_KEY is not set — add it to the server environment to run transcription.");
  }
  if (args.provider === "openai-compatible") return completeOpenAICompatible(args);
  return completeAnthropic(args);
}

async function completeAnthropic(
  args: ProviderCallArgs,
): Promise<{ value: unknown; usage: ModelUsage }> {
  const model = args.model.trim() || "claude-sonnet-4-5";
  const jsonSchema = z.toJSONSchema(args.schema as z.ZodType) as Record<string, unknown>;
  const content: unknown[] = [];
  for (const img of args.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mimeType, data: img.dataBase64 },
    });
  }
  content.push({ type: "text", text: args.prompt });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: args.system,
      tools: [{ name: "result", description: "Return the result object.", input_schema: jsonSchema }],
      tool_choice: { type: "tool", name: "result" },
      messages: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout((args.timeoutSecs ?? 240) * 1000),
  });
  if (!res.ok) {
    throw new Error(`Model API error (anthropic ${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    content: { type: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const toolUse = body.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Model returned no structured result.");
  return {
    value: toolUse.input,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
      reasoningTokens: 0,
    },
  };
}

async function completeOpenAICompatible(
  args: ProviderCallArgs,
): Promise<{ value: unknown; usage: ModelUsage }> {
  const baseUrl = (args.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  if (!args.model.trim()) throw new Error("MODEL_NAME is not set for the openai-compatible provider.");
  const jsonSchema = z.toJSONSchema(args.schema as z.ZodType) as Record<string, unknown>;
  const userContent: unknown[] = [{ type: "text", text: args.prompt }];
  for (const img of args.images ?? []) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${img.mimeType};base64,${img.dataBase64}` },
    });
  }
  const messages: unknown[] = [];
  if (args.system) messages.push({ role: "system", content: args.system });
  messages.push({ role: "user", content: userContent });
  const postOnce = (responseFormat: unknown) =>
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${args.apiKey}`,
      },
      body: JSON.stringify({ model: args.model, messages, response_format: responseFormat }),
      signal: AbortSignal.timeout((args.timeoutSecs ?? 240) * 1000),
    });
  let res = await postOnce({
    type: "json_schema",
    json_schema: { name: "result", strict: false, schema: jsonSchema },
  });
  if (!res.ok) {
    const firstErr = await res.text();
    res = await postOnce({ type: "json_object" });
    if (!res.ok) {
      throw new Error(`Model API error (openai-compatible ${res.status}): ${firstErr}`);
    }
  }
  const body = (await res.json()) as {
    choices: { message: { content: string | null } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const text = body.choices[0]?.message?.content;
  if (!text) throw new Error("Model returned no content.");
  const reasoning = body.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    value: JSON.parse(text),
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: (body.usage?.completion_tokens ?? 0) - reasoning,
      reasoningTokens: reasoning,
    },
  };
}

// Brave wraps match terms in <strong> tags and leaves HTML entities in
// descriptions. Strip markup and decode entities so stored snippets are
// plain text; clients escape on render.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
};

export function cleanSearchText(s: string): string {
  let t = s ?? "";
  t = t.replace(
    /<\/?(strong|em|b|i|u|a|span|div|p|br|ul|ol|li|h[1-6]|code|blockquote)\b[^>]*>/gi,
    ""
  );
  for (let i = 0; i < 2; i++) {
    t = t.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
      if (e[0] === "#") {
        const cp =
          e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff
          ? String.fromCodePoint(cp)
          : m;
      }
      return NAMED_ENTITIES[e] ?? m;
    });
  }
  return t.replace(/\s+/g, " ").trim();
}

export async function braveSearch(apiKey: string, query: string): Promise<WebResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=9`;
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Search API error (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    web?: {
      results?: {
        title?: string;
        url?: string;
        description?: string;
        meta_url?: { hostname?: string };
      }[];
    };
  };
  return (body.web?.results ?? []).map((r) => ({
    title: cleanSearchText(r.title ?? "(untitled)"),
    url: r.url ?? null,
    source: r.meta_url?.hostname ?? null,
    snippet: r.description == null ? null : cleanSearchText(r.description),
  }));
}
