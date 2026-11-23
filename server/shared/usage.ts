// Usage logging (shared): every model + search call, either host.
import type { RawDb } from "./platform";

export async function recordUsage(
  raw: RawDb,
  e: {
    userId?: string | null;
    runId?: number | null;
    action: "transcribe" | "compare" | "ask" | "search";
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    latencyMs?: number;
  },
): Promise<number> {
  const res = await raw
    .prepare(
      `INSERT INTO usage_events
      (user_id, run_id, action, provider, model, input_tokens, output_tokens, reasoning_tokens, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      e.userId ?? null,
      e.runId ?? null,
      e.action,
      e.provider ?? "",
      e.model ?? "",
      e.inputTokens ?? 0,
      e.outputTokens ?? 0,
      e.reasoningTokens ?? 0,
      e.latencyMs ?? 0,
      Date.now(),
    );
  return Number(res.lastInsertRowid);
}
